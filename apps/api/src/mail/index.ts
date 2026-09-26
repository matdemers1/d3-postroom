// Mailboxes, messages, threads, search and the SSE event stream over HTTP (PST-T-3.9). Mounted by
// app.ts at /api behind a session. Every request is validated by the zod schemas in schemas.ts —
// the same objects the OpenAPI document is generated from (PST-REQ-085).
//
// Isolation: every lookup is scoped to the session's account, and anything else answers 404.
// Concurrency: GET /api/messages/:id carries ETag "<modseq>"; PATCH needs If-Match (428 without,
// 412 when stale). Every PATCH is one audited transaction that also pg_notifies the mailboxes it
// touched, so other tabs (and IMAP IDLE) see it.
import { pipeline } from 'node:stream/promises';
import { audited, getAuditContext } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { collectMessage, decodeEncodedWords, parseMessage } from '@postroom/mime';
import { parseQuery, searchMessages, parseCursor } from '@postroom/search';
import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import { mintRenderUrl, usercontentConfig } from '../usercontent/index.js';
import { sanitizeHtml } from '../usercontent/sanitize.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { hubFor, streamEvents } from './events.js';
import {
  AttachmentParams,
  IdParams,
  MessageListQuery,
  MessagePatch,
  RenderQuery,
  SearchQuery,
  type MessageBodyJson,
  type RenderTicketJson,
  type SearchResponseJson,
  type SearchResultJson,
  type ThreadDetailJson,
} from './schemas.js';
import { detailJson, findOwnMessage, findOwnThread, listMailboxes, listMessages, ownMailbox, PreconditionFailed, summaryJson, updateMessage } from './store.js';

export const DEFAULT_BLOB_ROOT = '/var/lib/postroom/blobs';

