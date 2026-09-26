// Snooze (PST-T-9.1, PST-REQ-142): POST /api/threads/:id/snooze {until} moves the thread's INBOX
// messages into a "Snoozed" mailbox (created on demand, subscribed — a real IMAP folder, so every
// client sees where the mail went) and records a snoozed_thread row; the worker
// (apps/worker/src/scheduled/snooze.ts) moves them back to INBOX, unread, at `until`.
// DELETE /api/threads/:id/snooze brings them back now.
//
// The move is the IMAP MOVE the retention sweep also makes: each row is re-homed (keeping its id,
// so the snooze record, the search row and the verdict need no rewriting) with a new UID from the
// target's uidnext and one new modseq for both mailboxes; the source records an expunged_message
// row per UID (QRESYNC VANISHED); both mailboxes are pg_notify'd (IMAP IDLE sees EXPUNGE/EXISTS,
// the webmail's SSE a change). Nothing is ever deleted.
import { audited, getAuditContext } from '@postroom/audit';
import { randomUidValidity, SpecialUse, type Db, type Prisma } from '@postroom/db';
import { randomInt } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import { notifyMailbox } from './store.js';

type Tx = Prisma.TransactionClient;

/** The mailbox a snoozed thread waits in. Not a special use: an ordinary, subscribed folder. */
export const SNOOZED_MAILBOX = 'Snoozed';
/** Snoozes at most a year out. */
export const MAX_SNOOZE_MS = 366 * 86_400_000;

const Uuid = z.uuid();
const Iso = z.iso.datetime();

export const SnoozeParams = z.object({ id: Uuid });
export const SnoozeRequest = z.object({ until: Iso.describe('When the thread comes back to INBOX, unread (in the future, at most a year out).') });
export const Snooze = z.object({
  id: Uuid,
  threadId: Uuid,
  until: Iso,
  state: z.enum(['snoozed', 'returned', 'unsnoozed']),
  mailboxId: Uuid.describe('The Snoozed mailbox.'),
  messageIds: z.array(Uuid).describe('The messages moved out of INBOX (their ids do not change).'),
});
export type SnoozeJson = z.infer<typeof Snooze>;

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Locked {
  id: string;
  uidnext: number;
  highestModseq: bigint;
}

