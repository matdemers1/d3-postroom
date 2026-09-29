// Sorting corrections (PST-T-14.9, PST-ADR-011): the database half. A correction, in one
// transaction the route wraps in audited():
//
//   1. records a sender preference — a sender_pin on the From address, or on "@domain" — which the
//      worker's classify stage honours for new mail (address first, then domain);
//   2. moves the message to the bucket's mailbox (INBOX with $Priority/$People, a bucket folder, or
//      Junk) through the same updateMessage every web move uses, so the IMAP view, the SSE stream
//      and the Bayes training event (PST-REQ-104) all follow;
//   3. updates the message's stored verdict to the new bucket and ADDS a reason line saying why —
//      the stored reasons stay the whole story (PST-ADR-007), nothing is recomputed;
//   4. writes a sorting_correction row holding what Undo needs.
//
// Undo reverses both halves when it safely can: the preference goes back to what it was unless a
// later choice has replaced it, and the message goes back unless it has moved on since. The row is
// kept and marked undone — never deleted (no silent deletion).
import { BUCKET_FOLDERS, domainPreferenceKey, normalizeAddress, PEOPLE_KEYWORD, prefersDomain, PRIORITY_KEYWORD, type FilingBucket } from '@postroom/classifier';
import { SpecialUse, type Prisma, type SortingCorrection } from '@postroom/db';
import { findOwnMessage, summaryJson, updateMessage } from '../mail/store.js';
import type { SortingCorrectionJson } from './schemas.js';
import type { MessageSummaryJson } from '../mail/schemas.js';

type Tx = Prisma.TransactionClient;

const INBOX_KEYWORDS = [PRIORITY_KEYWORD, PEOPLE_KEYWORD] as const;

export const BUCKET_LABEL: Readonly<Record<FilingBucket, string>> = {
  priority: 'Priority',
  people: 'People',
  newsletters: 'Newsletters',
  updates: 'Updates',
  receipts: 'Receipts',
  notifications: 'Notifications',
  junk: 'Junk',
};

/** A refusal the route turns into a 4xx with this code and message. */
export class CorrectionRefused extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function correctionJson(row: SortingCorrection): SortingCorrectionJson {
  return {
    id: row.id,
    scope: row.scope === 'domain' ? 'domain' : 'sender',
    target: row.target,
    fromBucket: row.fromBucket,
    toBucket: row.toBucket,
    messageId: row.messageId,
    moved: row.fromMailboxId !== null,
    subject: row.subject,
    fromAddress: row.fromAddress,
    source: row.source === 'card' ? 'card' : 'chip',
    createdAt: row.createdAt.toISOString(),
    undoneAt: row.undoneAt === null ? null : row.undoneAt.toISOString(),
  };
}

/** The mailbox a bucket files into for this account, or null when the account has none. */
export async function mailboxForBucket(tx: Tx, accountId: string, bucket: FilingBucket): Promise<{ id: string } | null> {
  if (bucket === 'priority' || bucket === 'people') return tx.mailbox.findFirst({ where: { accountId, specialUse: SpecialUse.inbox }, select: { id: true } });
  if (bucket === 'junk') return tx.mailbox.findFirst({ where: { accountId, specialUse: SpecialUse.junk }, select: { id: true } });
  return tx.mailbox.findFirst({ where: { accountId, name: BUCKET_FOLDERS[bucket], specialUse: null }, select: { id: true } });
}

/** The flag change that puts a copy in `bucket`: INBOX's keyword on, the other one off. */
export function keywordChange(bucket: FilingBucket): { add: string[]; remove: string[] } {
  if (bucket === 'priority') return { add: [PRIORITY_KEYWORD], remove: [PEOPLE_KEYWORD] };
  if (bucket === 'people') return { add: [PEOPLE_KEYWORD], remove: [PRIORITY_KEYWORD] };
  return { add: [], remove: [...INBOX_KEYWORDS] };
}

/** The reason line a correction adds to the message's stored verdict. */
export function correctionReason(target: string, bucket: FilingBucket): string {
  return `corrected: you put this in ${BUCKET_LABEL[bucket]}, and ${target.startsWith('@') ? `mail from ${target.slice(1)}` : `mail from ${target}`} now goes there too`;
}

export interface CorrectionInput {
  accountId: string;
  messageId: string;
  bucket: FilingBucket;
  scope: 'sender' | 'domain';
  source: 'chip' | 'card';
}

export interface CorrectionOutcome {
  row: SortingCorrection;
  message: MessageSummaryJson;
  before: { pin: string | null; pinRow: boolean; mailboxId: string; flags: string[]; bucket: string | null };
}

