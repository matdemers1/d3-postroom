// Sender pins and the new-sender screen: the database reads and writes behind the routes
// (PST-T-5.4, PST-REQ-105, PST-REQ-106). Everything is scoped to the caller's account.
import { normalizeAddress, type FilingBucket } from '@postroom/classifier';
import type { Db, Prisma } from '@postroom/db';
import { updateMessage } from '../mail/store.js';
import { unsubscribeStatusOf } from './unsubscribe.js';

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

// --- Sender profile (PST-T-5.6, PST-REQ-113) --------------------------------------------------

export interface SenderProfileMessage {
  id: string;
  subject: string | null;
  date: string;
  bucket: FilingBucket | null;
}

export interface SenderProfileJson {
  address: string;
  messageCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  buckets: { bucket: string; count: number }[];
  recentMessages: SenderProfileMessage[];
  pin: FilingBucket | null;
  screen: 'allow' | 'block' | null;
  unsubscribe: { attempted: boolean; at: string | null; method: string | null; result: string | null; detail: string | null };
  auth: { dkimDomains: string[]; sampleSize: number; dkimPassRate: number | null; spfPassRate: number | null; dmarcPassRate: number | null };
  wroteTo: string[];
}

function rateOf(pass: number, total: number): number | null {
  return total === 0 ? null : Math.round((pass / total) * 100) / 100;
}

/**
 * The sender profile (PST-REQ-113): message history, bucket distribution, pin/screen state,
 * unsubscribe status, an authentication summary across their messages, and the address(es) of ours
 * they wrote to (from the inbound spool's recipient list, which names the account and any masked
 * alias or plus-tag it arrived at). Everything here is scoped to this account's copies.
 */
export async function getSenderProfile(db: Db, accountId: string, address: string): Promise<SenderProfileJson> {
  const normalized = normalizeAddress(address);
  const messages = await db.message.findMany({
    where: { mailbox: { accountId }, fromAddress: { equals: normalized, mode: 'insensitive' } },
    orderBy: { internalDate: 'desc' },
    include: { verdict: { select: { bucket: true, auth: true } }, inbound: { select: { recipients: true } } },
    take: 500,
  });

  const buckets = new Map<string, number>();
  const dkimDomains = new Set<string>();
  const wroteTo = new Set<string>();
  let dkimPass = 0;
  let dkimTotal = 0;
  let spfPass = 0;
  let spfTotal = 0;
  let dmarcPass = 0;
  let dmarcTotal = 0;

  for (const m of messages) {
    const bucket = m.verdict?.bucket ?? null;
    if (bucket !== null) buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);

    const auth = m.verdict?.auth as Record<string, unknown> | undefined;
    if (auth !== undefined) {
      const dkim = Array.isArray(auth['dkim']) ? (auth['dkim'] as Record<string, unknown>[]) : [];
      for (const d of dkim) {
        dkimTotal++;
        if (d['result'] === 'pass') dkimPass++;
        if (typeof d['domain'] === 'string' && d['domain'] !== '') dkimDomains.add(d['domain']);
      }
      const spf = auth['spf'] as Record<string, unknown> | null | undefined;
      if (typeof spf === 'object' && spf !== null) {
        spfTotal++;
        if (spf['result'] === 'pass') spfPass++;
      }
      const dmarc = auth['dmarc'] as Record<string, unknown> | null | undefined;
      if (typeof dmarc === 'object' && dmarc !== null) {
        dmarcTotal++;
        if (dmarc['result'] === 'pass') dmarcPass++;
      }
    }

    const recipients = m.inbound?.recipients;
    if (Array.isArray(recipients)) {
      for (const r of recipients as Record<string, unknown>[]) {
        const accountIds = Array.isArray(r['accountIds']) ? (r['accountIds'] as unknown[]) : [];
        if (!accountIds.includes(accountId)) continue;
        if (typeof r['address'] === 'string' && r['address'] !== '') wroteTo.add(r['address'].toLowerCase());
      }
    }
  }

  const first = messages[messages.length - 1];
  const last = messages[0];
  const [pin, unsubscribe] = await Promise.all([
    db.senderPin.findUnique({ where: { accountId_address: { accountId, address: normalized } }, select: { bucket: true, screen: true } }),
    unsubscribeStatusOf(db, accountId, normalized),
  ]);

  return {
    address: normalized,
    messageCount: messages.length,
    firstSeenAt: first === undefined ? null : first.internalDate.toISOString(),
    lastSeenAt: last === undefined ? null : last.internalDate.toISOString(),
    buckets: [...buckets.entries()].map(([bucket, count]) => ({ bucket, count })),
    recentMessages: messages.slice(0, 20).map((m) => ({ id: m.id, subject: m.subject, date: (m.sentAt ?? m.internalDate).toISOString(), bucket: (m.verdict?.bucket as FilingBucket | null | undefined) ?? null })),
    pin: (pin?.bucket as FilingBucket | null | undefined) ?? null,
    screen: (pin?.screen as 'allow' | 'block' | null | undefined) ?? null,
    unsubscribe,
    auth: {
      dkimDomains: [...dkimDomains].sort(),
      sampleSize: messages.length,
      dkimPassRate: rateOf(dkimPass, dkimTotal),
      spfPassRate: rateOf(spfPass, spfTotal),
      dmarcPassRate: rateOf(dmarcPass, dmarcTotal),
    },
    wroteTo: [...wroteTo].sort(),
  };
}
