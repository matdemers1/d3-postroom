// /api/admin/queue — the outbound queue admin (PST-T-6.6 / PST-REQ-121): list what is waiting to
// go out, and act on it per recipient, per message, or per domain — retry now, bounce, delete
// (silently, no DSN) and force-SES. Mounted by app.ts behind requireAdmin; every mutation also
// needs a fresh step-up (PST-REQ-008) and is audited.
//
// "Force-SES re-routes a deferred message" (the doneWhen): the worker's routeByClaims
// (apps/delivery/src/worker.ts) already lets an enqueued transport of 'ses' win over 'direct' at
// each attempt when the SES transport is configured, even for a domain DELIVERY_SES_DOMAINS does
// not list — see its unit test in apps/delivery/test/unit/ses.test.ts. This route only has to set
// OutboundRecipient.transport = 'ses' and nextAttemptAt = now, then give the worker a job to pick
// it up; if SES is not configured, it refuses with 409 rather than silently doing nothing.
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { audited, getAuditContext } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { OUTBOUND_QUEUE, outboundJobKey, transportsFromEnv } from '@postroom/delivery';
import type { OutboundRecipient, Prisma } from '@postroom/db';
import { buildDsn, fileLocalMessage, type DsnRecipientReport } from '@postroom/dsn';
import { enqueue } from '@postroom/queue';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bulk actions (per message, per domain) are bounded: never more rows than this in one request. */
const MAX_BULK = 500;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const HEADER_CAP_BYTES = 64 * 1024;

const ACTIVE: OutboundRecipient['state'][] = ['queued', 'deferred'];