export async function createCorrection(tx: Tx, input: CorrectionInput): Promise<CorrectionOutcome> {
  const message = await findOwnMessage(tx, input.accountId, input.messageId);
  if (message === null) throw new CorrectionRefused(404, 'not_found', 'no such message');
  const from = message.fromAddress;
  if (from === null || from.trim() === '' || !from.includes('@')) throw new CorrectionRefused(400, 'no_sender', 'this message has no sender address to record a preference for');
  let target: string;
  if (input.scope === 'domain') {
    const key = domainPreferenceKey(from);
    if (key === null || !prefersDomain(from, input.bucket)) {
      throw new CorrectionRefused(400, 'invalid_request', 'a domain preference is only for automated buckets, and never for a mailbox provider’s domain');
    }
    target = key;
  } else {
    target = normalizeAddress(from);
  }

  const destination = await mailboxForBucket(tx, input.accountId, input.bucket);
  if (destination === null) throw new CorrectionRefused(409, 'no_mailbox', `this account has no ${BUCKET_LABEL[input.bucket]} mailbox`);

  // 1. The preference.
  const prior = await tx.senderPin.findUnique({ where: { accountId_address: { accountId: input.accountId, address: target } } });
  await tx.senderPin.upsert({
    where: { accountId_address: { accountId: input.accountId, address: target } },
    create: { accountId: input.accountId, address: target, bucket: input.bucket },
    update: { bucket: input.bucket },
  });

  // 2. The move (or only the keyword change, inside INBOX; or nothing, when it is already there).
  const change = await updateMessage(tx, {
    accountId: input.accountId,
    messageId: message.id,
    ifMatch: '*',
    ...keywordChange(input.bucket),
    moveTo: destination.id,
  });
  if (change === null) throw new CorrectionRefused(404, 'not_found', 'no such message');
  const moved = change.before.mailboxId !== change.after.mailboxId || change.before.flags.join(' ') !== change.after.flags.join(' ');

  // 3. The stored verdict: the new bucket, and one more reason saying why.
  const reason = correctionReason(target, input.bucket);
  const verdict = await tx.messageVerdict.findUnique({ where: { messageId: change.after.id } });
  if (verdict === null) {
    await tx.messageVerdict.create({ data: { messageId: change.after.id, bucket: input.bucket, reasons: [reason] } });
  } else {
    await tx.messageVerdict.update({ where: { messageId: change.after.id }, data: { bucket: input.bucket, reasons: [...verdict.reasons.filter((r) => r !== reason), reason] } });
  }

  // 4. The row Settings → Rules lists.
  const row = await tx.sortingCorrection.create({
    data: {
      accountId: input.accountId,
      scope: input.scope,
      target,
      fromBucket: message.verdict?.bucket ?? null,
      toBucket: input.bucket,
      messageId: change.after.id,
      fromMailboxId: moved ? change.before.mailboxId : null,
      fromFlags: change.before.flags,
      subject: message.subject,
      fromAddress: normalizeAddress(from),
      previousPin: prior?.bucket ?? null,
      previousPinRow: prior !== null,
      reason,
      source: input.source,
    },
  });

  const after = await findOwnMessage(tx, input.accountId, change.after.id);
  if (after === null) throw new CorrectionRefused(404, 'not_found', 'no such message');
  return {
    row,
    message: summaryJson(after),
    before: { pin: prior?.bucket ?? null, pinRow: prior !== null, mailboxId: change.before.mailboxId, flags: change.before.flags, bucket: message.verdict?.bucket ?? null },
  };
}

export async function listCorrections(db: Tx | { sortingCorrection: Tx['sortingCorrection'] }, accountId: string): Promise<SortingCorrection[]> {
  return db.sortingCorrection.findMany({ where: { accountId, undoneAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 });
}

export interface UndoOutcome {
  row: SortingCorrection;
  movedBack: boolean;
  preferenceRestored: boolean;
  message: MessageSummaryJson | null;
}

export async function undoCorrection(tx: Tx, accountId: string, id: string, now: Date): Promise<UndoOutcome> {
  const row = await tx.sortingCorrection.findFirst({ where: { id, accountId } });
  if (row === null) throw new CorrectionRefused(404, 'not_found', 'no such correction');
  if (row.undoneAt !== null) throw new CorrectionRefused(409, 'already_undone', 'this correction was already undone');

  // The preference: put back what was there, unless a later choice has replaced this one.
  let preferenceRestored = false;
  const pin = await tx.senderPin.findUnique({ where: { accountId_address: { accountId, address: row.target } } });
  if (pin !== null && pin.bucket === row.toBucket) {
    if (row.previousPinRow) {
      await tx.senderPin.update({ where: { id: pin.id }, data: { bucket: row.previousPin } });
    } else if (pin.screen === null && pin.unsubscribedAt === null) {
      await tx.senderPin.delete({ where: { id: pin.id } });
    } else {
      await tx.senderPin.update({ where: { id: pin.id }, data: { bucket: null } });
    }
    preferenceRestored = true;
  }

  // The message: back where it came from, if it is still where the correction put it.
  let movedBack = false;
  let message: MessageSummaryJson | null = null;
  const current = row.messageId === null ? null : await findOwnMessage(tx, accountId, row.messageId);
  if (current !== null) {
    let messageId = current.id;
    if (row.fromMailboxId !== null && (await tx.mailbox.findFirst({ where: { id: row.fromMailboxId, accountId }, select: { id: true } })) !== null) {
      const restore = row.fromFlags.filter((f) => (INBOX_KEYWORDS as readonly string[]).includes(f));
      const change = await updateMessage(tx, {
        accountId,
        messageId: current.id,
        ifMatch: '*',
        add: restore,
        remove: INBOX_KEYWORDS.filter((k) => !restore.includes(k)),
        moveTo: row.fromMailboxId,
      });
      if (change !== null) {
        messageId = change.after.id;
        movedBack = true;
      }
    }
    const verdict = await tx.messageVerdict.findUnique({ where: { messageId } });
    if (verdict !== null) {
      await tx.messageVerdict.update({ where: { messageId }, data: { bucket: row.fromBucket, reasons: verdict.reasons.filter((r) => r !== row.reason) } });
    }
    const after = await findOwnMessage(tx, accountId, messageId);
    message = after === null ? null : summaryJson(after);
  }

  const updated = await tx.sortingCorrection.update({ where: { id: row.id }, data: { undoneAt: now, ...(message === null ? {} : { messageId: message.id }) } });
  return { row: updated, movedBack, preferenceRestored, message };
}
