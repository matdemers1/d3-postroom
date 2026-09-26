// Returning snoozed conversations (PST-T-9.1, PST-REQ-142). POST /api/threads/:id/snooze moved a
// thread's INBOX messages into "Snoozed" and recorded when they come back; at `until` this moves
// whichever of them are still in Snoozed back to INBOX with \Seen cleared — unread, at the top of the
// list — as an IMAP-visible move (EXPUNGE in Snoozed, EXISTS in INBOX). A message the person moved
// elsewhere in the meantime stays where they put it. Audited, once per snooze.
import { recordAudit, type Actor } from '@postroom/audit';
import type { Db } from '@postroom/db';
import { ensureMailbox, lockMailboxes, moveMessages, SNOOZED_MAILBOX, specialMailbox } from './mailbox.js';

const ACTOR: Actor = { kind: 'system', label: 'snooze' };

export interface SnoozeDeps {
  readonly db: Db;
  readonly now: () => Date;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** Return one snooze if it is still snoozed. Returns how many messages came back, or null if it was not snoozed any more. */
export async function returnOne(deps: SnoozeDeps, id: string): Promise<number | null> {
  return deps.db.$transaction(async (tx) => {
    const row = await tx.snoozedThread.findUnique({ where: { id } });
    if (row?.state !== 'snoozed') return null;
    const inbox = await specialMailbox(tx, row.accountId, 'inbox');
    const snoozed = await ensureMailbox(tx, row.accountId, SNOOZED_MAILBOX, null);
    await lockMailboxes(tx, [inbox, snoozed]);
    // Conditional on still snoozed: a manual unsnooze at the same moment wins or loses cleanly.
    const n = await tx.snoozedThread.updateMany({ where: { id, state: 'snoozed' }, data: { state: 'returned', returnedAt: deps.now() } });
    if (n.count === 0) return null;
    const moved = await moveMessages(tx, { sourceId: snoozed, targetId: inbox, messageIds: row.messageIds, clearSeen: true });
    await recordAudit(tx, {
      actor: ACTOR,
      action: 'thread.snooze-return',
      entityType: 'thread',
      entityId: row.threadId,
      before: { snoozeId: row.id, state: 'snoozed', until: row.until.toISOString() },
      after: { accountId: row.accountId, state: 'returned', inboxMailboxId: inbox, snoozedMailboxId: snoozed, moved: moved.map((m) => ({ id: m.id, fromUid: m.fromUid, toUid: m.toUid })) },
    });
    return moved.length;
  });
}

export async function returnDue(deps: SnoozeDeps, batch = 100): Promise<number> {
  const due = await deps.db.snoozedThread.findMany({ where: { state: 'snoozed', until: { lte: deps.now() } }, orderBy: { until: 'asc' }, take: batch, select: { id: true } });
  let returned = 0;
  for (const { id } of due) {
    try {
      if ((await returnOne(deps, id)) !== null) returned++;
    } catch (error) {
      deps.log?.('snooze-return-error', { id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return returned;
}
