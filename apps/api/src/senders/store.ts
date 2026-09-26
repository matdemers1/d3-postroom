// Sender pins and the new-sender screen: the database reads and writes behind the routes
// (PST-T-5.4, PST-REQ-105, PST-REQ-106). Everything is scoped to the caller's account.
import { normalizeAddress, type FilingBucket } from '@postroom/classifier';
import type { Db, Prisma } from '@postroom/db';
import { updateMessage } from '../mail/store.js';

type Tx = Prisma.TransactionClient;

export interface SenderPinRow {
  address: string;
  bucket: FilingBucket | null;
}

/** This account's pin for `address` (PST-REQ-105) — bucket only; the screen decision is separate. */
export async function getSenderPin(db: Db, accountId: string, address: string): Promise<SenderPinRow> {
  const normalized = normalizeAddress(address);
  const row = await db.senderPin.findUnique({ where: { accountId_address: { accountId, address: normalized } }, select: { bucket: true } });
  return { address: normalized, bucket: (row?.bucket as FilingBucket | null | undefined) ?? null };
}

/** Pin `address` to `bucket` — creates the row, or sets `bucket` on an existing screen-only row. */
export async function setSenderPin(tx: Tx, accountId: string, address: string, bucket: FilingBucket): Promise<SenderPinRow> {
  const normalized = normalizeAddress(address);
  await tx.senderPin.upsert({
    where: { accountId_address: { accountId, address: normalized } },
    create: { accountId, address: normalized, bucket },
    update: { bucket },
  });
  return { address: normalized, bucket };
}

/** Clears the bucket pin. Deletes the row entirely once it carries no screen decision either. */
export async function clearSenderPin(tx: Tx, accountId: string, address: string): Promise<boolean> {
  const normalized = normalizeAddress(address);
  const existing = await tx.senderPin.findUnique({ where: { accountId_address: { accountId, address: normalized } } });
  if (existing === null || existing.bucket === null) return false;
  if (existing.screen === null) {
    await tx.senderPin.delete({ where: { accountId_address: { accountId, address: normalized } } });
  } else {
    await tx.senderPin.update({ where: { accountId_address: { accountId, address: normalized } }, data: { bucket: null } });
  }
  return true;
}

/** Allow or Block from the new-sender badge (PST-REQ-106). */
export async function setSenderScreen(tx: Tx, accountId: string, address: string, decision: 'allow' | 'block'): Promise<void> {
  const normalized = normalizeAddress(address);
  await tx.senderPin.upsert({
    where: { accountId_address: { accountId, address: normalized } },
    create: { accountId, address: normalized, screen: decision },
    update: { screen: decision },
  });
}

/**
 * Clears the $NewSender badge from this sender's already-filed messages, for this account
 * (PST-REQ-106: a screen decision answers the badge, so it should not keep showing). Only messages
 * whose scores carry `newSender` are touched; returns how many were changed.
 */
/** The IMAP keyword the worker sets on a first-time human sender's copy (apps/worker file stage). */
const NEW_SENDER_KEYWORD = '$NewSender';

export async function clearNewSenderBadge(tx: Tx, accountId: string, address: string): Promise<number> {
  const normalized = normalizeAddress(address);
  const candidates = await tx.messageVerdict.findMany({
    where: { message: { mailbox: { accountId } }, scores: { path: ['newSender'], equals: 1 } },
    select: { messageId: true, scores: true, message: { select: { fromAddress: true } } },
  });
  let cleared = 0;
  for (const c of candidates) {
    const from = c.message.fromAddress;
    if (from === null || normalizeAddress(from) !== normalized) continue;
    const scores = { ...((c.scores ?? {}) as Record<string, unknown>) };
    delete scores['newSender'];
    await tx.messageVerdict.update({ where: { messageId: c.messageId }, data: { scores: scores as Prisma.InputJsonValue } });
    // The IMAP keyword too, as a flag change every client sees (modseq bump + notify).
    await updateMessage(tx, { accountId, messageId: c.messageId, ifMatch: '*', add: [], remove: [NEW_SENDER_KEYWORD], moveTo: undefined });
    cleared++;
  }
  return cleared;
}
