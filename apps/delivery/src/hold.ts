// Holding a frozen credential's queued mail (PST-T-1.10 / PST-REQ-044): the worker never attempts a
// recipient whose message's app password is frozen, and thawing re-enqueues everything it held.
import type { Actor } from '@postroom/audit';
import { recordAudit } from '@postroom/audit';
import type { Db } from '@postroom/db';
import { enqueue } from '@postroom/queue';
import { OUTBOUND_QUEUE, outboundJobKey } from './enqueue.js';

export const HELD_TEXT = 'held: credential frozen';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** True when this outbound message's credential is currently frozen. */
export function isCredentialFrozen(message: { appPassword: { frozenAt: Date | null } | null }): boolean {
  return (message.appPassword?.frozenAt ?? null) !== null;
}

/** Mark a domain group's due recipients as held: no attempt, waiting for a thaw. */
export async function holdGroup(db: Db, group: { messageId: string; domain: string }, now: Date, log?: Log): Promise<number> {
  const held = await db.outboundRecipient.updateMany({
    where: { outboundMessageId: group.messageId, domain: group.domain, state: { in: ['queued', 'deferred'] } },
    data: { lastText: HELD_TEXT, updatedAt: now },
  });
  if (held.count > 0) log?.('held-frozen', { messageId: group.messageId, domain: group.domain, count: held.count });
  return held.count;
}

/** Every (message, domain) group with recipients still waiting on this credential. */
async function heldGroups(db: Db, appPasswordId: string): Promise<{ messageId: string; domain: string }[]> {
  const rows = await db.$queryRaw<{ message_id: string; domain: string }[]>`
    SELECT DISTINCT r.outbound_message_id::text AS message_id, r.domain
    FROM outbound_recipient r
    JOIN outbound_message m ON m.id = r.outbound_message_id
    WHERE m.app_password_id = ${appPasswordId}::uuid
      AND r.state IN ('queued', 'deferred')`;
  return rows.map((r) => ({ messageId: r.message_id, domain: r.domain }));
}

/** Give every held group of a credential a fresh job, so the worker resumes them. */
export async function reenqueueHeld(db: Db, appPasswordId: string, now: Date): Promise<number> {
  const groups = await heldGroups(db, appPasswordId);
  let rescheduled = 0;
  for (const g of groups) {
    const job = await enqueue(
      db,
      OUTBOUND_QUEUE,
      { messageId: g.messageId, domain: g.domain },
      { runAt: now, maxAttempts: 1000, idempotencyKey: outboundJobKey(g.messageId, g.domain, `thaw-${String(now.getTime())}`) },
    );
    if (job !== null) rescheduled++;
  }
  return rescheduled;
}

export interface ThawResult {
  /** False when the credential was not frozen (or does not exist): no mutation, no re-enqueue. */
  readonly thawed: boolean;
  readonly rescheduled: number;
}

/** Clear a credential's freeze, audit the mutation, and resume whatever it held. */
export async function thawCredential(db: Db, appPasswordId: string, actor: Actor, now: Date): Promise<ThawResult> {
  const thawed = await db.$transaction(async (tx) => {
    const ap = await tx.appPassword.findUnique({ where: { id: appPasswordId } });
    if (ap === null || ap.frozenAt === null) return false;
    await tx.appPassword.update({ where: { id: appPasswordId }, data: { frozenAt: null } });
    await recordAudit(tx, {
      actor,
      action: 'app_password.thaw',
      entityType: 'app_password',
      entityId: appPasswordId,
      before: { frozenAt: ap.frozenAt.toISOString() },
      after: { frozenAt: null },
    });
    return true;
  });
  const rescheduled = thawed ? await reenqueueHeld(db, appPasswordId, now) : 0;
  return { thawed, rescheduled };
}
