// The mail API's reads and writes against the database. Every read is scoped to the caller's
// account; a row owned by anyone else is simply not found (404, never 403).
//
// Writes follow the IMAP rules the IMAP server (PST-P-3) reads back:
//   · a flag change takes modseq = mailbox.highestModseq + 1 and advances the mailbox's counter;
//   · a MOVE is a new row in the target (uid = uidnext, modseq = highestModseq + 1) plus deleting
//     the source row, whose mailbox's highestModseq also advances — the same rules as
//     @postroom/dsn's fileLocalMessage. The blob is not touched: its one reference moves with the
//     message, so the refcount is unchanged. The search row and the verdict follow the new id.
// Each write ends with pg_notify('postroom_mailbox', id) for every mailbox it changed, inside the
// same transaction, so it is delivered exactly when the change commits.
// A move between two sorting buckets also writes a bayes_training_event in that transaction
// (PST-T-5.3, PST-REQ-104) — the same event an IMAP MOVE writes; the worker trains on it.
import type { BlobStore } from '@postroom/blobstore';
import { trainingMove } from '@postroom/classifier';
import type { Db, Message, MessageVerdict, Prisma } from '@postroom/db';
import { collectMessage, parseMailboxes } from '@postroom/mime';
import { detectPhish, type PhishAuthVerdicts, type PhishLink } from '@postroom/phish';
import type { MailboxJson, MessageDetailJson, MessageSummaryJson, PhishJson } from './schemas.js';

export const MAILBOX_CHANNEL = 'postroom_mailbox';

type Tx = Prisma.TransactionClient;

export interface MailboxCounts {
  total: number;
  unseen: number;
}

/** total/unseen per mailbox, one query. Mailboxes with no messages are absent from the map. */
export async function mailboxCounts(db: Db | Tx, mailboxIds: readonly string[]): Promise<Map<string, MailboxCounts>> {
  const out = new Map<string, MailboxCounts>();
  if (mailboxIds.length === 0) return out;
  const rows = await db.$queryRaw<{ mailbox_id: string; total: bigint; unseen: bigint }[]>`
    SELECT mailbox_id::text AS mailbox_id,
           count(*) AS total,
           count(*) FILTER (WHERE NOT ('\\Seen' = ANY(flags))) AS unseen
    FROM message
    WHERE mailbox_id = ANY(${[...mailboxIds]}::uuid[])
    GROUP BY mailbox_id`;
  for (const r of rows) out.set(r.mailbox_id, { total: Number(r.total), unseen: Number(r.unseen) });
  return out;
}

export async function listMailboxes(db: Db, accountId: string): Promise<MailboxJson[]> {
  const rows = await db.mailbox.findMany({ where: { accountId }, orderBy: [{ name: 'asc' }] });
  const counts = await mailboxCounts(
    db,
    rows.map((r) => r.id),
  );
  // INBOX first, then the special-use folders in their seed order, then everything else by name.
  const rank = (special: string | null, name: string): number =>
    name === 'INBOX' ? 0 : special === null ? 100 : 1 + ['sent', 'drafts', 'archive', 'junk', 'trash', 'rejects'].indexOf(special);
  return rows
    .map((m) => ({
      id: m.id,
      name: m.name,
      specialUse: m.specialUse,
      uidvalidity: m.uidvalidity,
      uidnext: m.uidnext,
      highestModseq: m.highestModseq.toString(),
      subscribed: m.subscribed,
      total: counts.get(m.id)?.total ?? 0,
      unseen: counts.get(m.id)?.unseen ?? 0,
    }))
    .sort((a, b) => rank(a.specialUse, a.name) - rank(b.specialUse, b.name) || a.name.localeCompare(b.name));
}

type MessageWithVerdict = Message & { verdict: Pick<MessageVerdict, 'bucket' | 'scores'> | null };