/** Parses `value` with `schema`, or answers 400 and returns null. */
function parse<S extends z.ZodType>(schema: S, value: unknown, res: Response): z.output<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  res.status(400).json({ error: 'invalid_request', message: result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
  return null;
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

/** `"12"`, `W/"12"` or `*` → 12n / '*'; anything else → null. */
export function parseIfMatch(header: string | undefined): bigint | '*' | null {
  if (header === undefined) return null;
  const value = header.trim();
  if (value === '*') return '*';
  const m = /^(?:W\/)?"(\d{1,20})"$/.exec(value);
  return m?.[1] === undefined ? null : BigInt(m[1]);
}

export const etagOf = (modseq: bigint | string): string => `"${modseq.toString()}"`;

/** RFC 6266: an ASCII fallback plus the UTF-8 filename*. Never lets a quote or CR/LF through. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 200) || 'attachment';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export function mailRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  let blobs: BlobStore | null = null;
  const blobStore = (res: Response): BlobStore | null => {
    if (blobs !== null) return blobs;
    if (rt.kek === null) {
      res.status(503).json({ error: 'blobstore_not_configured', message: 'POSTROOM_KEK is not set' });
      return null;
    }
    const root = deps.env['BLOB_ROOT']?.trim() ?? '';
    blobs = createBlobStore({ root: root === '' ? DEFAULT_BLOB_ROOT : root, db, kek: rt.kek });
    return blobs;
  };

  const ownMessage = async (req: Request, res: Response) => {
    const params = parse(IdParams, req.params, res);
    if (params === null) return null;
    const message = await findOwnMessage(db, currentSession(req).accountId, params.id);
    if (message === null) notFound(res);
    return message;
  };

  // --- Mailboxes -------------------------------------------------------------------------------

  router.get(
    '/mailboxes',
    handle(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ mailboxes: await listMailboxes(db, currentSession(req).accountId) });
    }),
  );

  router.get(
    '/mailboxes/:id/messages',
    handle(async (req, res) => {
      const params = parse(IdParams, req.params, res);
      if (params === null) return;
      const query = parse(MessageListQuery, req.query, res);
      if (query === null) return;
      if ((await ownMailbox(db, currentSession(req).accountId, params.id)) === null) {
        notFound(res);
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(await listMessages(db, params.id, { cursor: query.cursor === undefined ? undefined : Number(query.cursor), limit: query.limit }));
    }),
  );

  // --- Messages --------------------------------------------------------------------------------

  router.get(
    '/messages/:id',
    handle(async (req, res) => {
      const message = await ownMessage(req, res);
      if (message === null) return;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('ETag', etagOf(message.modseq));
      res.json(detailJson(message));
    }),
  );

  router.patch(
    '/messages/:id',
    handle(async (req, res) => {
      const params = parse(IdParams, req.params, res);
      if (params === null) return;
      const body = parse(MessagePatch, req.body, res);
      if (body === null) return;
      const ifMatch = parseIfMatch(req.get('if-match'));
      if (ifMatch === null) {
        res.status(428).json({ error: 'precondition_required', message: 'send If-Match with the ETag of GET /api/messages/:id' });
        return;
      }
      const me = currentSession(req);
      if (body.mailboxId !== undefined && (await ownMailbox(db, me.accountId, body.mailboxId)) === null) {
        notFound(res);
        return;
      }
      const moving = body.mailboxId !== undefined;
      let result;
      try {
        result = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: moving ? 'message.move' : 'message.flags', entityType: 'message', context: getAuditContext(req) },
          async (tx) => {
            const change = await updateMessage(tx, {
              accountId: me.accountId,
              messageId: params.id,
              ifMatch,
              add: body.flags?.add ?? [],
              remove: body.flags?.remove ?? [],
              moveTo: body.mailboxId,
            });
            if (change === null) throw new NotFoundSignal();
            return { entityId: change.after.id, before: change.before, after: change.after, result: change.after };
          },
        );
      } catch (error) {
        if (error instanceof NotFoundSignal) {
          notFound(res);
          return;
        }
        if (error instanceof PreconditionFailed) {
          res.setHeader('ETag', etagOf(error.current));
          res.status(412).json({ error: 'precondition_failed', message: 'the message changed; GET it again' });
          return;
        }
        throw error;
      }
      const message = await findOwnMessage(db, me.accountId, result.id);
      if (message === null) {
        notFound(res);
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('ETag', etagOf(message.modseq));
      res.json(detailJson(message));
    }),
  );

  router.get(
    '/messages/:id/raw',
    handle(async (req, res) => {
      const message = await ownMessage(req, res);
      if (message === null) return;
      const store = blobStore(res);
      if (store === null) return;
      const stream = await store.get(message.blobSha256);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', attachmentDisposition(`${message.id}.eml`));
      res.setHeader('Content-Length', String(message.size));
      res.setHeader('Cache-Control', 'private, no-store');
      await pipeline(stream, res);
    }),
  );

  router.get(
    '/messages/:id/body',
    handle(async (req, res) => {
      const message = await ownMessage(req, res);
      if (message === null) return;
      const store = blobStore(res);
      if (store === null) return;
      const summary = await collectMessage(await store.get(message.blobSha256));
      const body: MessageBodyJson = {
        id: message.id,
        headers: summary.headers.fields.map((f) => ({ name: f.name, value: decodeEncodedWords(f.value) })),
        text: summary.text?.text ?? null,
        textTruncated: summary.text?.truncated ?? false,
        html: summary.html?.text ?? null,
        htmlTruncated: summary.html?.truncated ?? false,
        attachments: summary.attachments.map((a) => ({
          partId: a.partId,
          contentType: a.contentType,
          filename: a.filename,
          disposition: a.disposition,
          contentId: a.contentId,
          size: a.size,
          sha256: a.sha256,
          inMessage: a.inMessage,
        })),
        warnings: summary.warnings.map((w) => ({ code: w.code, message: w.message, partId: w.partId })),
      };
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(body);
    }),
  );

  // A render ticket for the usercontent origin (PST-T-3.12): a short-lived capability URL for this
  // one message of the caller's, because that origin has no session cookie. A read — nothing stored.
  router.get(
    '/messages/:id/render',
    handle(async (req, res) => {
      const query = parse(RenderQuery, req.query, res);
      if (query === null) return;
      const config = usercontentConfig(deps);
      if (config === null) {
        res.status(503).json({ error: 'usercontent_not_configured', message: 'USERCONTENT_ORIGIN is not set' });
        return;
      }
      const message = await ownMessage(req, res);
      if (message === null) return;
      const store = blobStore(res);
      if (store === null) return;
      const summary = await collectMessage(await store.get(message.blobSha256));
      const remoteImages = summary.html === null ? 0 : sanitizeHtml(summary.html.text).remoteImages;
      const me = currentSession(req);
      const images = query.images === '1';
      const ticket: RenderTicketJson = {
        ...mintRenderUrl(config, { messageId: message.id, accountId: me.accountId, sessionId: me.sessionId, images }, rt.now()),
        images,
        remoteImages,
      };
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(ticket);
    }),
  );

  router.get(
    '/messages/:id/attachments/:partId',
    handle(async (req, res) => {
      const params = parse(AttachmentParams, req.params, res);
      if (params === null) return;
      const message = await findOwnMessage(db, currentSession(req).accountId, params.id);
      if (message === null) {
        notFound(res);
        return;
      }
      const store = blobStore(res);
      if (store === null) return;
      let started = false;
      for await (const event of parseMessage(await store.get(message.blobSha256))) {
        if (res.destroyed) return;
        if (event.type === 'headers' && event.part.id === params.partId) {
          if (event.part.kind !== 'leaf') break;
          // Always a download, never rendered on this origin: octet-stream + attachment + sandbox.
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', attachmentDisposition(event.part.filename ?? `part-${params.partId}`));
          res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
          res.setHeader('X-Postroom-Content-Type', event.part.contentType);
          res.setHeader('Cache-Control', 'private, no-store');
          res.status(200);
          started = true;
        } else if (started && event.type === 'body' && event.part.id === params.partId) {
          if (!res.write(event.chunk)) {
            await new Promise<void>((resolve) => {
              const done = (): void => {
                res.off('drain', done);
                res.off('close', done);
                resolve();
              };
              res.on('drain', done);
              res.on('close', done);
            });
          }
        } else if (started && event.type === 'end-part' && event.part.id === params.partId) {
          break;
        }
      }
      if (started) res.end();
      else notFound(res);
    }),
  );

  // --- Threads ---------------------------------------------------------------------------------

  router.get(
    '/threads/:id',
    handle(async (req, res) => {
      const params = parse(IdParams, req.params, res);
      if (params === null) return;
      const found = await findOwnThread(db, currentSession(req).accountId, params.id);
      if (found === null) {
        notFound(res);
        return;
      }
      const body: ThreadDetailJson = {
        id: found.thread.id,
        subject: found.thread.subject,
        messageCount: found.thread.messageCount,
        lastMessageAt: found.thread.lastMessageAt.toISOString(),
        messages: found.messages.map(summaryJson),
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    }),
  );

  // --- Search ----------------------------------------------------------------------------------

  router.get(
    '/search',
    handle(async (req, res) => {
      const query = parse(SearchQuery, req.query, res);
      if (query === null) return;
      const me = currentSession(req);
      if (query.mailboxId !== undefined && (await ownMailbox(db, me.accountId, query.mailboxId)) === null) {
        notFound(res);
        return;
      }
      const { ast, warnings } = parseQuery(query.q);
      if (query.cursor !== undefined && parseCursor(query.cursor) === null) {
        res.status(400).json({ error: 'invalid_cursor' });
        return;
      }
      const rows = await searchMessages(db, ast, {
        accountId: me.accountId,
        limit: query.limit + 1,
        ...(query.mailboxId === undefined ? {} : { mailboxId: query.mailboxId }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      const page = rows.slice(0, query.limit);
      const froms = await db.message.findMany({ where: { id: { in: page.map((r) => r.messageId) } }, select: { id: true, fromAddress: true } });
      const fromById = new Map(froms.map((m) => [m.id, m.fromAddress]));
      const results: SearchResultJson[] = page.map((r) => ({
        messageId: r.messageId,
        mailboxId: r.mailboxId,
        uid: r.uid,
        subject: r.subject,
        from: fromById.get(r.messageId) ?? null,
        date: r.internalDate.toISOString(),
        snippet: r.snippet,
      }));
      const last = page[page.length - 1];
      const body: SearchResponseJson = {
        results,
        nextCursor: rows.length > query.limit && last !== undefined ? last.internalDate.toISOString() : null,
        warnings,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    }),
  );

  // --- Events ----------------------------------------------------------------------------------

  router.get(
    '/events',
    handle(async (req, res) => {
      const hub = hubFor(deps);
      if (hub === null) {
        res.status(503).json({ error: 'events_not_configured', message: 'DATABASE_URL is not set' });
        return;
      }
      const me = currentSession(req);
      // A long-lived stream re-checks its session on every heartbeat: sign-out, revocation, expiry or
      // a disabled account ends it. Read-only on purpose — an open tab is not activity, so it never
      // slides the idle timeout.
      const stillValid = async (): Promise<boolean> => {
        const row = await db.session.findUnique({ where: { id: me.sessionId }, select: { expiresAt: true, account: { select: { disabledAt: true } } } });
        return row !== null && row.expiresAt.getTime() > rt.now().getTime() && row.account.disabledAt === null;
      };
      await streamEvents(hub, me.accountId, req, res, { stillValid });
    }),
  );

  return router;
}

class NotFoundSignal extends Error {
  constructor() {
    super('not found');
  }
}
