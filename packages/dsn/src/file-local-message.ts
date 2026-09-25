// Filing one message into a local mailbox, without a protocol round trip: this is how a DSN lands
// in the sender's INBOX (PST-T-1.7), and it is written here — rather than inline in the delivery
// app — so the inbound pipeline (PST-T-2.7) can reuse or replace it with the same UID/MODSEQ rules.
import { randomInt } from 'node:crypto';
import { randomUidValidity, SpecialUse, type Prisma } from '@postroom/db';

export type FileLocalMessageTx = Prisma.TransactionClient;

export interface FileLocalMessageInput {
  readonly accountId: string;
  /** The mailbox's name, e.g. 'INBOX'. Created (with the matching special use, if any) if absent. */
  readonly mailbox: string;
  readonly blobSha256: string;
  readonly size: number;
  readonly internalDate: Date;
  readonly flags?: readonly string[];
}

export interface FiledMessage {
  readonly id: string;
  readonly mailboxId: string;
  readonly uid: number;
  readonly modseq: bigint;
}

/** The special use of one of the seven mailboxes `seed()` creates by name; anything else gets none. */
const SPECIAL_USE_BY_NAME: Readonly<Record<string, SpecialUse>> = {
  INBOX: SpecialUse.inbox,
  Sent: SpecialUse.sent,
  Drafts: SpecialUse.drafts,
  Trash: SpecialUse.trash,
  Junk: SpecialUse.junk,
  Archive: SpecialUse.archive,
  Rejects: SpecialUse.rejects,
};

interface MailboxCursor {
  id: string;
  uidnext: number;
  highestModseq: bigint;
}

/**
 * Locks the mailbox row for the rest of the transaction (creating it first if this account has
 * never had one by this name — an account made outside `seed()`, as every test account is). The
 * row lock is what makes concurrent filings into the same mailbox serialize on uidnext/modseq.
 */
async function lockOrCreateMailbox(tx: FileLocalMessageTx, accountId: string, name: string): Promise<MailboxCursor> {
  const rows = await tx.$queryRaw<{ id: string; uidnext: number; highest_modseq: bigint }[]>`
    SELECT id::text AS id, uidnext, highest_modseq
    FROM mailbox
    WHERE account_id = ${accountId}::uuid AND name = ${name}
    FOR UPDATE`;
  const found = rows[0];
  if (found !== undefined) return { id: found.id, uidnext: found.uidnext, highestModseq: found.highest_modseq };

  const specialUse = SPECIAL_USE_BY_NAME[name];
  const created = await tx.mailbox.create({
    data: {
      accountId,
      name,
      ...(specialUse === undefined ? {} : { specialUse }),
      uidvalidity: randomUidValidity(randomInt),
    },
    select: { id: true, uidnext: true, highestModseq: true },
  });
  return created;
}

/**
 * Files one already-stored blob into `mailbox` as a new Message: locks the mailbox, takes
 * `uid = uidnext` and `modseq = highestModseq + 1`, inserts the row, and advances the mailbox's
 * counters — all inside `tx`, so it commits with (or rolls back with) whatever else the caller does.
 */
export async function fileLocalMessage(tx: FileLocalMessageTx, input: FileLocalMessageInput): Promise<FiledMessage> {
  const mailbox = await lockOrCreateMailbox(tx, input.accountId, input.mailbox);
  const uid = mailbox.uidnext;
  const modseq = mailbox.highestModseq + 1n;

  const message = await tx.message.create({
    data: {
      mailboxId: mailbox.id,
      uid,
      modseq,
      blobSha256: input.blobSha256,
      size: input.size,
      internalDate: input.internalDate,
      flags: [...(input.flags ?? [])],
    },
    select: { id: true, mailboxId: true, uid: true, modseq: true },
  });

  await tx.mailbox.update({
    where: { id: mailbox.id },
    data: { uidnext: uid + 1, highestModseq: modseq },
  });

  return message;
}
