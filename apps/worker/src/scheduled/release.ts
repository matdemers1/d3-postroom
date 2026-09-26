// Releasing held sends (PST-T-9.1): undo send (PST-REQ-140) and scheduled send (PST-REQ-141).
//
// POST /api/compose/send with undoSeconds or sendAt stores the message exactly as it will be
// submitted (a blob the pending_send row holds a reference on) and files a copy in Drafts. At
// releaseAt this runs it through @postroom/submission's acceptSubmission — the same From check, DKIM
// signing, recipient cap, queue rows and `submission.accept` audit row as any send — and, inside that
// one accepting transaction:
//
//   · pending_send goes held → released, conditional on `held`. A second release (a retry after a
//     crash, a second worker, a racing undo) either blocks on the row lock and then matches nothing,
//     or already sees `released`: it throws, the whole accepting transaction rolls back, and no second
//     outbound_message exists. Exactly once, whatever happens (the crash-safety the task asks for);
//   · the Sent copy is filed from the queued blob, the Drafts copy is expunged (IMAP-visibly), the
//     held blob's reference is released, and remind-if-no-reply is armed if it was asked for.
//
// If the Drafts copy is gone (deleted or edited from any client), the send is cancelled instead:
// Drafts is where the person sees a pending message, so removing it there takes it back. A refusal
// from the submission path (no DKIM keys, the recipient cap, a From no longer owned) marks it failed
// and leaves the draft in Drafts, to be sent again by hand. Either way, audited.
import { recordAudit, type Actor } from '@postroom/audit';
import type { BlobStore } from '@postroom/blobstore';
import type { Kek } from '@postroom/crypto';
import type { Db, Prisma } from '@postroom/db';
import { acceptSubmission, sendableAddresses } from '@postroom/submission';
import { assignThread } from '@postroom/threading';
import { fileCopy, removeMessage, specialMailboxName, type Tx } from './mailbox.js';

export const SENT_FLAGS = ['\\Seen'] as const;
const ACTOR: Actor = { kind: 'system', label: 'scheduled-send' };

export type Log = (event: string, fields?: Record<string, unknown>) => void;
export type WebmailCaps = (tx: Prisma.TransactionClient, accountId: string, recipients: readonly string[], at: Date) => Promise<void>;

