// The composer's writes against the database (PST-T-3.11): filing the Sent copy, saving/replacing/
// removing drafts, and threading. Every mailbox write follows the IMAP rules the IMAP server reads
// back — uid = uidnext and modseq = highestModseq + 1 under the mailbox row lock (fileLocalMessage),
// and a removal records its UID in expunged_message with a fresh modseq so QRESYNC clients see it
// VANISH — and ends with pg_notify so other tabs and IMAP IDLE see the change.
import type { BlobStore } from '@postroom/blobstore';
import { SpecialUse, type Db, type Prisma } from '@postroom/db';
import { fileLocalMessage } from '@postroom/dsn';
import { indexMessage } from '@postroom/search';
import { assignThread, normalizeMsgId } from '@postroom/threading';
import { notifyMailbox } from '../mail/store.js';

type Tx = Prisma.TransactionClient;

export const DRAFT_FLAGS = ['\\Draft', '\\Seen'] as const;
export const SENT_FLAGS = ['\\Seen'] as const;

/** The name of the account's special-use mailbox; fileLocalMessage creates it (with the use) if absent. */
export async function specialMailboxName(tx: Tx | Db, accountId: string, use: 'sent' | 'drafts'): Promise<string> {
  const mb = await tx.mailbox.findFirst({
    where: { accountId, specialUse: use === 'sent' ? SpecialUse.sent : SpecialUse.drafts },
    select: { name: true },
    orderBy: { createdAt: 'asc' },
  });
  return mb?.name ?? (use === 'sent' ? 'Sent' : 'Drafts');
}

/** The denormalised columns lists and search read, as the worker writes them for inbound mail. */
export interface Denorm {
  readonly messageIdHeader: string;
  readonly subject: string;
  readonly fromAddress: string;
  readonly to: string;
  readonly sentAt: Date;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly bodyText: string;
}

async function writeDenorm(tx: Tx, accountId: string, messageId: string, d: Denorm): Promise<void> {
  const own = normalizeMsgId(d.messageIdHeader);
  const irt = d.inReplyTo === null ? '' : normalizeMsgId(d.inReplyTo);
  await tx.message.update({
    where: { id: messageId },
    data: {
      messageIdHeader: own === '' ? null : own,
      subject: d.subject,
      fromAddress: d.fromAddress,
      sentAt: d.sentAt,
      inReplyTo: irt === '' ? null : irt,
      references: d.references.map(normalizeMsgId).filter((r) => r !== ''),
    },
  });
  await indexMessage(tx, { messageId, accountId, subject: d.subject, from: d.fromAddress, to: d.to, bodyText: d.bodyText });
}

export interface FiledCopy {
  readonly id: string;
  readonly mailboxId: string;
  readonly uid: number;
}

/**
 * File a blob that already exists as one more message: one more reference on the blob, then the
 * row. Inside the caller's transaction (the accepting one, for a Sent copy).
 */
export async function fileCopy(
  tx: Tx,
  input: { accountId: string; use: 'sent' | 'drafts'; blobSha256: string; size: number; flags: readonly string[]; denorm: Denorm; now: Date; takeReference: boolean },
): Promise<FiledCopy> {
  if (input.takeReference) {
    // The blob store's own lock, so no concurrent release() can drop the row between here and the insert.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-blob:' + input.blobSha256}, 0))`;
    await tx.blob.update({ where: { sha256: input.blobSha256 }, data: { refcount: { increment: 1 } } });
  }
  const mailbox = await specialMailboxName(tx, input.accountId, input.use);
  const filed = await fileLocalMessage(tx, {
    accountId: input.accountId,
    mailbox,
    blobSha256: input.blobSha256,
    size: input.size,
    internalDate: input.now,
    flags: [...input.flags],
  });
  await writeDenorm(tx, input.accountId, filed.id, input.denorm);
  await notifyMailbox(tx, filed.mailboxId);
  return { id: filed.id, mailboxId: filed.mailboxId, uid: filed.uid };
}

/** One of the caller's drafts: a \Draft message in their Drafts mailbox. */
export async function findOwnDraft(tx: Tx | Db, accountId: string, id: string) {
  return tx.message.findFirst({
    where: { id, flags: { has: '\\Draft' }, mailbox: { accountId, specialUse: SpecialUse.drafts } },
    include: { mailbox: { select: { id: true, name: true } } },
  });
}

/**
 * Remove one message row (a draft being replaced, sent or discarded) the way EXPUNGE does: a fresh
 * modseq on its mailbox, its UID in expunged_message, one reference released on its blob. Returns
 * the blob's sha256 when that was its last reference (the caller reaps the file after the commit).
 */
export async function removeMessage(tx: Tx, blobs: BlobStore, message: { id: string; mailboxId: string; uid: number; blobSha256: string }): Promise<string | null> {
  const rows = await tx.$queryRaw<{ highest_modseq: bigint }[]>`
    SELECT highest_modseq FROM mailbox WHERE id = ${message.mailboxId}::uuid FOR UPDATE`;
  const mb = rows[0];
  if (mb === undefined) throw new Error(`mailbox ${message.mailboxId} vanished`);
  const modseq = mb.highest_modseq + 1n;
  await tx.message.delete({ where: { id: message.id } });
  await tx.mailbox.update({ where: { id: message.mailboxId }, data: { highestModseq: modseq } });
  await tx.expungedMessage.createMany({ data: [{ mailboxId: message.mailboxId, uid: message.uid, modseq }], skipDuplicates: true });
  const released = await blobs.release(message.blobSha256, tx);
  await notifyMailbox(tx, message.mailboxId);
  return released.refcount === 0 ? message.blobSha256 : null;
}

