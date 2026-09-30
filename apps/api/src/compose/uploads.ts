// Composer attachments, server side (PST-T-15.10, PST-REQ-195, PST-ADR-013): "When the account
// attaches files in the composer, the webmail shall upload each file to encrypted storage, keep the
// attachments with the draft, and send them as MIME attachments of the message, refusing any
// attachment set larger than the configured limit with a clear error."
//
//   POST   /api/compose/uploads      the file is the raw request body (not multipart/form-data, not
//                                    JSON): Content-Type is the file's type, X-Postroom-Filename its
//                                    percent-encoded UTF-8 name. Streamed into the blob store
//                                    through a counting Transform; past the per-file limit it is
//                                    413 attachment_too_large and nothing is stored (put() never
//                                    reaches its commit, and removes its temp file).
//   DELETE /api/compose/uploads/:id  own upload only; the row goes and its blob reference is released.
//   GET    /api/compose/limits       { maxAttachmentBytes, maxAttachments } from
//                                    COMPOSE_MAX_ATTACHMENT_BYTES / COMPOSE_MAX_ATTACHMENTS.
//
// Every compose_upload row holds exactly one reference on its blob. A send, a hold and a draft save
// build their own message blob with the file's bytes inside it (message.ts), so an upload can be
// deleted — by the user, or by the worker's sweep (apps/worker/src/sweep/upload-sweep.ts) once it is
// untouched for 24 h — without losing any mail. Reopening a draft re-registers its attachment parts
// as uploads (registerDraftAttachments), reusing one the account already has for the same bytes and
// name.
//
// One crash window is accepted: the upload's put() commits the blob row (one reference) before the
// compose_upload row is inserted, because holding a transaction open for the whole of a slow upload
// would pin a pooled connection per upload. A failed insert releases the reference again; only a
// process crash between the two leaves one orphaned reference — an unreadable-to-anyone encrypted
// blob kept alive, never lost or leaked mail.
import { once } from 'node:events';
import { PassThrough, Transform, type TransformCallback } from 'node:stream';
import { audited, getAuditContext, recordAudit, type RequestContext } from '@postroom/audit';
import type { BlobStore } from '@postroom/blobstore';
import { envInt } from '@postroom/daemon';
import type { Db } from '@postroom/db';
import { parseMessage, type PartInfo } from '@postroom/mime';
import type { SubmissionStorage } from '@postroom/submission';
import type { Request, Response, Router } from 'express';
import { currentSession, handle } from '../auth/middleware.js';
import { sanitizeContentType, type OutgoingAttachment } from './message.js';
import { UploadParams, type ComposeLimitsJson, type ComposeUploadJson } from './schemas.js';

/** 20 MiB: the total of all attachments in one message, before encoding — and so also one file's cap. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENTS = 20;
/** Filenames longer than this (in characters) are refused. */
export const MAX_FILENAME_CHARS = 255;

const TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;

export interface ComposeLimits {
  readonly maxAttachmentBytes: number;
  readonly maxAttachments: number;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv): ComposeLimits {
  return {
    maxAttachmentBytes: envInt(env, 'COMPOSE_MAX_ATTACHMENT_BYTES', DEFAULT_MAX_ATTACHMENT_BYTES),
    maxAttachments: envInt(env, 'COMPOSE_MAX_ATTACHMENTS', DEFAULT_MAX_ATTACHMENTS),
  };
}

/** A refusal about attachments: status, stable code, a sentence. index.ts answers it like its own. */
export class AttachmentRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What the counting Transform throws once more bytes than the limit have gone through it. */
export class AttachmentTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`The file is larger than ${String(limit)} bytes.`);
  }
}

/**
 * A pass-through that counts the bytes it forwards and errors the moment they exceed `limit` —
 * before the offending chunk reaches the encryptor, so nothing past the limit is ever written.
 */
