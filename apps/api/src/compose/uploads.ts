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
import { BlobNotFoundError, type BlobStore } from '@postroom/blobstore';
import { envInt } from '@postroom/daemon';
import type { Db } from '@postroom/db';
import { parseMessage, type PartInfo } from '@postroom/mime';
import type { SubmissionStorage } from '@postroom/submission';
import type { Request, Response, Router } from 'express';
import { currentSession, handle } from '../auth/middleware.js';
import { sanitizeContentType, type OutgoingAttachment } from './message.js';
import { UploadParams, type ComposeLimitsJson, type ComposeUploadJson } from './schemas.js';

/**
 * 17 MiB (17,825,792 bytes): the total of all attachments in one message, before encoding — and so
 * also one file's cap. Chosen so the encoded message stays under Gmail's 25 MB (25,000,000-byte)
 * acceptance limit: base64 is 4/3, so 17,825,792 → 23,767,723 characters, plus a CRLF every 76 →
 * × 78/76 ≈ 24,393,190 bytes, which leaves ~600 KB for the headers, the text and HTML body parts and
 * the MIME framing. (20 MiB would encode to ~28.7 MB and be refused.)
 */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 17 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENTS = 20;
/** Uploads an account may hold at once (not yet expired or removed), by count… */
export const DEFAULT_MAX_OUTSTANDING_UPLOADS = 100;
/** …and by bytes: five messages' worth, by default. */
export const DEFAULT_OUTSTANDING_BYTES_FACTOR = 5;
/** compose_upload.size (and blob.size) is a PostgreSQL integer. */
export const MAX_INT_COLUMN = 2 ** 31 - 1;
/** Filenames longer than this (in characters) are refused. */
export const MAX_FILENAME_CHARS = 255;

const TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;

export interface ComposeLimits {
  readonly maxAttachmentBytes: number;
  readonly maxAttachments: number;
  /** COMPOSE_MAX_OUTSTANDING_UPLOADS: live compose_upload rows per account. */
  readonly maxOutstandingUploads: number;
  /** COMPOSE_MAX_OUTSTANDING_BYTES: their total size. */
  readonly maxOutstandingBytes: number;
}

export function limitsFromEnv(env: NodeJS.ProcessEnv): ComposeLimits {
  const maxAttachmentBytes = envInt(env, 'COMPOSE_MAX_ATTACHMENT_BYTES', DEFAULT_MAX_ATTACHMENT_BYTES);
  return {
    maxAttachmentBytes,
    maxAttachments: envInt(env, 'COMPOSE_MAX_ATTACHMENTS', DEFAULT_MAX_ATTACHMENTS),
    maxOutstandingUploads: envInt(env, 'COMPOSE_MAX_OUTSTANDING_UPLOADS', DEFAULT_MAX_OUTSTANDING_UPLOADS),
    maxOutstandingBytes: envInt(env, 'COMPOSE_MAX_OUTSTANDING_BYTES', DEFAULT_OUTSTANDING_BYTES_FACTOR * maxAttachmentBytes),
  };
}