/**
 * Thread the Sent copy (PST-REQ-078): the live inbound path threads what the worker files, but a copy
 * filed here is not seen by it, so it is threaded now. Anything it answers that has never been
 * threaded (mail filed before threading existed, or by a path that does not thread) is threaded
 * first — what the thread sweep would do — so the reply joins the conversation rather than
 * starting one of its own. Returns the Sent copy's thread.
 */
export async function threadSentCopy(
  db: Db,
  input: { accountId: string; messageId: string; messageIdHeader: string; inReplyTo: string | null; references: readonly string[]; subject: string; from: string; to: string; date: Date },
): Promise<string> {
  const keys = [...new Set([...input.references, ...(input.inReplyTo === null ? [] : [input.inReplyTo])].map(normalizeMsgId).filter((k) => k !== ''))];
  if (keys.length > 0) {
    const orphans = await db.message.findMany({
      where: { mailbox: { accountId: input.accountId }, threadId: null, id: { not: input.messageId }, messageIdHeader: { in: [...keys, ...keys.map((k) => `<${k}>`)] } },
      orderBy: [{ sentAt: 'asc' }, { internalDate: 'asc' }],
      select: { id: true, messageIdHeader: true, inReplyTo: true, references: true, subject: true, fromAddress: true, sentAt: true, internalDate: true },
    });
    for (const o of orphans) {
      await assignThread(db, {
        accountId: input.accountId,
        messageId: o.id,
        ...(o.messageIdHeader === null ? {} : { messageIdHeader: o.messageIdHeader }),
        ...(o.inReplyTo === null ? {} : { inReplyTo: o.inReplyTo }),
        references: o.references,
        subject: o.subject ?? '',
        from: o.fromAddress ?? '',
        to: '',
        date: o.sentAt ?? o.internalDate,
      });
    }
  }
  return assignThread(db, {
    accountId: input.accountId,
    messageId: input.messageId,
    messageIdHeader: input.messageIdHeader,
    ...(input.inReplyTo === null ? {} : { inReplyTo: input.inReplyTo }),
    references: [...input.references],
    subject: input.subject,
    from: input.from,
    to: input.to,
    date: input.date,
  });
}

// --- PST-T-9.1: held sends and reminders ----------------------------------------------------------

type PendingRow = {
  id: string;
  kind: string;
  state: string;
  releaseAt: Date;
  draftMessageId: string | null;
  subject: string;
  toText: string;
  messageIdHeader: string;
  remindAfterSeconds: number | null;
  reason: string | null;
  createdAt: Date;
};

/** A pending_send row as the API answers it. */
export function pendingJson(row: PendingRow) {
  return {
    id: row.id,
    kind: row.kind === 'scheduled' ? ('scheduled' as const) : ('undo' as const),
    state: row.state as 'held' | 'released' | 'cancelled' | 'failed',
    releaseAt: row.releaseAt.toISOString(),
    draftId: row.draftMessageId,
    subject: row.subject,
    to: row.toText,
    messageId: row.messageIdHeader,
    remindAfterSeconds: row.remindAfterSeconds,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Cancel a held send (undo, a cancelled schedule, or its draft copy being replaced or discarded).
 * The held → cancelled transition is conditional on `held`, so it serializes with the worker's
 * release on the row lock: exactly one of them wins. The copy in Drafts is left where it is. Returns
 * whether it was cancelled, and the held blob's sha when that was its last reference (reap it after
 * the commit).
 */
export async function cancelHeld(
  tx: Tx,
  blobs: BlobStore,
  input: { id: string; heldBlobSha256: string; reason: string; now: Date },
): Promise<{ cancelled: boolean; reaped: string | null }> {
  const n = await tx.pendingSend.updateMany({ where: { id: input.id, state: 'held' }, data: { state: 'cancelled', reason: input.reason, finishedAt: input.now } });
  if (n.count === 0) return { cancelled: false, reaped: null };
  const released = await blobs.release(input.heldBlobSha256, tx);
  return { cancelled: true, reaped: released.refcount === 0 ? input.heldBlobSha256 : null };
}

/** Cancel whatever held send keeps `draftId` as its Drafts copy (the draft is being replaced or discarded). */
export async function cancelHeldForDraft(tx: Tx, blobs: BlobStore, accountId: string, draftId: string, reason: string, now: Date): Promise<{ ids: string[]; reaped: string[] }> {
  const rows = await tx.pendingSend.findMany({ where: { accountId, draftMessageId: draftId, state: 'held' }, select: { id: true, heldBlobSha256: true } });
  const ids: string[] = [];
  const reaped: string[] = [];
  for (const r of rows) {
    const c = await cancelHeld(tx, blobs, { id: r.id, heldBlobSha256: r.heldBlobSha256, reason, now });
    if (c.cancelled) ids.push(r.id);
    if (c.reaped !== null) reaped.push(c.reaped);
  }
  return { ids, reaped };
}

/** Arm remind-if-no-reply for a message just filed in Sent (PST-REQ-143); the worker checks it at dueAt. */
export async function armReminder(tx: Tx, input: { accountId: string; sentMessageId: string; messageIdHeader: string; sentAt: Date; afterSeconds: number }): Promise<string> {
  const row = await tx.replyReminder.create({
    data: {
      accountId: input.accountId,
      sentMessageId: input.sentMessageId,
      messageIdHeader: normalizeMsgId(input.messageIdHeader),
      sentAt: input.sentAt,
      dueAt: new Date(input.sentAt.getTime() + input.afterSeconds * 1000),
    },
    select: { id: true },
  });
  return row.id;
}
