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
// PST-T-12.7 (PST-REQ-161): an encrypted send with Bcc holds several copies (pending_send_copy): the
// main copy for the To/Cc envelope, one per Bcc recipient, and — only when there is no main copy — the
// one Sent keeps. The first sendable copy is the accepting one; every other copy is accepted through
// the same submission path INSIDE its transaction (a savepoint per copy; see nestedDb), each to its
// own envelope. PST-T-9.6: those copies' post-commit effects (the 'accepted' log line, the contact
// harvest) are collected and run only after the release commits, against the real database, so a
// harvest error can never abort the release; a cap refusal's alert runs only after the release's
// transaction — and so the caps advisory lock — has ended. All of them are queued with the held → released transition, or none are: a refusal
// of any copy rolls the whole release back and fails it. Sent keeps the main copy (or the 'sent'
// one), once. A row with no copies (any other send, and every row made before copies existed) is
// released from heldBlobSha256 exactly as before.
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

/** Deferred effects run one by one; a failure is logged and never changes the release's outcome. */
async function runEffects(effects: readonly (() => Promise<void>)[], log: Log, id: string): Promise<void> {
  for (const effect of effects) {
    try {
      await effect();
    } catch (error) {
      log('pending-send-effect-failed', { id, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export type ReleaseOutcome = 'released' | 'cancelled' | 'failed' | 'skipped';

class AlreadyHandled extends Error {}
class DraftGone extends Error {}
/** A copy of a multi-copy send the submission path refused: the whole release rolls back. */
class CopyRefused extends Error {
  constructor(
    readonly reason: string,
    readonly lines: readonly string[],
    readonly recipients: readonly string[],
  ) {
    super(`copy refused: ${reason}`);
  }
}

type CopyRow = Awaited<ReturnType<Db['pendingSendCopy']['findMany']>>[number];

/**
 * The accepting transaction, seen as a database handle whose $transaction is a savepoint inside it:
 * what lets acceptSubmission accept a further copy (its checks, DKIM signature, queue rows, audit
 * row) as part of the transaction already open, rather than committing on its own. A savepoint
 * rolls back only its own writes when the callback throws, so a failure in there (the contact
 * harvest's, say) never aborts the release around it. Savepoints nest; one name serves them all
 * (Postgres releases or rolls back to the most recent of that name).
 */
export function nestedDb(tx: Prisma.TransactionClient): Db {
  const transaction = async (fn: unknown): Promise<unknown> => {
    if (typeof fn !== 'function') throw new Error('only an interactive transaction can nest in a release');
    await tx.$executeRaw`SAVEPOINT postroom_release_copy`;
    try {
      const result: unknown = await (fn as (t: Prisma.TransactionClient) => Promise<unknown>)(tx);
      await tx.$executeRaw`RELEASE SAVEPOINT postroom_release_copy`;
      return result;
    } catch (error) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT postroom_release_copy`;
      await tx.$executeRaw`RELEASE SAVEPOINT postroom_release_copy`;
      throw error;
    }
  };
  return new Proxy(tx, { get: (target, prop, receiver): unknown => (prop === '$transaction' ? transaction : (Reflect.get(target, prop, receiver) as unknown)) }) as unknown as Db;
}

/** Every blob reference a pending send holds: the held blob's, and each copy's. */
async function releaseHeldBlobs(tx: Prisma.TransactionClient, blobs: BlobStore, held: string, copies: readonly { blobSha256: string }[], reaped: string[]): Promise<void> {
  for (const sha of [held, ...copies.map((c) => c.blobSha256)]) {
    const released = await blobs.release(sha, tx);
    if (released.refcount === 0) reaped.push(sha);
  }
}

/** One audit row per release attempt's outcome, as the system (on the account's behalf). */
async function audit(tx: Tx | Db, action: string, pendingId: string, accountId: string, after: Record<string, unknown>): Promise<void> {
  await recordAudit(tx, { actor: ACTOR, action, entityType: 'pending_send', entityId: pendingId, before: { state: 'held' }, after: { accountId, ...after } });
}

/** Terminal, not-sent: held → cancelled | failed, every blob reference it holds released. */
async function finishUnsent(deps: ReleaseDeps, id: string, state: 'cancelled' | 'failed', reason: string): Promise<boolean> {
  const reaped: string[] = [];
  const done = await deps.db.$transaction(async (tx) => {
    const row = await tx.pendingSend.findUnique({ where: { id } });
    if (row === null) return false;
    const n = await tx.pendingSend.updateMany({ where: { id, state: 'held' }, data: { state, reason, finishedAt: deps.now() } });
    if (n.count === 0) return false;
    const copies = await tx.pendingSendCopy.findMany({ where: { pendingSendId: id }, select: { blobSha256: true } });
    await releaseHeldBlobs(tx, deps.blobs, row.heldBlobSha256, copies, reaped);
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
  // PST-T-12.7: the copies, if this send has them; the first sendable one is the accepting one.
  const copies: CopyRow[] = await deps.db.pendingSendCopy.findMany({ where: { pendingSendId: row.id }, orderBy: { position: 'asc' } });
  const sendable = copies.filter((c) => c.role !== 'sent');
  const sentCopy = copies.find((c) => c.role === 'sent') ?? null;
  const primary = sendable[0] ?? null;
  if (copies.length > 0 && primary === null) {
    return (await finishUnsent(deps, id, 'failed', 'the held send has no copy to send')) ? 'failed' : 'skipped';
  }
  const later = sendable.slice(1);
  const submitter = { accountId: row.accountId, addresses: new Set(addresses) };
  const auditContext = { requestId: `pending-send:${row.id}` };
  let filed: { id: string; mailboxId: string } | null = null;
  const reaped: string[] = [];
  // PST-T-9.6: the further copies' post-commit effects, and any cap-refusal alert, held until the
  // release's transaction has ended (see DeferredEffects in @postroom/submission).
  const afterCommit: (() => Promise<void>)[] = [];
  const afterEnd: (() => Promise<void>)[] = [];
  const deferred = { db: deps.db, afterCommit: (fn: () => Promise<void>): void => void afterCommit.push(fn), afterEnd: (fn: () => Promise<void>): void => void afterEnd.push(fn) };
  let outcome;
  try {
    outcome = await acceptSubmission(
      await deps.blobs.get(primary?.blobSha256 ?? row.heldBlobSha256),
      {
        submitter,
        envelopeFrom: row.envelopeFrom,
        recipients: (primary?.recipients ?? row.recipients).map((address) => ({ address })),
        sessionId: `pending:${row.id}`,
        submittedVia: 'webmail',
        // With copies, the accepting one checks the cap for the whole send (as a send that goes now does).
        enforceCaps: (tx, recipients, at) => deps.caps(tx, row.accountId, primary === null ? recipients : row.recipients, at),
        auditContext,
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
          // Every other copy, in this same transaction, each to its own envelope (PST-T-12.7).
          const copyOutbound: { role: string; recipients: number; outboundId: string | null }[] = [];
          if (primary !== null) {
            await tx.pendingSendCopy.update({ where: { id: primary.id }, data: { outboundId: accepted.outboundId } });
            copyOutbound.push({ role: primary.role, recipients: primary.recipients.length, outboundId: accepted.outboundId });
          }
          for (const c of later) {
            const got = await acceptSubmission(
              await deps.blobs.get(c.blobSha256),
              {
                submitter,
                envelopeFrom: row.envelopeFrom,
                recipients: c.recipients.map((address) => ({ address })),
                sessionId: `pending:${row.id}:${String(c.position)}`,
                submittedVia: 'webmail',
                enforceCaps: (ctx, recipients, at) => deps.caps(ctx, row.accountId, recipients, at),
                auditContext,
                withinTransaction: async (ctx, copyAccepted) => {
                  await ctx.pendingSendCopy.update({ where: { id: c.id }, data: { outboundId: copyAccepted.outboundId } });
                },
              },
              { db: nestedDb(tx), storage: () => storage, now: deps.now, log, deferred },
            );
            if (!got.ok) throw new CopyRefused(got.reason, got.reply.lines, c.recipients);
            copyOutbound.push({ role: c.role, recipients: c.recipients.length, outboundId: got.outboundId });
          }
          // Sent keeps the main copy as queued — or, with no main copy, the one held for Sent.
          const copy = await fileCopy(tx, {
            accountId: row.accountId,
            mailboxName: await specialMailboxName(tx, row.accountId, 'sent'),
            blobSha256: sentCopy?.blobSha256 ?? accepted.blobSha256,
            size: sentCopy?.size ?? accepted.size,
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
          await releaseHeldBlobs(tx, deps.blobs, row.heldBlobSha256, copies, reaped);
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
            ...(copies.length === 0 ? {} : { copies: copyOutbound }),
          });
        },
      },
      { db: deps.db, storage: () => storage, now: deps.now, log, ...(deps.beforeCommit === undefined ? {} : { beforeCommit: deps.beforeCommit }) },
    );
  } catch (error) {
    // Rolled back: nothing the copies queued exists, so nothing of theirs is announced; an alert still goes, now that the lock is gone.
    await runEffects(afterEnd, log, id);
    if (error instanceof AlreadyHandled) return 'skipped';
    if (error instanceof DraftGone) return (await finishUnsent(deps, id, 'cancelled', 'the draft was removed')) ? 'cancelled' : 'skipped';
    if (error instanceof CopyRefused) {
      log('pending-send-copy-refused', { id, reason: error.reason });
      return (await finishUnsent(deps, id, 'failed', `${error.reason} (the copy for ${error.recipients.join(', ')}): ${error.lines.join(' ')}; nothing was sent`)) ? 'failed' : 'skipped';
    }
    throw error;
  }
  // The accepting transaction has ended (committed when ok, never begun or rolled back when not).
  await runEffects(afterEnd, log, id);
  if (outcome.ok) await runEffects(afterCommit, log, id);
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