/** The largest single file: the per-message limit, and never more than the integer size column holds. */
export function perFileCap(limits: ComposeLimits): number {
  return Math.min(limits.maxAttachmentBytes, MAX_INT_COLUMN);
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
 * Bidirectional controls — LRE RLE PDF LRO RLO (U+202A–U+202E), LRI RLI FSI PDI (U+2066–U+2069), LRM
 * and RLM (U+200E, U+200F). They are stripped from every filename: "\u202Efdp.exe" would render as
 * "exe.pdf" and pass an executable off as a document.
 */
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g;

/** A filename with its bidirectional controls removed. */
export function stripBidi(name: string): string {
  return name.replace(BIDI, '');
}

/**
 * The X-Postroom-Filename header as a filename: percent-decoded as UTF-8, any path dropped (only
 * what follows the last `/` or `\`), bidirectional controls stripped, and refused (null) when it
 * cannot be decoded, is empty or only whitespace, is `.` or `..`, contains a control character, or
 * is longer than 255 characters.
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
  const name = stripBidi(decoded.slice(cut + 1));
  if (name.trim() === '' || name === '.' || name === '..') return null;
  if (CONTROL.test(name)) return null;
  if (Array.from(name).length > MAX_FILENAME_CHARS) return null;
  return name;
}

/**
 * A filename read back from a draft's MIME (any client may have written it): the same rules, but
 * repaired rather than refused — path dropped, controls and bidirectional controls removed, cut to
 * 255 characters.
 */
export function repairFilename(name: string | null, fallback: string): string {
  if (name === null) return fallback;
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const clean = Array.from(stripBidi(name.slice(cut + 1)).replace(new RegExp(CONTROL.source, 'g'), ''))
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
 * Using them touches last_used_at, so the sweep leaves them alone. A repeated id attaches the file
 * again — a draft may hold the same file twice, and reopening it names that upload twice — and
 * every occurrence counts toward both limits.
 */
export async function resolveAttachments(db: Db, accountId: string, ids: readonly string[] | undefined, limits: ComposeLimits, now: Date): Promise<UploadRow[]> {
  if (ids === undefined || ids.length === 0) return [];
  const wanted = ids.map((id) => id.toLowerCase());
  const unique = [...new Set(wanted)];
  if (wanted.length > limits.maxAttachments) {
    throw new AttachmentRefusal(400, 'too_many_attachments', `At most ${String(limits.maxAttachments)} attachments per message; this one has ${String(wanted.length)}.`);
  }
  const rows = await db.composeUpload.findMany({ where: { id: { in: unique }, accountId } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new AttachmentRefusal(404, 'not_found', `attachments: ${missing.join(', ')} ${missing.length === 1 ? 'is not one of your uploads' : 'are not your uploads'} (removed, or expired after 24 hours unused). Attach the file again.`);
  }
  const ordered = wanted.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
  const total = ordered.reduce((n, r) => n + r.size, 0);
  if (total > limits.maxAttachmentBytes) {
    throw new AttachmentRefusal(413, 'attachments_too_large', `The attachments total ${String(total)} bytes; a message may carry at most ${String(limits.maxAttachmentBytes)} bytes of attachments.`);
  }
  await db.composeUpload.updateMany({ where: { id: { in: unique }, accountId }, data: { lastUsedAt: now } });
  return ordered;
}

/** The refusal when an upload's bytes vanished between the check and the build. */
export function attachmentGone(filename: string): AttachmentRefusal {
  return new AttachmentRefusal(409, 'attachment_gone', `The attachment "${filename}" was removed (or expired) while the message was being built. Nothing was sent and nothing was saved; attach the file again.`);
}

/**
 * Uploads as the builder's attachments: each opens its blob's plaintext stream when its part is
 * written. A DELETE or the sweep can release the upload after resolveAttachments checked it; the
 * blob's row is then gone and the open fails with BlobNotFoundError, which is answered as 409
 * attachment_gone (the error travels up through the build's stream to the route) — never a 500,
 * and never a message sent without the file.
 */
export function outgoingAttachments(blobs: BlobStore, rows: readonly UploadRow[]): OutgoingAttachment[] {
  return rows.map((r) => ({
    filename: r.filename,
    contentType: r.contentType,
    open: async () => {
      try {
        return await blobs.get(r.blobSha256);
      } catch (error) {
        if (error instanceof BlobNotFoundError) throw attachmentGone(r.filename);
        throw error;
      }
    },
  }));
}

/** An attachment leaf of a draft: a file, not the body text (and never inside a forwarded message). */
function isAttachmentLeaf(part: PartInfo): boolean {
  return part.kind === 'leaf' && (part.disposition === 'attachment' || part.filename !== null);
}

/** A draft attachment part that was not registered as an upload, and why. */
export interface OmittedAttachment {
  filename: string;
  /** Decoded bytes. */
  size: number;
  /** too_large: over the per-file limit; too_many: past the most attachments a message may carry. */
  reason: 'too_large' | 'too_many';
}

/**
 * GET /drafts/:id: each attachment part of the draft, decoded as it streams out of the parser and
 * into the blob store, registered as one of the account's uploads so the composer can send it
 * again by id. An upload the account already has with the same bytes and name is reused (the extra
 * reference the put took is released in the same transaction); a new one is audited. Parts inside
 * an encapsulated message/rfc822 are not the draft's own (a forward is represented by forwardOf).
 *
 * A draft is mail — any IMAP client may have saved it — so its parts are not refused, but only
 * what a send could carry is registered: a part larger than the per-file limit (or than the
 * integer size column) is abandoned mid-stream, its transaction rolled back so nothing is stored,
 * and so is every part past the most attachments a message may carry. Those come back in
 * `omitted`, so the composer can say the draft holds a file it cannot send on. The per-account
 * outstanding-upload quota does not apply here: these are files the account already keeps in mail.
 */
export async function registerDraftAttachments(input: {
  db: Db;
  blobs: BlobStore;
  accountId: string;
  draftId: string;
  source: AsyncIterable<Uint8Array>;
  context: RequestContext;
  now: Date;
  limits: ComposeLimits;
}): Promise<{ attachments: ComposeUploadJson[]; omitted: OmittedAttachment[] }> {
  const { db, blobs, accountId } = input;
  const cap = perFileCap(input.limits);
  const out: ComposeUploadJson[] = [];
  const omitted: OmittedAttachment[] = [];
  const insideMessage = new Set<string>();
  let parts = 0;

  interface Capture {
    id: string;
    filename: string;
    size: number;
    /** Why it is being skipped (its bytes are only counted); null while it is being stored. */
    skip: OmittedAttachment['reason'] | null;
    write: (chunk: Buffer) => Promise<void>;
    finish: () => Promise<ComposeUploadJson>;
    abort: (error: unknown) => Promise<void>;
  }
  let current: Capture | null = null;

  const skipping = (part: PartInfo, filename: string, reason: OmittedAttachment['reason']): Capture => ({
    id: part.id,
    filename,
    size: 0,
    skip: reason,
    write: () => Promise.resolve(),
    finish: () => Promise.reject(new Error('a skipped part has no upload')),
    abort: () => Promise.resolve(),
  });

  const capture = (part: PartInfo, filename: string): Capture => {
    const pt = new PassThrough();
    // put() attaches its listeners only after an await; a part abandoned before then (too large in
    // its first chunk) must not be an uncaught 'error' event. put() still sees the destroyed stream.
    pt.on('error', () => undefined);
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
    const c: Capture = {
      id: part.id,
      filename,
      size: 0,
      skip: null,
      write: async (chunk) => {
        c.size += chunk.length;
        if (c.skip !== null) return;
        if (c.size > cap) {
          // Too large to carry on: abandon the put (its transaction rolls back, its temp file goes)
          // and only count the rest.
          c.skip = 'too_large';
          pt.destroy(new AttachmentTooLarge(cap));
          await done.catch(() => undefined);
          return;
        }
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
    return c;
  };

  try {
    for await (const event of parseMessage(input.source)) {
      if (event.type === 'headers') {
        const part = event.part;
        if (part.kind === 'message' || (part.parent !== null && insideMessage.has(part.parent))) {
          insideMessage.add(part.id);
          continue;
        }
        if (!isAttachmentLeaf(part)) continue;
        parts += 1;
        const filename = repairFilename(part.filename, `attachment-${String(parts)}`);
        current = out.length >= input.limits.maxAttachments ? skipping(part, filename, 'too_many') : capture(part, filename);
      } else if (event.type === 'body' && current?.id === event.part.id) {
        if (current.skip !== null) current.size += event.chunk.length;
        else await current.write(event.chunk);
      } else if (event.type === 'end-part' && current?.id === event.part.id) {
        if (current.skip === null) out.push(await current.finish());
        else omitted.push({ filename: current.filename, size: current.size, reason: current.skip });
        current = null;
      }
    }
  } catch (error) {
    if (current !== null) await current.abort(error);
    throw error;
  }
  return { attachments: out, omitted };
}

type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

/** The account's live uploads: how many, and their total bytes. */
async function outstanding(db: Db | Tx, accountId: string): Promise<{ count: number; bytes: number }> {
  const agg = await db.composeUpload.aggregate({ where: { accountId }, _count: { _all: true }, _sum: { size: true } });
  return { count: agg._count._all, bytes: agg._sum.size ?? 0 };
}

/** 413 upload_quota_exceeded when one more upload of `adding` bytes would pass either quota. */
function quotaRefusal(held: { count: number; bytes: number }, adding: number, limits: ComposeLimits): AttachmentRefusal | null {
  if (held.count + 1 > limits.maxOutstandingUploads || held.bytes + adding > limits.maxOutstandingBytes) {
    return new AttachmentRefusal(
      413,
      'upload_quota_exceeded',
      `You have ${String(held.count)} attachments (${String(held.bytes)} bytes) uploaded and not yet sent; the most you can hold is ${String(limits.maxOutstandingUploads)} files or ${String(limits.maxOutstandingBytes)} bytes. Remove attachments you no longer need, or send the messages they belong to, first.`,
    );
  }
  return null;
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
      if (Number.isFinite(declared) && declared > perFileCap(limits)) {
        discard(req, res);
        tooLarge(res);
        return;
      }
      // The account's outstanding uploads, before a byte is read too (checked again, under a lock,
      // once the file is stored).
      const quota = quotaRefusal(await outstanding(db, me.accountId), Number.isFinite(declared) ? declared : 0, limits);
      if (quota !== null) {
        discard(req, res);
        res.status(quota.status).json({ error: quota.code, message: quota.message });
        return;
      }

      const counter = countingTransform(perFileCap(limits));
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
        if (error instanceof AttachmentTooLarge || counter.seen() > perFileCap(limits)) {
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
          // Serialise this account's uploads for the quota check, so two at once cannot both fit.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-compose-upload:' + me.accountId}, 0))`;
          const over = quotaRefusal(await outstanding(tx, me.accountId), put.size, limits);
          if (over !== null) throw over;
          const created = await tx.composeUpload.create({ data: { accountId: me.accountId, blobSha256: put.sha256, filename, contentType, size: put.size, lastUsedAt: opts.now() } });
          return { entityId: created.id, before: null, after: { filename, contentType, size: put.size, blobSha256: put.sha256 }, result: created };
        });
      } catch (error) {
        // No row holds the reference the put took: give it back.
        const released = await store.blobs.release(put.sha256).catch(() => null);
        if (released === null) process.stderr.write(`${JSON.stringify({ event: 'upload-release-failed', sha256: put.sha256 })}\n`);
        if (!(error instanceof AttachmentRefusal)) throw error;
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
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
          // Conditional: a concurrent DELETE of the same upload blocks on the row lock here and then
          // deletes nothing — 404, and its reference is never released twice.
          const gone = await tx.composeUpload.deleteMany({ where: { id: row.id, accountId: me.accountId } });
          if (gone.count === 0) throw new AttachmentRefusal(404, 'not_found', 'no such upload');
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