export function countingTransform(limit: number): Transform & { readonly seen: () => number } {
  let seen = 0;
  const t = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
      seen += chunk.length;
      if (seen > limit) {
        callback(new AttachmentTooLarge(limit));
        return;
      }
      callback(null, chunk);
    },
  });
  return Object.assign(t, { seen: () => seen });
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The X-Postroom-Filename header as a filename: percent-decoded as UTF-8, any path dropped (only
 * what follows the last `/` or `\`), and refused (null) when it cannot be decoded, is empty or only
 * whitespace, is `.` or `..`, contains a control character, or is longer than 255 characters.
 */
export function parseUploadFilename(header: string | undefined): string | null {
  if (header === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    return null; // malformed %-escapes or bytes that are not UTF-8
  }
  const cut = Math.max(decoded.lastIndexOf('/'), decoded.lastIndexOf('\\'));
  const name = decoded.slice(cut + 1);
  if (name.trim() === '' || name === '.' || name === '..') return null;
  if (CONTROL.test(name)) return null;
  if (Array.from(name).length > MAX_FILENAME_CHARS) return null;
  return name;
}

/**
 * A filename read back from a draft's MIME (any client may have written it): the same rules, but
 * repaired rather than refused — path dropped, controls removed, cut to 255 characters.
 */
export function repairFilename(name: string | null, fallback: string): string {
  if (name === null) return fallback;
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const clean = Array.from(name.slice(cut + 1).replace(new RegExp(CONTROL.source, 'g'), ''))
    .slice(0, MAX_FILENAME_CHARS)
    .join('');
  return clean.trim() === '' || clean === '.' || clean === '..' ? fallback : clean;
}

type UploadRow = { id: string; accountId: string; blobSha256: string; filename: string; contentType: string; size: number };

export function uploadJson(row: UploadRow): ComposeUploadJson {
  return { id: row.id, filename: row.filename, contentType: row.contentType, size: row.size };
}

/**
 * The upload ids a send or a draft save names, checked and in order: each must be the account's
 * own (404 not_found, naming the ids that are not), at most `maxAttachments` of them (400
 * too_many_attachments), their total at most `maxAttachmentBytes` (413 attachments_too_large).
 * Using them touches last_used_at, so the sweep leaves them alone. A repeated id counts once.
 */
export async function resolveAttachments(db: Db, accountId: string, ids: readonly string[] | undefined, limits: ComposeLimits, now: Date): Promise<UploadRow[]> {
  if (ids === undefined || ids.length === 0) return [];
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (unique.length > limits.maxAttachments) {
    throw new AttachmentRefusal(400, 'too_many_attachments', `At most ${String(limits.maxAttachments)} attachments per message; this one has ${String(unique.length)}.`);
  }
  const rows = await db.composeUpload.findMany({ where: { id: { in: unique }, accountId } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new AttachmentRefusal(404, 'not_found', `attachments: ${missing.join(', ')} ${missing.length === 1 ? 'is not one of your uploads' : 'are not your uploads'} (removed, or expired after 24 hours unused). Attach the file again.`);
  }
  const ordered = unique.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
  const total = ordered.reduce((n, r) => n + r.size, 0);
  if (total > limits.maxAttachmentBytes) {
    throw new AttachmentRefusal(413, 'attachments_too_large', `The attachments total ${String(total)} bytes; a message may carry at most ${String(limits.maxAttachmentBytes)} bytes of attachments.`);
  }
  await db.composeUpload.updateMany({ where: { id: { in: unique }, accountId }, data: { lastUsedAt: now } });
  return ordered;
}

/** Uploads as the builder's attachments: each opens its blob's plaintext stream when its part is written. */
export function outgoingAttachments(blobs: BlobStore, rows: readonly UploadRow[]): OutgoingAttachment[] {
  return rows.map((r) => ({ filename: r.filename, contentType: r.contentType, open: () => blobs.get(r.blobSha256) }));
}

/** An attachment leaf of a draft: a file, not the body text (and never inside a forwarded message). */
function isAttachmentLeaf(part: PartInfo): boolean {
  return part.kind === 'leaf' && (part.disposition === 'attachment' || part.filename !== null);
}

/**
 * GET /drafts/:id: each attachment part of the draft, decoded as it streams out of the parser and
 * into the blob store, registered as one of the account's uploads so the composer can send it
 * again by id. An upload the account already has with the same bytes and name is reused (the extra
 * reference the put took is released in the same transaction); a new one is audited. Parts inside
 * an encapsulated message/rfc822 are not the draft's own (a forward is represented by forwardOf).
 */
export async function registerDraftAttachments(input: {
  db: Db;
  blobs: BlobStore;
  accountId: string;
  draftId: string;
  source: AsyncIterable<Uint8Array>;
  context: RequestContext;
  now: Date;
}): Promise<ComposeUploadJson[]> {
  const { db, blobs, accountId } = input;
  const out: ComposeUploadJson[] = [];
  const insideMessage = new Set<string>();
  let current: { id: string; write: (chunk: Buffer) => Promise<void>; finish: () => Promise<ComposeUploadJson>; abort: (error: unknown) => Promise<void> } | null = null;

  const capture = (part: PartInfo, index: number): NonNullable<typeof current> => {
    const pt = new PassThrough();
    const filename = repairFilename(part.filename, `attachment-${String(index)}`);
    const contentType = sanitizeContentType(part.contentType);
    const done = db.$transaction(async (tx) => {
      const put = await blobs.put(pt, { tx });
      const existing = await tx.composeUpload.findFirst({ where: { accountId, blobSha256: put.sha256, filename }, orderBy: { createdAt: 'asc' } });
      if (existing !== null) {
        // The existing row already holds a reference; this put's is one too many.
        await blobs.release(put.sha256, tx);
        await tx.composeUpload.update({ where: { id: existing.id }, data: { lastUsedAt: input.now } });
        return uploadJson(existing);
      }
      const row = await tx.composeUpload.create({ data: { accountId, blobSha256: put.sha256, filename, contentType, size: put.size, lastUsedAt: input.now } });
      await recordAudit(tx, {
        actor: { kind: 'account', accountId },
        action: 'compose.upload.restore',
        entityType: 'compose_upload',
        entityId: row.id,
        before: null,
        after: { draftId: input.draftId, filename, contentType, size: put.size, blobSha256: put.sha256 },
        context: input.context,
      });
      return uploadJson(row);
    }, TX_OPTIONS);
    // Awaited in finish/abort; this keeps an early failure from being an unhandled rejection meanwhile.
    done.catch(() => undefined);
    return {
      id: part.id,
      write: async (chunk) => {
        if (!pt.write(chunk)) await Promise.race([once(pt, 'drain'), done]);
      },
      finish: async () => {
        pt.end();
        return done;
      },
      abort: async (error) => {
        pt.destroy(error instanceof Error ? error : new Error(String(error)));
        await done.catch(() => undefined);
      },
    };
  };

  try {
    for await (const event of parseMessage(input.source)) {
      if (event.type === 'headers') {
        const part = event.part;
        if (part.kind === 'message' || (part.parent !== null && insideMessage.has(part.parent))) {
          insideMessage.add(part.id);
          continue;
        }
        if (isAttachmentLeaf(part)) current = capture(part, out.length + 1);
      } else if (event.type === 'body' && current?.id === event.part.id) {
        await current.write(event.chunk);
      } else if (event.type === 'end-part' && current?.id === event.part.id) {
        out.push(await current.finish());
        current = null;
      }
    }
  } catch (error) {
    if (current !== null) await current.abort(error);
    throw error;
  }
  return out;
}

/** The raw body is never read: let it drain to nowhere, and say so to the client. */
function discard(req: Request, res: Response): void {
  req.resume();
  res.setHeader('Connection', 'close');
}

/**
 * The upload routes, on the compose router. `storageFor` answers 503 when no KEK is configured.
 * `now` is the runtime clock (tests move it).
 */
export function mountUploadRoutes(
  router: Router,
  opts: { db: Db; limits: ComposeLimits; now: () => Date; storageFor: (res: Response) => SubmissionStorage | null },
): void {
  const { db, limits } = opts;
  const tooLarge = (res: Response): void => {
    res.status(413).json({ error: 'attachment_too_large', message: `The file is larger than the ${String(limits.maxAttachmentBytes)}-byte limit for attachments.` });
  };

  router.get(
    '/limits',
    handle(async (_req, res) => {
      const json: ComposeLimitsJson = { maxAttachmentBytes: limits.maxAttachmentBytes, maxAttachments: limits.maxAttachments };
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(json);
      return Promise.resolve();
    }),
  );

  router.post(
    '/uploads',
    handle(async (req, res) => {
      const store = opts.storageFor(res);
      if (store === null) {
        req.resume(); // storageFor has answered 503 already
        return;
      }
      const me = currentSession(req);
      const filename = parseUploadFilename(req.get('x-postroom-filename'));
      if (filename === null) {
        discard(req, res);
        res.status(400).json({ error: 'invalid_filename', message: 'X-Postroom-Filename must be the percent-encoded UTF-8 file name: not empty, not . or .., no control characters, at most 255 characters.' });
        return;
      }
      const contentType = sanitizeContentType(req.get('content-type'));
      // A declared length already over the limit is refused before a byte is read.
      const declared = Number(req.get('content-length') ?? 'NaN');
      if (Number.isFinite(declared) && declared > limits.maxAttachmentBytes) {
        discard(req, res);
        tooLarge(res);
        return;
      }

      const counter = countingTransform(limits.maxAttachmentBytes);
      // put() only attaches its own listeners after an await, and bytes may already be flowing: an
      // error before then must not be an uncaught 'error' event. put() still sees it (the stream is
      // destroyed), and the catch below reads the cause from the count.
      counter.on('error', () => undefined);
      const aborted = (): void => {
        if (!req.complete) counter.destroy(new Error('the upload was aborted'));
      };
      req.once('error', (error) => counter.destroy(error));
      req.once('close', aborted);
      req.pipe(counter);
      let put: Awaited<ReturnType<BlobStore['put']>>;
      try {
        put = await store.blobs.put(counter);
      } catch (error) {
        req.unpipe(counter);
        if (error instanceof AttachmentTooLarge || counter.seen() > limits.maxAttachmentBytes) {
          // put() failed before its commit and removed its temp file: no row, no reference.
          discard(req, res);
          tooLarge(res);
          return;
        }
        if (res.destroyed || req.destroyed) return; // the client went away mid-upload
        throw error;
      } finally {
        req.off('close', aborted);
      }

      let row: UploadRow;
      try {
        row = await audited(db, { kind: 'account', accountId: me.accountId }, { action: 'compose.upload', entityType: 'compose_upload', context: getAuditContext(req) }, async (tx) => {
          const created = await tx.composeUpload.create({ data: { accountId: me.accountId, blobSha256: put.sha256, filename, contentType, size: put.size, lastUsedAt: opts.now() } });
          return { entityId: created.id, before: null, after: { filename, contentType, size: put.size, blobSha256: put.sha256 }, result: created };
        });
      } catch (error) {
        // No row holds the reference the put took: give it back.
        const released = await store.blobs.release(put.sha256).catch(() => null);
        if (released === null) process.stderr.write(`${JSON.stringify({ event: 'upload-release-failed', sha256: put.sha256 })}\n`);
        throw error;
      }
      res.status(201).json(uploadJson(row));
    }),
  );

  router.delete(
    '/uploads/:id',
    handle(async (req, res) => {
      const parsed = UploadParams.safeParse(req.params);
      if (!parsed.success) {
        res.status(404).json({ error: 'not_found', message: 'no such upload' });
        return;
      }
      const store = opts.storageFor(res);
      if (store === null) return;
      const me = currentSession(req);
      const toReap: string[] = [];
      try {
        await audited(db, { kind: 'account', accountId: me.accountId }, { action: 'compose.upload.delete', entityType: 'compose_upload', context: getAuditContext(req) }, async (tx) => {
          const row = await tx.composeUpload.findFirst({ where: { id: parsed.data.id, accountId: me.accountId } });
          if (row === null) throw new AttachmentRefusal(404, 'not_found', 'no such upload');
          await tx.composeUpload.delete({ where: { id: row.id } });
          const released = await store.blobs.release(row.blobSha256, tx);
          if (released.refcount === 0) toReap.push(row.blobSha256);
          return { entityId: row.id, before: { filename: row.filename, contentType: row.contentType, size: row.size, blobSha256: row.blobSha256 }, after: null, result: null };
        });
      } catch (error) {
        if (!(error instanceof AttachmentRefusal)) throw error;
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      // The file goes after the commit (the blob store's contract); gc() covers a crash here.
      for (const sha of toReap) await store.blobs.reap(sha).catch(() => undefined);
      res.status(204).end();
    }),
  );
}