/** True when the classify stage marked this message with the new-sender badge (PST-REQ-106). */
function newSenderOf(scores: MessageVerdict['scores'] | undefined): boolean {
  if (typeof scores !== 'object' || scores === null || Array.isArray(scores)) return false;
  return (scores as Record<string, unknown>)['newSender'] === 1;
}

// --- The Trash clock (PST-T-7.7, PST-REQ-129) ----------------------------------------------------
//
// A message in Trash carries trashedAt (stamped by a database trigger whenever a row enters a Trash
// mailbox, from any surface) and expiresAt = trashedAt + the Trash mailbox's retention days, after
// which the worker's retention sweep expunges it. The days are the mailbox's retention_policy row
// when it has one (null there = kept forever, so no expiresAt), else the built-in Trash default —
// a copy of DEFAULT_RETENTION_DAYS.trash in apps/worker/src/retention/policy.ts; keep them in step.

/** Built-in Trash retention, in days (apps/worker/src/retention/policy.ts). */
export const DEFAULT_TRASH_DAYS = 30;
const DAY_MS = 86_400_000;

/** Retention days per Trash mailbox among `mailboxIds` (null = kept forever). Non-Trash ids are absent. */
export async function trashRetentionDays(db: Db | Tx, mailboxIds: readonly string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const ids = [...new Set(mailboxIds)];
  if (ids.length === 0) return out;
  const rows = await db.mailbox.findMany({
    where: { id: { in: ids }, specialUse: 'trash' },
    select: { id: true, retentionPolicy: { select: { days: true } } },
  });
  for (const r of rows) out.set(r.id, r.retentionPolicy === null ? DEFAULT_TRASH_DAYS : r.retentionPolicy.days);
  return out;
}

/** trashedAt and expiresAt for the JSON; both null outside Trash. */
function trashClock(m: Pick<Message, 'trashedAt'>, trashDays: number | null): { trashedAt: string | null; expiresAt: string | null } {
  if (m.trashedAt === null) return { trashedAt: null, expiresAt: null };
  return {
    trashedAt: m.trashedAt.toISOString(),
    expiresAt: trashDays === null ? null : new Date(m.trashedAt.getTime() + trashDays * DAY_MS).toISOString(),
  };
}

/** `trashDays`: the retention of the message's mailbox when it is a Trash (see trashRetentionDays). */
export function summaryJson(m: MessageWithVerdict, trashDays: number | null = DEFAULT_TRASH_DAYS): MessageSummaryJson {
  return {
    id: m.id,
    mailboxId: m.mailboxId,
    uid: m.uid,
    modseq: m.modseq.toString(),
    threadId: m.threadId,
    subject: m.subject,
    from: m.fromAddress,
    date: (m.sentAt ?? m.internalDate).toISOString(),
    internalDate: m.internalDate.toISOString(),
    size: m.size,
    flags: m.flags,
    bucket: m.verdict?.bucket ?? null,
    ...trashClock(m, trashDays),
    newSender: newSenderOf(m.verdict?.scores),
  };
}

export function detailJson(m: Message & { verdict: MessageVerdict | null }, phish: PhishJson | null = null, trashDays: number | null = DEFAULT_TRASH_DAYS): MessageDetailJson {
  return {
    ...summaryJson(m, trashDays),
    messageIdHeader: m.messageIdHeader,
    inReplyTo: m.inReplyTo,
    references: m.references,
    verdict: m.verdict === null ? null : { bucket: m.verdict.bucket, reasons: m.verdict.reasons, auth: m.verdict.auth },
    phish,
  };
}

// --- Phishing/lookalike warnings (PST-T-6.5, PST-REQ-120) ---------------------------------------
//
// Computed on read, not stored at filing time: the worker's file stage (PST-P-2) already runs
// before this account's reply graph and known-sender history exist for *this* message, and storing
// a verdict there would go stale as the account corresponds with more senders over time (the same
// From address that looks brand-new today is a known sender next month). Computing it on
// GET /messages/:id instead means every read sees the account's current view of the world, at the
// cost of one more blob fetch — acceptable at Postroom's single-account, personal scale.
//
// The stored auth verdicts (message_verdict.auth: spf/dkim/dmarc/arc) are reused as-is; only the
// display name, Reply-To, Return-Path and HTML links need a pass over the message's headers/body.