/** Find (or create, subscribed) a mailbox by name, with the special use given. */
export async function ensureMailbox(tx: Tx, accountId: string, name: string, specialUse: SpecialUse | null): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO mailbox (account_id, name, special_use, uidvalidity)
    VALUES (${accountId}::uuid, ${name}, ${specialUse}::special_use, ${randomUidValidity(randomInt)})
    ON CONFLICT (account_id, name) DO NOTHING`;
  const row = await tx.mailbox.findUniqueOrThrow({ where: { accountId_name: { accountId, name } }, select: { id: true } });
  return row.id;
}

/** The account's INBOX (special use first, then by name; created if it has none). */
export async function inboxOf(tx: Tx | Db, accountId: string): Promise<string | null> {
  const mb =
    (await tx.mailbox.findFirst({ where: { accountId, specialUse: SpecialUse.inbox }, select: { id: true }, orderBy: { createdAt: 'asc' } })) ??
    (await tx.mailbox.findFirst({ where: { accountId, name: 'INBOX' }, select: { id: true } }));
  return mb?.id ?? null;
}

async function lockMailboxes(tx: Tx, ids: readonly string[]): Promise<Map<string, Locked>> {
  const unique = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<{ id: string; uidnext: number; highest_modseq: bigint }[]>`
    SELECT id::text AS id, uidnext, highest_modseq FROM mailbox WHERE id = ANY(${unique}::uuid[]) ORDER BY id FOR UPDATE`;
  return new Map(rows.map((r) => [r.id, { id: r.id, uidnext: r.uidnext, highestModseq: r.highest_modseq }]));
}

/**
 * Re-home `messageIds` that are still in `sourceId` into `targetId` (both already the account's),
 * IMAP-visibly. `clearSeen` drops \Seen on the way (a snooze returning as unread). Returns the ids
 * actually moved, with their old and new UIDs.
 */
export async function moveMessages(
  tx: Tx,
  input: { sourceId: string; targetId: string; messageIds: readonly string[]; clearSeen: boolean },
): Promise<{ id: string; fromUid: number; toUid: number }[]> {
  if (input.messageIds.length === 0 || input.sourceId === input.targetId) return [];
  const locked = await lockMailboxes(tx, [input.sourceId, input.targetId]);
  const source = locked.get(input.sourceId);
  const target = locked.get(input.targetId);
  if (source === undefined || target === undefined) throw new Error('mailbox vanished');
  const rows = await tx.$queryRaw<{ id: string; uid: number }[]>`
    SELECT id::text AS id, uid FROM message
    WHERE mailbox_id = ${input.sourceId}::uuid AND id = ANY(${[...input.messageIds]}::uuid[])
    ORDER BY uid`;
  if (rows.length === 0) return [];
  const modseq = (target.highestModseq > source.highestModseq ? target.highestModseq : source.highestModseq) + 1n;
  let next = target.uidnext;
  const moved: { id: string; fromUid: number; toUid: number }[] = [];
  for (const r of rows) {
    await tx.$executeRaw`
      UPDATE message AS m SET mailbox_id = ${input.targetId}::uuid, uid = ${next}, modseq = ${modseq},
        flags = CASE WHEN ${input.clearSeen}::boolean THEN array_remove(m.flags, '\\Seen') ELSE m.flags END,
        inbound_message_id = CASE WHEN EXISTS (
          SELECT 1 FROM message o WHERE o.mailbox_id = ${input.targetId}::uuid AND o.inbound_message_id = m.inbound_message_id
        ) THEN NULL ELSE m.inbound_message_id END
      WHERE m.id = ${r.id}::uuid`;
    moved.push({ id: r.id, fromUid: r.uid, toUid: next });
    next++;
  }
  await tx.$executeRaw`UPDATE mailbox SET uidnext = ${next}, highest_modseq = ${modseq} WHERE id = ${input.targetId}::uuid`;
  await tx.$executeRaw`UPDATE mailbox SET highest_modseq = ${modseq} WHERE id = ${input.sourceId}::uuid`;
  await tx.expungedMessage.createMany({ data: rows.map((r) => ({ mailboxId: input.sourceId, uid: r.uid, modseq })), skipDuplicates: true });
  await notifyMailbox(tx, input.targetId);
  await notifyMailbox(tx, input.sourceId);
  return moved;
}

function snoozeJson(row: { id: string; threadId: string; until: Date; state: string; messageIds: string[] }, mailboxId: string): SnoozeJson {
  return {
    id: row.id,
    threadId: row.threadId,
    until: row.until.toISOString(),
    state: row.state === 'returned' || row.state === 'unsnoozed' ? row.state : 'snoozed',
    mailboxId,
    messageIds: row.messageIds,
  };
}

export function snoozeRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  const parse = <S extends z.ZodType>(schema: S, value: unknown, res: Response): z.output<S> | null => {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    res.status(400).json({ error: 'invalid_request', message: result.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') });
    return null;
  };
  const answer = (res: Response, error: unknown): void => {
    if (!(error instanceof Refusal)) throw error;
    res.status(error.status).json({ error: error.code, message: error.message });
  };

  router.post(
    '/threads/:id/snooze',
    handle(async (req, res) => {
      const params = parse(SnoozeParams, req.params, res);
      if (params === null) return;
      const body = parse(SnoozeRequest, req.body, res);
      if (body === null) return;
      const me = currentSession(req);
      const now = rt.now();
      const until = new Date(body.until);
      try {
        if (until.getTime() <= now.getTime()) throw new Refusal(400, 'until_past', 'until must be in the future');
        if (until.getTime() > now.getTime() + MAX_SNOOZE_MS) throw new Refusal(400, 'until_too_far', 'until may be at most a year from now');
        const thread = await db.thread.findFirst({ where: { id: params.id, accountId: me.accountId }, select: { id: true } });
        if (thread === null) throw new Refusal(404, 'not_found', 'no such thread');
        const inbox = await inboxOf(db, me.accountId);
        if (inbox === null) throw new Refusal(409, 'no_inbox', 'this account has no INBOX');
        const result = await audited(db, { kind: 'account', accountId: me.accountId }, { action: 'thread.snooze', entityType: 'thread', context: getAuditContext(req) }, async (tx) => {
          const snoozedBox = await ensureMailbox(tx, me.accountId, SNOOZED_MAILBOX, null);
          // Lock both mailboxes before reading, so two snoozes of one thread serialize.
          await lockMailboxes(tx, [inbox, snoozedBox]);
          const ids = (await tx.message.findMany({ where: { threadId: thread.id, mailboxId: inbox }, select: { id: true } })).map((m) => m.id);
          const existing = await tx.snoozedThread.findFirst({ where: { accountId: me.accountId, threadId: thread.id, state: 'snoozed' }, orderBy: { createdAt: 'desc' } });
          if (ids.length === 0 && existing === null) throw new Refusal(409, 'nothing_to_snooze', 'None of this conversation is in INBOX.');
          const moved = await moveMessages(tx, { sourceId: inbox, targetId: snoozedBox, messageIds: ids, clearSeen: false });
          const movedIds = moved.map((m) => m.id);
          const row =
            existing === null
              ? await tx.snoozedThread.create({ data: { accountId: me.accountId, threadId: thread.id, until, messageIds: movedIds } })
              : await tx.snoozedThread.update({ where: { id: existing.id }, data: { until, messageIds: [...new Set([...existing.messageIds, ...movedIds])] } });
          return {
            entityId: thread.id,
            before: existing === null ? null : { snoozeId: existing.id, until: existing.until.toISOString() },
            after: { snoozeId: row.id, until: until.toISOString(), inboxMailboxId: inbox, snoozedMailboxId: snoozedBox, moved: moved.map((m) => ({ id: m.id, fromUid: m.fromUid, toUid: m.toUid })) },
            result: snoozeJson(row, snoozedBox),
          };
        });
        res.json(result);
      } catch (error) {
        answer(res, error);
      }
    }),
  );

  router.delete(
    '/threads/:id/snooze',
    handle(async (req, res) => {
      const params = parse(SnoozeParams, req.params, res);
      if (params === null) return;
      const me = currentSession(req);
      try {
        const existing = await db.snoozedThread.findFirst({ where: { accountId: me.accountId, threadId: params.id, state: 'snoozed' }, orderBy: { createdAt: 'desc' } });
        if (existing === null) throw new Refusal(404, 'not_found', 'this conversation is not snoozed');
        const inbox = await inboxOf(db, me.accountId);
        if (inbox === null) throw new Refusal(409, 'no_inbox', 'this account has no INBOX');
        const result = await audited(db, { kind: 'account', accountId: me.accountId }, { action: 'thread.unsnooze', entityType: 'thread', context: getAuditContext(req) }, async (tx) => {
          const snoozedBox = await ensureMailbox(tx, me.accountId, SNOOZED_MAILBOX, null);
          await lockMailboxes(tx, [inbox, snoozedBox]);
          // Conditional on still snoozed: the worker returning it at the same moment wins or loses cleanly.
          const n = await tx.snoozedThread.updateMany({ where: { id: existing.id, state: 'snoozed' }, data: { state: 'unsnoozed', returnedAt: rt.now() } });
          if (n.count === 0) throw new Refusal(409, 'not_snoozed', 'It has already come back.');
          const moved = await moveMessages(tx, { sourceId: snoozedBox, targetId: inbox, messageIds: existing.messageIds, clearSeen: false });
          const row = await tx.snoozedThread.findUniqueOrThrow({ where: { id: existing.id } });
          return {
            entityId: params.id,
            before: { snoozeId: existing.id, until: existing.until.toISOString(), state: 'snoozed' },
            after: { state: 'unsnoozed', moved: moved.map((m) => ({ id: m.id, fromUid: m.fromUid, toUid: m.toUid })) },
            result: snoozeJson(row, snoozedBox),
          };
        });
        res.json(result);
      } catch (error) {
        answer(res, error);
      }
    }),
  );

  return router;
}

// --- OpenAPI (PST-REQ-085): spread into the document by compose/openapi.ts ---------------------------

export const SNOOZE_COMPONENTS: Record<string, z.ZodType> = { Snooze };

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });
const CSRF = [{ name: 'x-postroom-csrf', required: true, description: 'Must be 1.' }];

export const SNOOZE_ROUTES: RouteSpec[] = [
  {
    method: 'post',
    path: '/api/threads/{id}/snooze',
    operationId: 'snoozeThread',
    tag: 'Mail',
    summary: 'Snooze a conversation: its INBOX messages move to Snoozed until a chosen time, then return to INBOX unread.',
    description:
      'An IMAP-visible move into the "Snoozed" mailbox (created on demand, subscribed). Snoozing a conversation already snoozed changes its time and takes along anything new in INBOX.',
    params: SnoozeParams,
    body: SnoozeRequest,
    headers: CSRF,
    responses: {
      '200': { description: 'Snoozed.', schema: 'Snooze' },
      '400': err('The request failed validation, or until is not in the future.'),
      '401': err('No session.'),
      '403': err('Missing CSRF header.'),
      '404': err('Not a conversation of the caller.'),
      '409': err('None of the conversation is in INBOX.'),
    },
  },
  {
    method: 'delete',
    path: '/api/threads/{id}/snooze',
    operationId: 'unsnoozeThread',
    tag: 'Mail',
    summary: 'Bring a snoozed conversation back to INBOX now.',
    params: SnoozeParams,
    headers: CSRF,
    responses: {
      '200': { description: 'Back in INBOX.', schema: 'Snooze' },
      '400': err('The request failed validation.'),
      '401': err('No session.'),
      '403': err('Missing CSRF header.'),
      '404': err('The conversation is not snoozed.'),
      '409': err('It has already come back.'),
    },
  },
];
