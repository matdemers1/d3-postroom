// Delivery attempts over HTTP (PST-T-1.13). Mounted by app.ts at /api/messages behind a session.
//
// Read-only except the cancel below: an account sees its own sent messages, per-recipient state,
// and the full attempt log (MX, TLS, remote response) for each. An admin may also look at a
// *service* account's outbound (?accountId=), mirroring app-passwords' targetOf rule (PST-T-1.3).
// A message that isn't the caller's answers 404, never 403, so its existence is never leaked.
import { audited, getAuditContext } from '@postroom/audit';
import { CannotCancelError, cancelRecipient } from '@postroom/delivery';
import { AccountKind, type Db, type DeliveryAttempt, type OutboundMessage, type OutboundRecipient } from '@postroom/db';
import { Router, type Request, type Response } from 'express';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { findOwnMessage as findOwnMailboxMessage } from '../mail/store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

interface Target {
  accountId: string;
}

function attemptJson(a: DeliveryAttempt): Record<string, unknown> {
  return {
    startedAt: a.startedAt.toISOString(),
    finishedAt: a.finishedAt?.toISOString() ?? null,
    durationMs: a.finishedAt === null ? null : a.finishedAt.getTime() - a.startedAt.getTime(),
    transport: a.transport,
    mxHost: a.mxHost,
    mxIp: a.mxIp,
    localIp: a.localIp,
    tls: { version: a.tlsVersion, cipher: a.tlsCipher, peer: a.tlsPeer },
    remote: { code: a.remoteCode, enhanced: a.remoteEnhanced, text: a.remoteText },
    outcome: a.outcome,
    error: a.error,
  };
}

function recipientJson(r: OutboundRecipient & { attemptsLog: DeliveryAttempt[] }): Record<string, unknown> {
  return {
    id: r.id,
    address: r.address,
    state: r.state,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt.toISOString(),
    lastCode: r.lastCode,
    lastEnhanced: r.lastEnhanced,
    lastText: r.lastText,
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
    dsn: {
      delaySentAt: r.delayDsnSentAt?.toISOString() ?? null,
      failureSentAt: r.failureDsnSentAt?.toISOString() ?? null,
    },
    transport: r.transport,
    attemptsLog: r.attemptsLog.map(attemptJson),
  };
}

function messageJson(m: OutboundMessage): Record<string, unknown> {
  return {
    id: m.id,
    subject: m.subject,
    headerFrom: m.headerFrom,
    messageId: m.messageId,
    createdAt: m.createdAt.toISOString(),
    size: m.size,
  };
}

export function deliveryRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  /** Whose outbound this request is about, or null after answering 400/403/404. */
  const targetOf = async (req: Request, res: Response): Promise<Target | null> => {
    const me = currentSession(req);
    const asked = req.query['accountId'];
    if (asked === undefined || asked === me.accountId) return { accountId: me.accountId };
    if (typeof asked !== 'string' || !UUID.test(asked)) {
      res.status(400).json({ error: 'invalid_request' });
      return null;
    }
    if (!me.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    const account = await db.account.findUnique({ where: { id: asked }, select: { kind: true } });
    if (account?.kind !== AccountKind.service) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return { accountId: asked };
  };

  router.get(
    '/outbound',
    handle(async (req, res) => {
      const target = await targetOf(req, res);
      if (target === null) return;
      const rawLimit = req.query['limit'];
      const limit = Math.min(MAX_LIMIT, Math.max(1, typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : DEFAULT_LIMIT));
      const cursor = req.query['cursor'];
      if (cursor !== undefined && (typeof cursor !== 'string' || !UUID.test(cursor))) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const rows = await db.outboundMessage.findMany({
        where: { accountId: target.accountId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor !== undefined ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { recipients: true },
      });
      const page = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? (page[page.length - 1]?.id ?? null) : null;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        messages: page.map((m) => ({
          ...messageJson(m),
          recipients: m.recipients.map((r) => ({ id: r.id, address: r.address, state: r.state, lastText: r.lastText })),
        })),
        nextCursor,
      });
    }),
  );

  /** A mailbox message's own outbound row (PST-T-6.7, PST-REQ-119): looks up the message's
   *  Message-ID header, then this account's most recent OutboundMessage row bearing that same
   *  Message-ID — an indexed lookup on (accountId, messageId), not a scan of recent sends. Null
   *  covers both "never sent" and "sent, but not through Postroom" (e.g. a Sent copy another
   *  client APPENDed): the caller shows the same "no delivery record" note either way. */
  router.get(
    '/:id/outbound',
    handle(async (req, res) => {
      const id = String(req.params['id']);
      if (!UUID.test(id)) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const me = currentSession(req);
      const message = await findOwnMailboxMessage(db, me.accountId, id);
      if (message === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      if (message.messageIdHeader === null || message.messageIdHeader === '') {
        res.json({ outboundId: null });
        return;
      }
      const outbound = await db.outboundMessage.findFirst({
        where: { accountId: me.accountId, messageId: `<${message.messageIdHeader}>` },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      res.json({ outboundId: outbound?.id ?? null });
    }),
  );

  const findOwnMessage = async (db_: Db, id: string, accountId: string): Promise<(OutboundMessage & { recipients: (OutboundRecipient & { attemptsLog: DeliveryAttempt[] })[] }) | null> => {
    const message = await db_.outboundMessage.findUnique({
      where: { id },
      include: { recipients: { include: { attemptsLog: { orderBy: { startedAt: 'asc' } } } } },
    });
    if (message === null || message.accountId !== accountId) return null;
    return message;
  };

  router.get(
    '/:id/delivery',
    handle(async (req, res) => {
      const id = String(req.params['id']);
      if (!UUID.test(id)) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const target = await targetOf(req, res);
      if (target === null) return;
      const message = await findOwnMessage(db, id, target.accountId);
      if (message === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        message: messageJson(message),
        recipients: message.recipients.map(recipientJson),
      });
    }),
  );

  router.post(
    '/:id/recipients/:rid/cancel',
    handle(async (req, res) => {
      const id = String(req.params['id']);
      const rid = String(req.params['rid']);
      if (!UUID.test(id) || !UUID.test(rid)) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const target = await targetOf(req, res);
      if (target === null) return;
      const message = await findOwnMessage(db, id, target.accountId);
      if (message === null || !message.recipients.some((r) => r.id === rid)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const me = currentSession(req);
      try {
        const result = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'outbound.recipient.cancel', entityType: 'outbound_recipient', context: getAuditContext(req) },
          (tx) => cancelRecipient(tx, rid),
        );
        res.json({ id: result.id, state: result.state, attempts: result.attempts, nextAttemptAt: result.nextAttemptAt.toISOString() });
      } catch (error) {
        if (error instanceof CannotCancelError) {
          res.status(409).json({ error: 'not_cancellable' });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