function headerValue(headers: readonly { name: string; value: string }[], name: string): string | null {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value ?? null;
}

/** A minimal `<a href="...">text</a>` extractor: good enough for a mismatch heuristic, not a renderer. */
function extractLinks(html: string | null): PhishLink[] {
  if (html === null) return [];
  const out: PhishLink[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    const text = (match[4] ?? '').replace(/<[^>]*>/g, '').trim();
    if (href !== '' && text !== '') out.push({ text, href });
  }
  return out;
}

/** Distinct From addresses/domains this account has already received mail from, before `before`. */
export async function knownSenderContext(db: Db, accountId: string, opts: { excludeMessageId: string; before: Date }): Promise<{ addresses: string[]; domains: string[] }> {
  const rows = await db.message.findMany({
    where: { mailbox: { accountId }, fromAddress: { not: null }, id: { not: opts.excludeMessageId }, internalDate: { lt: opts.before } },
    distinct: ['fromAddress'],
    select: { fromAddress: true },
    take: 2000,
  });
  const addresses = rows.map((r) => r.fromAddress).filter((a): a is string => a !== null);
  const domains = [...new Set(addresses.map((a) => a.split('@')[1]?.toLowerCase()).filter((d): d is string => d !== undefined))];
  return { addresses, domains };
}

/** The phishing/lookalike verdict for one message, or null when there is nothing stored to check
 * (no message_verdict — e.g. this account's own Sent copy) or no blob store is configured. */
/**
 * The phishing verdict for a message, or null when it cannot be computed. A side signal: a blob that
 * cannot be read here (moved, re-keyed, or a parse failure) must never take the message detail down
 * with it, so any failure is logged and answers null.
 */
