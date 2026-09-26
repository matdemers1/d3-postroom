// The mailbox writes the scheduled loop makes (PST-T-9.1), under the same IMAP rules every other
// writer follows (apps/imap/src/store.ts, the retention sweep, the composer's store): a new row takes
// uid = uidnext and modseq = highestModseq + 1 under the mailbox row lock; a removal or a move-out
// records its UID in expunged_message with a fresh modseq (QRESYNC VANISHED); every changed mailbox
// is pg_notify'd inside the transaction, so IMAP IDLE and the webmail see it the moment it commits.
import { randomInt } from 'node:crypto';
import type { BlobStore } from '@postroom/blobstore';
import { randomUidValidity, SpecialUse, type Db, type Prisma } from '@postroom/db';
import { fileLocalMessage } from '@postroom/dsn';
import { indexMessage } from '@postroom/search';
import { normalizeMsgId } from '@postroom/threading';

export type Tx = Prisma.TransactionClient;

/** The channel IMAP IDLE sessions and the webmail's SSE listen on. */
export const MAILBOX_CHANNEL = 'postroom_mailbox';
/** Where a snoozed conversation waits (apps/api/src/mail/snooze.ts creates it). */
export const SNOOZED_MAILBOX = 'Snoozed';

export async function notifyMailbox(tx: Tx | Db, mailboxId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${MAILBOX_CHANNEL}, ${mailboxId})`;
}

/** Find (or create) a mailbox by name. */
export async function ensureMailbox(tx: Tx, accountId: string, name: string, specialUse: SpecialUse | null): Promise<string> {
  await tx.$executeRaw`
    INSERT INTO mailbox (account_id, name, special_use, uidvalidity)
    VALUES (${accountId}::uuid, ${name}, ${specialUse}::special_use, ${randomUidValidity(randomInt)})
    ON CONFLICT (account_id, name) DO NOTHING`;
  const row = await tx.mailbox.findUniqueOrThrow({ where: { accountId_name: { accountId, name } }, select: { id: true } });
  return row.id;
}

/** The account's special-use mailbox (by use, then by its usual name), created if it has none. */
export async function specialMailbox(tx: Tx, accountId: string, use: 'inbox' | 'sent' | 'drafts'): Promise<string> {
  const found = await tx.mailbox.findFirst({ where: { accountId, specialUse: SpecialUse[use] }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  if (found !== null) return found.id;
  const name = use === 'inbox' ? 'INBOX' : use === 'sent' ? 'Sent' : 'Drafts';
  return ensureMailbox(tx, accountId, name, SpecialUse[use]);
}

interface Locked {
  uidnext: number;
  highestModseq: bigint;
}

/** Lock mailboxes in id order (the IMAP store's order), so this never deadlocks with a client. */
export async function lockMailboxes(tx: Tx, ids: readonly string[]): Promise<Map<string, Locked>> {
  const unique = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<{ id: string; uidnext: number; highest_modseq: bigint }[]>`
    SELECT id::text AS id, uidnext, highest_modseq FROM mailbox WHERE id = ANY(${unique}::uuid[]) ORDER BY id FOR UPDATE`;
  return new Map(rows.map((r) => [r.id, { uidnext: r.uidnext, highestModseq: r.highest_modseq }]));
}

/** The denormalised columns lists and search read. */
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

/**
 * File an existing blob as one more message in a mailbox (one more reference on the blob when
 * `takeReference`), with its denormalised columns and search row. Inside the caller's transaction.
 */
export async function fileCopy(
  tx: Tx,
  input: { accountId: string; mailboxName: string; blobSha256: string; size: number; flags: readonly string[]; denorm: Denorm; now: Date; takeReference: boolean; threadId?: string | null },
): Promise<{ id: string; mailboxId: string; uid: number }> {
  if (input.takeReference) {
    // The blob store's own lock, so no concurrent release() can drop the row between here and the insert.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-blob:' + input.blobSha256}, 0))`;
    await tx.blob.update({ where: { sha256: input.blobSha256 }, data: { refcount: { increment: 1 } } });
  }
  const filed = await fileLocalMessage(tx, { accountId: input.accountId, mailbox: input.mailboxName, blobSha256: input.blobSha256, size: input.size, internalDate: input.now, flags: [...input.flags] });
  const d = input.denorm;
  const own = normalizeMsgId(d.messageIdHeader);
  const irt = d.inReplyTo === null ? '' : normalizeMsgId(d.inReplyTo);
  await tx.message.update({
    where: { id: filed.id },
    data: {
      messageIdHeader: own === '' ? null : own,
      subject: d.subject,
      fromAddress: d.fromAddress,
      sentAt: d.sentAt,
      inReplyTo: irt === '' ? null : irt,
      references: d.references.map(normalizeMsgId).filter((r) => r !== ''),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    },
  });
  await indexMessage(tx, { messageId: filed.id, accountId: input.accountId, subject: d.subject, from: d.fromAddress, to: d.to, bodyText: d.bodyText });
  await notifyMailbox(tx, filed.mailboxId);
  return { id: filed.id, mailboxId: filed.mailboxId, uid: filed.uid };
}

/**
 * Remove one message row the way EXPUNGE does: a fresh modseq, its UID in expunged_message, one
 * reference released on its blob. Returns the sha when that was the blob's last reference (reap
 * the file after the commit).
 */
export async function removeMessage(tx: Tx, blobs: Pick<BlobStore, 'release'>, message: { id: string; mailboxId: string; uid: number; blobSha256: string }): Promise<string | null> {
  const rows = await tx.$queryRaw<{ highest_modseq: bigint }[]>`SELECT highest_modseq FROM mailbox WHERE id = ${message.mailboxId}::uuid FOR UPDATE`;
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
 * Re-home `messageIds` still in `sourceId` into `targetId` — the IMAP MOVE the retention sweep
 * makes: each row keeps its id, takes a new UID from the target, one new modseq for both mailboxes,
 * an expunged_message row per source UID, and a notify on both. `clearSeen` drops \Seen on the way.
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

/** The name of the account's special-use mailbox (fileLocalMessage creates it, with the use, if absent). */
export async function specialMailboxName(tx: Tx | Db, accountId: string, use: 'inbox' | 'sent' | 'drafts'): Promise<string> {
  const mb = await tx.mailbox.findFirst({ where: { accountId, specialUse: SpecialUse[use] }, select: { name: true }, orderBy: { createdAt: 'asc' } });
  return mb?.name ?? (use === 'inbox' ? 'INBOX' : use === 'sent' ? 'Sent' : 'Drafts');
}