export interface ReleaseDeps {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly kek: () => Kek;
  readonly caps: WebmailCaps;
  readonly now: () => Date;
  readonly log?: Log;
  /** Test seam: runs inside the accepting transaction just before it commits (a crash there). */
  readonly beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export type ReleaseOutcome = 'released' | 'cancelled' | 'failed' | 'skipped';

class AlreadyHandled extends Error {}
class DraftGone extends Error {}

/** One audit row per release attempt's outcome, as the system (on the account's behalf). */
async function audit(tx: Tx | Db, action: string, pendingId: string, accountId: string, after: Record<string, unknown>): Promise<void> {
  await recordAudit(tx, { actor: ACTOR, action, entityType: 'pending_send', entityId: pendingId, before: { state: 'held' }, after: { accountId, ...after } });
}

/** Terminal, not-sent: held → cancelled | failed, the held blob's reference released. */
async function finishUnsent(deps: ReleaseDeps, id: string, state: 'cancelled' | 'failed', reason: string): Promise<boolean> {
  const reaped: string[] = [];
  const done = await deps.db.$transaction(async (tx) => {
    const row = await tx.pendingSend.findUnique({ where: { id } });
    if (row === null) return false;
    const n = await tx.pendingSend.updateMany({ where: { id, state: 'held' }, data: { state, reason, finishedAt: deps.now() } });
    if (n.count === 0) return false;
    const released = await deps.blobs.release(row.heldBlobSha256, tx);
    if (released.refcount === 0) reaped.push(row.heldBlobSha256);
    await audit(tx, state === 'failed' ? 'compose.release-failed' : 'compose.release-cancelled', id, row.accountId, { state, reason, draftId: row.draftMessageId });
    return true;
  });
  for (const sha of reaped) await deps.blobs.reap(sha).catch(() => undefined);
  return done;
}

/** Release one held send, exactly once. Safe to call any number of times, concurrently. */
export async function releaseOne(deps: ReleaseDeps, id: string): Promise<ReleaseOutcome> {
  const log: Log = deps.log ?? ((): void => undefined);
  const row = await deps.db.pendingSend.findUnique({ where: { id } });
  if (row?.state !== 'held') return 'skipped';

  const draft = row.draftMessageId === null ? null : await deps.db.message.findFirst({ where: { id: row.draftMessageId, mailbox: { accountId: row.accountId } } });
  if (row.draftMessageId !== null && draft === null) {
    return (await finishUnsent(deps, id, 'cancelled', 'the draft was removed')) ? 'cancelled' : 'skipped';
  }
  const bodyText = draft === null ? '' : ((await deps.db.messageSearch.findUnique({ where: { messageId: draft.id }, select: { bodyText: true } }))?.bodyText ?? '');

  const addresses = await sendableAddresses(deps.db, row.accountId);
  const storage = { blobs: deps.blobs, kek: deps.kek() };
  let filed: { id: string; mailboxId: string } | null = null;
  const reaped: string[] = [];
  let outcome;
  try {
    outcome = await acceptSubmission(
      await deps.blobs.get(row.heldBlobSha256),
      {
        submitter: { accountId: row.accountId, addresses: new Set(addresses) },
        envelopeFrom: row.envelopeFrom,
        recipients: row.recipients.map((address) => ({ address })),
        sessionId: `pending:${row.id}`,
        submittedVia: 'webmail',
        enforceCaps: (tx, recipients, at) => deps.caps(tx, row.accountId, recipients, at),
        auditContext: { requestId: `pending-send:${row.id}` },
        withinTransaction: async (tx, accepted) => {
          const now = deps.now();
          // The exactly-once gate: commits with the queue rows, or not at all.
          const n = await tx.pendingSend.updateMany({ where: { id: row.id, state: 'held' }, data: { state: 'released', finishedAt: now, outboundId: accepted.outboundId } });
          if (n.count === 0) throw new AlreadyHandled();
          let draftRemoved: string | null = null;
          if (row.draftMessageId !== null) {
            const current = await tx.message.findFirst({ where: { id: row.draftMessageId, mailbox: { accountId: row.accountId } } });
            if (current === null) throw new DraftGone();
            const sha = await removeMessage(tx, deps.blobs, current);
            if (sha !== null) reaped.push(sha);
            draftRemoved = current.id;
          }
          const copy = await fileCopy(tx, {
            accountId: row.accountId,
            mailboxName: await specialMailboxName(tx, row.accountId, 'sent'),
            blobSha256: accepted.blobSha256,
            size: accepted.size,
            flags: SENT_FLAGS,
            denorm: {
              messageIdHeader: accepted.messageId,
              subject: row.subject,
              fromAddress: row.envelopeFrom,
              to: row.toText,
              sentAt: now,
              inReplyTo: row.inReplyTo,
              references: row.references,
              bodyText,
            },
            now,
            takeReference: true,
          });
          filed = copy;
          const released = await deps.blobs.release(row.heldBlobSha256, tx);
          if (released.refcount === 0) reaped.push(row.heldBlobSha256);
          let reminderId: string | null = null;
          if (row.remindAfterSeconds !== null) {
            reminderId = (
              await tx.replyReminder.create({
                data: {
                  accountId: row.accountId,
                  sentMessageId: copy.id,
                  messageIdHeader: accepted.messageId.replace(/^<|>$/g, ''),
                  sentAt: now,
                  dueAt: new Date(now.getTime() + row.remindAfterSeconds * 1000),
                },
                select: { id: true },
              })
            ).id;
          }
          await tx.pendingSend.update({ where: { id: row.id }, data: { sentMessageId: copy.id } });
          await audit(tx, 'compose.release', row.id, row.accountId, {
            state: 'released',
            kind: row.kind,
            releaseAt: row.releaseAt.toISOString(),
            outboundId: accepted.outboundId,
            messageId: accepted.messageId,
            sentMessageId: copy.id,
            draftRemoved,
            reminderId,
          });
        },
      },
      { db: deps.db, storage: () => storage, now: deps.now, log, ...(deps.beforeCommit === undefined ? {} : { beforeCommit: deps.beforeCommit }) },
    );
  } catch (error) {
    if (error instanceof AlreadyHandled) return 'skipped';
    if (error instanceof DraftGone) return (await finishUnsent(deps, id, 'cancelled', 'the draft was removed')) ? 'cancelled' : 'skipped';
    throw error;
  }
  if (!outcome.ok) {
    log('pending-send-refused', { id, reason: outcome.reason });
    return (await finishUnsent(deps, id, 'failed', `${outcome.reason}: ${outcome.reply.lines.join(' ')}`)) ? 'failed' : 'skipped';
  }
  for (const sha of reaped) await deps.blobs.reap(sha).catch(() => undefined);
  const sent = filed as { id: string; mailboxId: string } | null;
  if (sent !== null) {
    try {
      await assignThread(deps.db, {
        accountId: row.accountId,
        messageId: sent.id,
        messageIdHeader: outcome.messageId,
        ...(row.inReplyTo === null ? {} : { inReplyTo: row.inReplyTo }),
        references: row.references,
        subject: row.subject,
        from: row.envelopeFrom,
        to: row.toText,
        date: deps.now(),
      });
    } catch (error) {
      // Queued and in Sent; the thread sweep threads what this could not.
      log('pending-send-thread-failed', { id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  log('pending-send-released', { id, outboundId: outcome.outboundId });
  return 'released';
}

/** Every held send due by now, soonest first (bounded per pass; the next tick goes on). */
export async function releaseDue(deps: ReleaseDeps, batch = 100): Promise<Record<ReleaseOutcome, number>> {
  const counts: Record<ReleaseOutcome, number> = { released: 0, cancelled: 0, failed: 0, skipped: 0 };
  const due = await deps.db.pendingSend.findMany({ where: { state: 'held', releaseAt: { lte: deps.now() } }, orderBy: { releaseAt: 'asc' }, take: batch, select: { id: true } });
  for (const { id } of due) {
    try {
      counts[await releaseOne(deps, id)]++;
    } catch (error) {
      // Still held: the next tick tries again.
      deps.log?.('pending-send-error', { id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return counts;
}