export async function messagePhish(db: Db, blobs: BlobStore | null, accountId: string, message: Message & { verdict: MessageVerdict | null }): Promise<PhishJson | null> {
  try {
    return await computeMessagePhish(db, blobs, accountId, message);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'phish-unavailable', messageId: message.id, error: error instanceof Error ? error.message : String(error) })}\n`);
    return null;
  }
}

async function computeMessagePhish(db: Db, blobs: BlobStore | null, accountId: string, message: Message & { verdict: MessageVerdict | null }): Promise<PhishJson | null> {
  if (message.verdict === null || blobs === null) return null;
  const stream = await blobs.get(message.blobSha256);
  const summary = await collectMessage(stream);
  const headers = summary.headers.fields;
  const fromHeader = headerValue(headers, 'from');
  const fromMailbox = fromHeader === null ? undefined : parseMailboxes(fromHeader)[0];
  const fromAddress = fromMailbox?.address !== undefined && fromMailbox.address !== '' ? fromMailbox.address : (message.fromAddress ?? '');

  const replyToHeader = headerValue(headers, 'reply-to');
  const replyToMailbox = replyToHeader === null ? undefined : parseMailboxes(replyToHeader)[0];

  const context = await knownSenderContext(db, accountId, { excludeMessageId: message.id, before: message.internalDate });

  const result = detectPhish({
    from: { address: fromAddress, displayName: fromMailbox?.name ?? null },
    replyTo: replyToMailbox === undefined ? null : { address: replyToMailbox.address, displayName: replyToMailbox.name },
    returnPath: headerValue(headers, 'return-path'),
    authVerdicts: message.verdict.auth as PhishAuthVerdicts,
    account: { knownSenders: context, contacts: [] }, // CardDAV contacts arrive in PST-P-9.
    subject: message.subject,
    links: extractLinks(summary.html?.text ?? null),
  });
  return result;
}

export async function ownMailbox(db: Db | Tx, accountId: string, id: string): Promise<{ id: string } | null> {
  return db.mailbox.findFirst({ where: { id, accountId }, select: { id: true } });
}

/** One page of a mailbox, newest UID first. The cursor is the last UID of the previous page. */
export async function listMessages(
  db: Db,
  mailboxId: string,
  opts: { cursor: number | undefined; limit: number },
): Promise<{ messages: MessageSummaryJson[]; nextCursor: string | null }> {
  const rows = await db.message.findMany({
    where: { mailboxId, ...(opts.cursor !== undefined ? { uid: { lt: opts.cursor } } : {}) },
    orderBy: { uid: 'desc' },
    take: opts.limit + 1,
    include: { verdict: { select: { bucket: true, scores: true } } },
  });
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  const days = await trashRetentionDays(db, [mailboxId]);
  return { messages: page.map((m) => summaryJson(m, days.get(m.mailboxId) ?? null)), nextCursor: rows.length > opts.limit && last !== undefined ? String(last.uid) : null };
}

export async function findOwnMessage(db: Db | Tx, accountId: string, id: string): Promise<(Message & { verdict: MessageVerdict | null }) | null> {
  return db.message.findFirst({ where: { id, mailbox: { accountId } }, include: { verdict: true } });
}

export async function findOwnThread(db: Db, accountId: string, id: string) {
  const thread = await db.thread.findFirst({ where: { id, accountId } });
  if (thread === null) return null;
  const messages = await db.message.findMany({
    where: { threadId: id, mailbox: { accountId } },
    include: { verdict: { select: { bucket: true, scores: true } } },
  });
  messages.sort((a, b) => (a.sentAt ?? a.internalDate).getTime() - (b.sentAt ?? b.internalDate).getTime() || a.id.localeCompare(b.id));
  return { thread, messages };
}

interface LockedMailbox {
  id: string;
  uidnext: number;
  highestModseq: bigint;
}

async function lockMailbox(tx: Tx, id: string): Promise<LockedMailbox> {
  const rows = await tx.$queryRaw<{ id: string; uidnext: number; highest_modseq: bigint }[]>`
    SELECT id::text AS id, uidnext, highest_modseq FROM mailbox WHERE id = ${id}::uuid FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) throw new Error(`mailbox ${id} vanished`);
  return { id: row.id, uidnext: row.uidnext, highestModseq: row.highest_modseq };
}