const ListQuery = z.object({
  domain: z.string().trim().min(1).max(253).optional(),
  state: z.enum(['pending', 'deferred', 'held', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
});

const DeleteBody = z.object({ reason: z.string().trim().min(1).max(500) });

type Scope = { kind: 'recipient'; id: string } | { kind: 'message'; id: string } | { kind: 'domain'; domain: string };

function scopeWhere(scope: Scope): Prisma.OutboundRecipientWhereInput {
  if (scope.kind === 'recipient') return { id: scope.id };
  if (scope.kind === 'message') return { outboundMessageId: scope.id };
  return { domain: scope.domain };
}

/** Reads a stream up to the first blank line ending the headers, bounded to `capBytes`; used only
 * to give a manually-triggered bounce a diagnostic body. Destroys the stream when it returns. */
async function readHeaderBlock(stream: Readable, capBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      chunks.push(buf);
      total += buf.length;
      const combined = Buffer.concat(chunks);
      const idx = combined.indexOf('\r\n\r\n');
      if (idx !== -1) return combined.subarray(0, idx + 2);
      if (total >= capBytes) return combined.subarray(0, capBytes);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

function recipientJson(r: OutboundRecipient): Record<string, unknown> {
  return {
    id: r.id,
    outboundMessageId: r.outboundMessageId,
    address: r.address,
    domain: r.domain,
    state: r.state,
    transport: r.transport,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt.toISOString(),
    lastCode: r.lastCode,
    lastEnhanced: r.lastEnhanced,
    lastText: r.lastText,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function adminQueueRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  let blobs: BlobStore | null = null;
  const blobStore = (): BlobStore | null => {
    if (blobs !== null) return blobs;
    if (rt.kek === null) return null;
    const root = deps.env['BLOB_ROOT']?.trim() ?? '';
    blobs = createBlobStore({ root: root === '' ? '/var/lib/postroom/blobs' : root, db, kek: rt.kek });
    return blobs;
  };

  /** True when the delivery daemon's own env would build an 'ses' transport — the same decision
   * apps/delivery/src/transports/index.ts#transportsFromEnv makes, read here so the admin API never
   * disagrees with what the worker will actually do. */
  const sesConfigured = (): boolean => 'ses' in transportsFromEnv(deps.env, () => undefined);

  // POST /api/admin/queue/dev-seed-deferred — e2e only (POSTROOM_E2E_SEED=1, the same gate as
  // admin-dev/index.ts's seed route and admin-jobs' dev-seed-failure): a deferred outbound
  // recipient for e2e/tests/admin-queue.spec.ts to act on, without a live SMTP submission path.
  const DevSeedBody = z.object({ domain: z.string().trim().min(1).max(253).default('example.test') });
  router.post(
    '/dev-seed-deferred',
    handle(async (req, res) => {
      if (deps.env['POSTROOM_E2E_SEED'] !== '1') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const parsed = DevSeedBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const me = currentSession(req);
      const now = rt.now();
      const message = await db.outboundMessage.create({
        data: {
          accountId: me.accountId,
          envelopeFrom: `e2e-${randomUUID()}@d3cloud.io`,
          headerFrom: 'E2E Operator <e2e@d3cloud.io>',
          subject: 'e2e deferred seed',
          blobSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          size: 1,
          submittedVia: 'e2e-seed',
          createdAt: now,
        },
      });
      const recipient = await db.outboundRecipient.create({
        data: {
          outboundMessageId: message.id,
          address: `first@${parsed.data.domain}`,
          domain: parsed.data.domain,
          state: 'deferred',
          transport: 'direct',
          attempts: 1,
          lastCode: 451,
          lastText: 'greylisted (seeded for e2e)',
          nextAttemptAt: new Date(now.getTime() + 3_600_000),
          createdAt: now,
          updatedAt: now,
        },
      });
      res.status(201).json({ messageId: message.id, recipientId: recipient.id, domain: parsed.data.domain });
    }),
  );

  // ─── list ──────────────────────────────────────────────────────────────────────────────────
  router.get(
    '/',
    handle(async (req, res) => {
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const { domain, state, limit } = parsed.data;
      const where: Prisma.OutboundRecipientWhereInput = {
        ...(domain === undefined ? { state: { in: [...ACTIVE, 'bounced'] } } : { domain: domain.toLowerCase() }),
      };
      if (domain !== undefined) where.state = { in: [...ACTIVE, 'bounced'] };
      if (state === 'pending') where.state = 'queued';
      else if (state === 'deferred') where.state = 'deferred';
      else if (state === 'failed') where.state = 'bounced';
      else if (state === 'held') {
        where.state = { in: ACTIVE };
        where.message = { appPassword: { frozenAt: { not: null } } };
      }

      const rows = await db.outboundRecipient.findMany({
        where,
        include: {
          message: { select: { id: true, subject: true, headerFrom: true, envelopeFrom: true, createdAt: true, accountId: true } },
          attemptsLog: { orderBy: { startedAt: 'desc' }, take: 1 },
        },
        orderBy: [{ nextAttemptAt: 'asc' }],
        take: limit ?? DEFAULT_LIST_LIMIT,
      });

      const byMessage = new Map<string, { message: (typeof rows)[number]['message']; recipients: Record<string, unknown>[] }>();
      for (const r of rows) {
        const entry = byMessage.get(r.outboundMessageId) ?? { message: r.message, recipients: [] };
        entry.recipients.push({
          ...recipientJson(r),
          lastAttempt: r.attemptsLog[0] === undefined ? null : { startedAt: r.attemptsLog[0].startedAt.toISOString(), outcome: r.attemptsLog[0].outcome, error: r.attemptsLog[0].error },
        });
        byMessage.set(r.outboundMessageId, entry);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        messages: [...byMessage.values()].map((e) => ({
          id: e.message.id,
          subject: e.message.subject,
          headerFrom: e.message.headerFrom,
          envelopeFrom: e.message.envelopeFrom,
          createdAt: e.message.createdAt.toISOString(),
          recipients: e.recipients,
        })),
        sesConfigured: sesConfigured(),
      });
    }),
  );

  // ─── actions ───────────────────────────────────────────────────────────────────────────────

  /** Give every (message, domain) group among `ids` a due job, so the worker picks the retry up
   * promptly instead of waiting for its previously scheduled job (if any). */
  const nudgeGroups = async (tx: Prisma.TransactionClient, ids: readonly string[], now: Date): Promise<void> => {
    if (ids.length === 0) return;
    const groups = await tx.outboundRecipient.findMany({ where: { id: { in: [...ids] } }, select: { outboundMessageId: true, domain: true }, distinct: ['outboundMessageId', 'domain'] });
    for (const g of groups) {
      await enqueue(tx, OUTBOUND_QUEUE, { messageId: g.outboundMessageId, domain: g.domain }, {
        runAt: now,
        maxAttempts: 1000,
        idempotencyKey: outboundJobKey(g.outboundMessageId, g.domain, `admin-${randomUUID()}`),
      });
    }
  };

  const eligibleIds = async (tx: Prisma.TransactionClient, scope: Scope): Promise<string[]> => {
    const rows = await tx.outboundRecipient.findMany({
      where: { ...scopeWhere(scope), state: { in: ACTIVE } },
      select: { id: true },
      take: scope.kind === 'recipient' ? 1 : MAX_BULK,
    });
    return rows.map((r) => r.id);
  };

  class NotFound extends Error {}
  class NotEligible extends Error {}
  class SesNotConfigured extends Error {}

  const singleGuard = async (scope: Extract<Scope, { kind: 'recipient' }>, tx: Prisma.TransactionClient | typeof db): Promise<void> => {
    const row = await tx.outboundRecipient.findUnique({ where: { id: scope.id }, select: { state: true } });
    if (row === null) throw new NotFound();
    if (!ACTIVE.includes(row.state)) throw new NotEligible();
  };

  const messageGuard = async (scope: Extract<Scope, { kind: 'message' }>, tx: Prisma.TransactionClient | typeof db): Promise<void> => {
    const message = await tx.outboundMessage.findUnique({ where: { id: scope.id }, select: { id: true } });
    if (message === null) throw new NotFound();
  };

  /** POST retry — set nextAttemptAt = now for every eligible recipient in scope, and nudge the queue. */
  const doRetry = (deps_: ApiDeps, scope: Scope, action: string) =>
    handle(async (req: Request, res: Response) => {
      const me = currentSession(req);
      try {
        const result = await audited<{ ids: string[] }>(
          db,
          { kind: 'account', accountId: me.accountId },
          { action, entityType: scope.kind === 'domain' ? 'outbound_recipient_bulk' : 'outbound_recipient', context: getAuditContext(req) },
          async (tx) => {
            if (scope.kind === 'recipient') await singleGuard(scope, tx);
            if (scope.kind === 'message') await messageGuard(scope, tx);
            const ids = await eligibleIds(tx, scope);
            if (scope.kind === 'recipient' && ids.length === 0) throw new NotEligible();
            const now = rt.now();
            if (ids.length > 0) {
              await tx.outboundRecipient.updateMany({ where: { id: { in: ids } }, data: { nextAttemptAt: now } });
              await nudgeGroups(tx, ids, now);
            }
            return { entityId: scope.kind === 'recipient' ? scope.id : (scope.kind === 'message' ? scope.id : null), before: null, after: { count: ids.length, scope }, result: { ids } };
          },
        );
        res.status(202).json({ ok: true, count: result.ids.length });
      } catch (error) {
        if (error instanceof NotFound) { res.status(404).json({ error: 'not_found' }); return; }
        if (error instanceof NotEligible) { res.status(409).json({ error: 'not_eligible' }); return; }
        throw error;
      }
    });

  /** POST force-ses — set transport = 'ses' and nextAttemptAt = now; 409 if SES is not configured. */
  const doForceSes = (deps_: ApiDeps, scope: Scope) =>
    handle(async (req: Request, res: Response) => {
      const me = currentSession(req);
      try {
        if (!sesConfigured()) throw new SesNotConfigured();
        const result = await audited<{ ids: string[] }>(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'admin.queue.force_ses', entityType: scope.kind === 'domain' ? 'outbound_recipient_bulk' : 'outbound_recipient', context: getAuditContext(req) },
          async (tx) => {
            if (scope.kind === 'recipient') await singleGuard(scope, tx);
            if (scope.kind === 'message') await messageGuard(scope, tx);
            const ids = await eligibleIds(tx, scope);
            if (scope.kind === 'recipient' && ids.length === 0) throw new NotEligible();
            const now = rt.now();
            if (ids.length > 0) {
              await tx.outboundRecipient.updateMany({ where: { id: { in: ids } }, data: { transport: 'ses', nextAttemptAt: now } });
              await nudgeGroups(tx, ids, now);
            }
            return { entityId: scope.kind === 'recipient' ? scope.id : (scope.kind === 'message' ? scope.id : null), before: null, after: { count: ids.length, transport: 'ses', scope }, result: { ids } };
          },
        );
        res.status(202).json({ ok: true, count: result.ids.length, transport: 'ses' });
      } catch (error) {
        if (error instanceof NotFound) { res.status(404).json({ error: 'not_found' }); return; }
        if (error instanceof NotEligible) { res.status(409).json({ error: 'not_eligible' }); return; }
        if (error instanceof SesNotConfigured) { res.status(409).json({ error: 'ses_not_configured' }); return; }
        throw error;
      }
    });

  /** DELETE — silently remove from the queue (no DSN); the message's Sent copy is untouched. */
  const doDelete = (deps_: ApiDeps, scope: Scope) =>
    handle(async (req: Request, res: Response) => {
      const parsed = DeleteBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const { reason } = parsed.data;
      const me = currentSession(req);
      try {
        const result = await audited<{ ids: string[] }>(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'admin.queue.delete', entityType: scope.kind === 'domain' ? 'outbound_recipient_bulk' : 'outbound_recipient', context: getAuditContext(req) },
          async (tx) => {
            if (scope.kind === 'recipient') await singleGuard(scope, tx);
            if (scope.kind === 'message') await messageGuard(scope, tx);
            const ids = await eligibleIds(tx, scope);
            if (scope.kind === 'recipient' && ids.length === 0) throw new NotEligible();
            const now = rt.now();
            if (ids.length > 0) await tx.outboundRecipient.updateMany({ where: { id: { in: ids } }, data: { state: 'cancelled', lastText: `deleted by admin: ${reason}`, updatedAt: now } });
            return { entityId: scope.kind === 'recipient' ? scope.id : (scope.kind === 'message' ? scope.id : null), before: null, after: { count: ids.length, reason, scope }, result: { ids } };
          },
        );
        res.status(202).json({ ok: true, count: result.ids.length });
      } catch (error) {
        if (error instanceof NotFound) { res.status(404).json({ error: 'not_found' }); return; }
        if (error instanceof NotEligible) { res.status(409).json({ error: 'not_eligible' }); return; }
        throw error;
      }
    });

  /** Build and file a failure DSN (RFC 3464) for one recipient, then mark it bounced. Idempotent
   * against a DSN already sent by the worker or a previous admin bounce: `failureDsnSentAt` is
   * claimed with a guarded UPDATE first, mirroring apps/delivery/src/dsn.ts's own claim. `headers`
   * is read from the blob store *before* this runs, outside the transaction — reading it through
   * `tx` here would ask the pool for a second connection while the first is held by this same
   * transaction and can deadlock the pool in a single-connection test database. */
  const bounceOne = async (tx: Prisma.TransactionClient, recipient: OutboundRecipient, message: { envelopeFrom: string; accountId: string }, headers: Buffer | null, now: Date): Promise<void> => {
    const claim = message.envelopeFrom === '' || headers === null ? { count: 0 } : await tx.outboundRecipient.updateMany({ where: { id: recipient.id, failureDsnSentAt: null }, data: { failureDsnSentAt: now } });
    if (claim.count > 0 && headers !== null) {
      const store = blobStore();
      if (store !== null) {
        const report: DsnRecipientReport = {
          finalRecipient: recipient.address,
          action: 'failed',
          status: recipient.lastEnhanced ?? '5.4.7',
          lastAttemptDate: now,
          ...(recipient.lastCode === null && recipient.lastEnhanced === null && (recipient.lastText ?? '') === '' ? {} : { diagnosticCode: recipient.lastCode !== null ? `smtp; ${recipient.lastCode} ${recipient.lastEnhanced ?? ''} ${recipient.lastText ?? ''}`.trim() : `x-postroom; ${recipient.lastText ?? 'bounced by admin'}` }),
        };
        const dsnBuffer = buildDsn({
          kind: 'failure',
          reportingMta: 'mx.d3cloud.io',
          arrivalDate: recipient.createdAt,
          originalMessageHeaders: headers,
          recipients: [report],
          from: 'Mail Delivery System <mailer-daemon@d3cloud.io>',
          to: message.envelopeFrom,
          date: now,
          messageId: `dsn-${recipient.id}-failure-admin@mx.d3cloud.io`,
        });
        const put = await store.put(dsnBuffer, { tx });
        await fileLocalMessage(tx, { accountId: message.accountId, mailbox: 'INBOX', blobSha256: put.sha256, size: put.size, internalDate: now });
      }
    }
    await tx.outboundRecipient.update({ where: { id: recipient.id }, data: { state: 'bounced', lastText: 'bounced by admin', updatedAt: now } });
  };

  /** POST bounce — mark permanently failed and generate the DSN the worker would otherwise emit. */
  const doBounce = (deps_: ApiDeps, scope: Scope) =>
    handle(async (req: Request, res: Response) => {
      const me = currentSession(req);
      try {
        if (scope.kind === 'recipient') await singleGuard(scope, db);
        if (scope.kind === 'message') await messageGuard(scope, db);
        const recipients = await db.outboundRecipient.findMany({ where: { ...scopeWhere(scope), state: { in: ACTIVE } }, take: scope.kind === 'recipient' ? 1 : MAX_BULK });
        if (scope.kind === 'recipient' && recipients.length === 0) throw new NotEligible();

        // Read every distinct message's headers up front, outside any transaction (see bounceOne).
        const messages = new Map<string, { envelopeFrom: string; accountId: string; blobSha256: string }>();
        const headersByMessage = new Map<string, Buffer | null>();
        const store = blobStore();
        for (const r of recipients) {
          if (messages.has(r.outboundMessageId)) continue;
          const message = await db.outboundMessage.findUnique({ where: { id: r.outboundMessageId }, select: { envelopeFrom: true, accountId: true, blobSha256: true } });
          if (message === null) continue;
          messages.set(r.outboundMessageId, message);
          if (message.envelopeFrom === '' || store === null) {
            headersByMessage.set(r.outboundMessageId, null);
            continue;
          }
          try {
            const stream = await store.get(message.blobSha256);
            headersByMessage.set(r.outboundMessageId, await readHeaderBlock(stream, HEADER_CAP_BYTES));
          } catch {
            headersByMessage.set(r.outboundMessageId, null);
          }
        }

        const result = await audited<{ ids: string[] }>(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'admin.queue.bounce', entityType: scope.kind === 'domain' ? 'outbound_recipient_bulk' : 'outbound_recipient', context: getAuditContext(req) },
          async (tx) => {
            const now = rt.now();
            for (const r of recipients) {
              const message = messages.get(r.outboundMessageId);
              if (message === undefined) continue;
              await bounceOne(tx, r, message, headersByMessage.get(r.outboundMessageId) ?? null, now);
            }
            return { entityId: scope.kind === 'recipient' ? scope.id : (scope.kind === 'message' ? scope.id : null), before: null, after: { count: recipients.length, scope }, result: { ids: recipients.map((r) => r.id) } };
          },
        );
        res.status(202).json({ ok: true, count: result.ids.length });
      } catch (error) {
        if (error instanceof NotFound) { res.status(404).json({ error: 'not_found' }); return; }
        if (error instanceof NotEligible) { res.status(409).json({ error: 'not_eligible' }); return; }
        throw error;
      }
    });

  const bindScope = (kind: Scope['kind']) => (req: Request): Scope => {
    if (kind === 'recipient') return { kind: 'recipient', id: String(req.params['id']) };
    if (kind === 'message') return { kind: 'message', id: String(req.params['id']) };
    return { kind: 'domain', domain: String(req.params['domain']).toLowerCase() };
  };

  const validateScope = (req: Request, res: Response, kind: Scope['kind']): boolean => {
    if (kind === 'domain') return true;
    const id = String(req.params['id']);
    if (!UUID.test(id)) {
      res.status(400).json({ error: 'invalid_request' });
      return false;
    }
    return true;
  };

  for (const [prefix, kind] of [
    ['/recipients/:id', 'recipient'],
    ['/messages/:id', 'message'],
    ['/domains/:domain', 'domain'],
  ] as const) {
    router.post(
      `${prefix}/retry`,
      requireStepUp(deps),
      handle(async (req, res) => {
        if (!validateScope(req, res, kind)) return;
        await doRetry(deps, bindScope(kind)(req), 'admin.queue.retry')(req, res, () => undefined);
      }),
    );
    router.post(
      `${prefix}/force-ses`,
      requireStepUp(deps),
      handle(async (req, res) => {
        if (!validateScope(req, res, kind)) return;
        await doForceSes(deps, bindScope(kind)(req))(req, res, () => undefined);
      }),
    );
    router.post(
      `${prefix}/bounce`,
      requireStepUp(deps),
      handle(async (req, res) => {
        if (!validateScope(req, res, kind)) return;
        await doBounce(deps, bindScope(kind)(req))(req, res, () => undefined);
      }),
    );
    router.delete(
      prefix,
      requireStepUp(deps),
      handle(async (req, res) => {
        if (!validateScope(req, res, kind)) return;
        await doDelete(deps, bindScope(kind)(req))(req, res, () => undefined);
      }),
    );
  }

  return router;
}
