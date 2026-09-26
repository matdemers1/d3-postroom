// Remind if no reply (PST-T-9.1, PST-REQ-143). A send with remindAfterSeconds arms a reply_reminder
// on its Sent copy; at dueAt this asks one question: has anyone other than the account written in
// that conversation since it was sent? Threading is reliable (assignThread), and In-Reply-To /
// References naming the sent Message-ID count too, for a reply the thread has not caught yet.
//
//   · a reply arrived → state `replied`, nothing else happens;
//   · none → the sent message is resurfaced: a LOCAL copy filed in INBOX from the same blob (one more
//     reference, no new bytes), unread, \Flagged and `$Remind`, in the same thread. The least
//     surprising choice: it appears at the top of INBOX like new mail, every IMAP client shows it,
//     and nothing is delivered to anyone — no second outbound message, ever. The Sent copy is left
//     untouched.
//
// Exactly once: the pending → resurfaced/replied transition is conditional on `pending` and commits
// with the copy. Audited either way.
import { recordAudit, type Actor } from '@postroom/audit';
import type { Db } from '@postroom/db';
import { sendableAddresses } from '@postroom/submission';
import { fileCopy, specialMailboxName } from './mailbox.js';

const ACTOR: Actor = { kind: 'system', label: 'remind-if-no-reply' };
export const REMIND_FLAGS = ['\\Flagged', '$Remind'] as const;

export interface RemindDeps {
  readonly db: Db;
  readonly now: () => Date;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

export type RemindOutcome = 'resurfaced' | 'replied' | 'cancelled' | 'skipped';

/** Whether someone other than the account wrote in the conversation after `since`. */
export async function hasReply(db: Db, input: { accountId: string; sentMessageId: string; messageIdHeader: string; threadId: string | null; since: Date }): Promise<boolean> {
  const own = (await sendableAddresses(db, input.accountId)).map((a) => a.toLowerCase());
  const key = input.messageIdHeader.replace(/^<|>$/g, '');
  const candidates = await db.message.findMany({
    where: {
      mailbox: { accountId: input.accountId },
      id: { not: input.sentMessageId },
      receivedAt: { gt: input.since },
      OR: [...(input.threadId === null ? [] : [{ threadId: input.threadId }]), { inReplyTo: { in: [key, `<${key}>`] } }, { references: { has: key } }],
    },
    select: { fromAddress: true, flags: true },
  });
  return candidates.some((m) => !m.flags.includes('$Remind') && m.fromAddress !== null && m.fromAddress !== '' && !own.includes(m.fromAddress.toLowerCase()));
}

export async function checkOne(deps: RemindDeps, id: string): Promise<RemindOutcome> {
  const r = await deps.db.replyReminder.findUnique({ where: { id } });
  if (r?.state !== 'pending') return 'skipped';
  const sent =
    (await deps.db.message.findFirst({ where: { id: r.sentMessageId, mailbox: { accountId: r.accountId } } })) ??
    // The Sent copy moved (MOVE re-homes keep the id, a COPY + EXPUNGE does not): find it by Message-ID.
    (await deps.db.message.findFirst({ where: { mailbox: { accountId: r.accountId, specialUse: 'sent' }, messageIdHeader: { in: [r.messageIdHeader, `<${r.messageIdHeader}>`] } } }));
  const now = deps.now();

  const settle = async (state: 'replied' | 'cancelled', why: string): Promise<RemindOutcome> =>
    deps.db.$transaction(async (tx) => {
      const n = await tx.replyReminder.updateMany({ where: { id, state: 'pending' }, data: { state, checkedAt: now } });
      if (n.count === 0) return 'skipped';
      await recordAudit(tx, { actor: ACTOR, action: `reminder.${state}`, entityType: 'reply_reminder', entityId: id, before: { state: 'pending' }, after: { accountId: r.accountId, state, why } });
      return state;
    });

  if (sent === null) return settle('cancelled', 'the sent message is gone');
  if (await hasReply(deps.db, { accountId: r.accountId, sentMessageId: sent.id, messageIdHeader: r.messageIdHeader, threadId: sent.threadId, since: r.sentAt })) {
    return settle('replied', 'a reply arrived in the conversation');
  }

  const search = await deps.db.messageSearch.findUnique({ where: { messageId: sent.id } });
  return deps.db.$transaction(async (tx) => {
    const n = await tx.replyReminder.updateMany({ where: { id, state: 'pending' }, data: { state: 'resurfaced', checkedAt: now } });
    if (n.count === 0) return 'skipped';
    const copy = await fileCopy(tx, {
      accountId: r.accountId,
      mailboxName: await specialMailboxName(tx, r.accountId, 'inbox'),
      blobSha256: sent.blobSha256,
      size: sent.size,
      flags: REMIND_FLAGS,
      denorm: {
        messageIdHeader: sent.messageIdHeader ?? r.messageIdHeader,
        subject: sent.subject ?? '',
        fromAddress: sent.fromAddress ?? '',
        to: search?.toText ?? '',
        sentAt: sent.sentAt ?? r.sentAt,
        inReplyTo: sent.inReplyTo,
        references: sent.references,
        bodyText: search?.bodyText ?? '',
      },
      now,
      takeReference: true,
      threadId: sent.threadId,
    });
    await tx.replyReminder.update({ where: { id }, data: { resurfacedMessageId: copy.id } });
    await recordAudit(tx, {
      actor: ACTOR,
      action: 'reminder.resurfaced',
      entityType: 'reply_reminder',
      entityId: id,
      before: { state: 'pending' },
      after: { accountId: r.accountId, state: 'resurfaced', sentMessageId: sent.id, resurfacedMessageId: copy.id, inboxMailboxId: copy.mailboxId, uid: copy.uid },
    });
    return 'resurfaced';
  });
}

export async function checkDue(deps: RemindDeps, batch = 100): Promise<Record<RemindOutcome, number>> {
  const counts: Record<RemindOutcome, number> = { resurfaced: 0, replied: 0, cancelled: 0, skipped: 0 };
  const due = await deps.db.replyReminder.findMany({ where: { state: 'pending', dueAt: { lte: deps.now() } }, orderBy: { dueAt: 'asc' }, take: batch, select: { id: true } });
  for (const { id } of due) {
    try {
      counts[await checkOne(deps, id)]++;
    } catch (error) {
      deps.log?.('reminder-error', { id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return counts;
}