export async function notifyMailbox(tx: Db | Tx, mailboxId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_notify(${MAILBOX_CHANNEL}, ${mailboxId})`;
}

export class PreconditionFailed extends Error {
  constructor(readonly current: bigint) {
    super('precondition failed');
  }
}

export interface UpdateInput {
  accountId: string;
  messageId: string;
  /** The modseq the client last saw (If-Match); '*' matches any. */
  ifMatch: bigint | '*';
  add: readonly string[];
  remove: readonly string[];
  /** Target mailbox, already checked to be the caller's. */
  moveTo: string | undefined;
}

export interface UpdateSnapshot {
  id: string;
  mailboxId: string;
  uid: number;
  modseq: string;
  flags: string[];
}

const snap = (m: Pick<Message, 'id' | 'mailboxId' | 'uid' | 'modseq' | 'flags'>): UpdateSnapshot => ({
  id: m.id,
  mailboxId: m.mailboxId,
  uid: m.uid,
  modseq: m.modseq.toString(),
  flags: [...m.flags],
});

/**
 * Flags and/or a move, in the caller's transaction (an audited() one). Returns null when the
 * message is not the caller's, throws PreconditionFailed when If-Match is stale. Locks the source
 * mailbox (and the target, in id order, so two opposite moves cannot deadlock) before reading the
 * message, so the If-Match comparison and the write see the same row.
 */
export async function updateMessage(tx: Tx, input: UpdateInput): Promise<{ before: UpdateSnapshot; after: UpdateSnapshot } | null> {
  const found = await tx.message.findFirst({ where: { id: input.messageId, mailbox: { accountId: input.accountId } }, select: { mailboxId: true } });
  if (found === null) return null;
  const moving = input.moveTo !== undefined && input.moveTo !== found.mailboxId ? input.moveTo : undefined;
  const lockOrder = [found.mailboxId, ...(moving === undefined ? [] : [moving])].sort();
  const locked = new Map<string, LockedMailbox>();
  for (const id of lockOrder) locked.set(id, await lockMailbox(tx, id));

  // Re-read under the lock: a concurrent move may have taken it away since.
  const message = await tx.message.findFirst({ where: { id: input.messageId, mailboxId: found.mailboxId } });
  if (message === null) return null;
  if (input.ifMatch !== '*' && input.ifMatch !== message.modseq) throw new PreconditionFailed(message.modseq);
  const before = snap(message);

  const flags = message.flags.filter((f) => !input.remove.includes(f));
  for (const f of input.add) if (!flags.includes(f) && !input.remove.includes(f)) flags.push(f);
  const flagsChanged = flags.length !== message.flags.length || flags.some((f, i) => f !== message.flags[i]);

  const source = locked.get(found.mailboxId);
  if (source === undefined) throw new Error('source mailbox not locked');

  if (moving === undefined) {
    if (!flagsChanged) return { before, after: before };
    const modseq = source.highestModseq + 1n;
    const updated = await tx.message.update({ where: { id: message.id }, data: { flags, modseq } });
    await tx.mailbox.update({ where: { id: source.id }, data: { highestModseq: modseq } });
    await notifyMailbox(tx, source.id);
    return { before, after: snap(updated) };
  }

  const target = locked.get(moving);
  if (target === undefined) throw new Error('target mailbox not locked');
  const uid = target.uidnext;
  const modseq = target.highestModseq + 1n;
  const moved = await tx.message.create({
    data: {
      mailboxId: target.id,
      uid,
      modseq,
      blobSha256: message.blobSha256,
      size: message.size,
      internalDate: message.internalDate,
      receivedAt: message.receivedAt,
      flags,
      inboundMessageId: message.inboundMessageId,
      messageIdHeader: message.messageIdHeader,
      subject: message.subject,
      fromAddress: message.fromAddress,
      sentAt: message.sentAt,
      inReplyTo: message.inReplyTo,
      references: message.references,
      threadId: message.threadId,
    },
  });
  await tx.mailbox.update({ where: { id: target.id }, data: { uidnext: uid + 1, highestModseq: modseq } });
  // The search row and the verdict belong to the message, not the row: they follow it.
  await tx.messageSearch.updateMany({ where: { messageId: message.id }, data: { messageId: moved.id } });
  await tx.messageVerdict.updateMany({ where: { messageId: message.id }, data: { messageId: moved.id } });
  await tx.message.delete({ where: { id: message.id } });
  const buckets = await tx.mailbox.findMany({ where: { id: { in: [source.id, target.id] } }, select: { id: true, name: true, specialUse: true } });
  const from = buckets.find((b) => b.id === source.id);
  const to = buckets.find((b) => b.id === target.id);
  const training = from === undefined || to === undefined ? null : trainingMove(from, to);
  if (training !== null) {
    await tx.bayesTrainingEvent.create({
      data: { accountId: input.accountId, messageId: moved.id, blobSha256: message.blobSha256, fromBucket: training.fromBucket, toBucket: training.toBucket, via: 'web' },
    });
  }
  // The expunge is a change in the source too: IMAP clients syncing with CONDSTORE must see it.
  await tx.mailbox.update({ where: { id: source.id }, data: { highestModseq: source.highestModseq + 1n } });
  for (const id of lockOrder) await notifyMailbox(tx, id);
  return { before, after: snap(moved) };
}
