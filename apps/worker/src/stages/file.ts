// Stage 5, file: one copy per recipient ACCOUNT into its Inbox or Junk (PST-T-2.7, PST-T-2.11).
//
// Addressing (PST-REQ-066, PST-REQ-067). smtp-in resolved every RCPT to account ids already:
//   · an alias names several accounts → one copy for each (team@ reaches two mailboxes);
//   · two RCPTs reaching the same account (you@ and team@, or you@ twice) → still one copy, with
//     the union of their keywords and reasons;
//   · a plus address `you+github@` → you's mailbox, keyword `$Postroom.tag.github`, and the tag
//     named in the verdict's reasons;
//   · a masked alias → its owner's mailbox, keyword `$Postroom.site.<site>`.
//
// Exactly once. The whole stage is one transaction that also writes the stage's marker, under an
// advisory lock on the spool row's id. Before filing into an account it looks for a Message from
// this spool row in any of that account's mailboxes; the UNIQUE(mailbox_id, inbound_message_id)
// index is the backstop if two workers ever raced past that check. So a replay, a retry after a
// crash, or a second worker after a lease expiry finds the copy and files nothing new.
//
// Blob references. Each new copy takes its own reference (refcount + 1) in the same transaction;
// a copy found already filed takes none. The spool row's own reference is KEPT after filing — the
// InboundMessage still names the blob (replay, the Inspect drawer, the Rejects/retention sweep of
// PST-T-7.7 which releases it) — so the blob can never be collected while anything points at it.
//
// Lock order matches smtp-in's Rejects path (blob, then mailbox): inbound id → blob → mailboxes in
// account-id order.
import { SpecialUse, type Prisma } from '@postroom/db';
import { fileLocalMessage } from '@postroom/dsn';
import { indexMessage } from '@postroom/search';
import { assignThread } from '@postroom/threading';
import { markStage } from './state.js';
import type {
  Bucket,
  ClassifyResult,
  FileResult,
  FiledCopy,
  Json,
  ParseResult,
  SieveResult,
  SpooledRecipient,
  StageDeps,
  StageInput,
} from './types.js';

type Tx = Prisma.TransactionClient;

export const TAG_KEYWORD_PREFIX = '$Postroom.tag.';
export const SITE_KEYWORD_PREFIX = '$Postroom.site.';
const MAX_KEYWORD_SUFFIX = 64;
const TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;

/**
 * An IMAP keyword suffix from a tag: RFC 9051 keywords are atoms, so everything outside
 * `[a-z0-9_-]` (after lower-casing) becomes `_`. Never empty. Distinct tags may collide after
 * sanitising; the raw tag is always kept in the verdict's reasons.
 */
export function keywordSuffix(tag: string): string {
  const cleaned = tag.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, MAX_KEYWORD_SUFFIX);
  return cleaned === '' ? '_' : cleaned;
}

export const tagKeyword = (tag: string): string => `${TAG_KEYWORD_PREFIX}${keywordSuffix(tag)}`;
export const siteKeyword = (site: string): string => `${SITE_KEYWORD_PREFIX}${keywordSuffix(site)}`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The spool row's recipients JSON, validated. A malformed entry is an error, never skipped. */
export function parseRecipients(value: unknown): SpooledRecipient[] {
  if (!Array.isArray(value)) throw new Error('inbound recipients is not an array');
  return value.map((r, i) => {
    if (!isObject(r) || typeof r['address'] !== 'string' || !Array.isArray(r['accountIds']) || !r['accountIds'].every((a) => typeof a === 'string')) {
      throw new Error(`inbound recipient ${i} is malformed`);
    }
    const tag = typeof r['tag'] === 'string' && r['tag'] !== '' ? r['tag'] : undefined;
    const siteTag = typeof r['siteTag'] === 'string' && r['siteTag'] !== '' ? r['siteTag'] : undefined;
    return {
      rcpt: typeof r['rcpt'] === 'string' ? r['rcpt'] : r['address'],
      address: r['address'],
      accountIds: r['accountIds'],
      kind: typeof r['kind'] === 'string' ? r['kind'] : 'mailbox',
      ...(tag === undefined ? {} : { tag }),
      ...(siteTag === undefined ? {} : { siteTag }),
    };
  });
}

export interface CopyPlan {
  readonly accountId: string;
  /** Sorted, deduplicated IMAP keywords for this copy. */
  readonly keywords: string[];
  /** Raw plus-address tags that reached this account. */
  readonly tags: string[];
  /** Why this account gets a copy: one line per recipient that reached it. */
  readonly reasons: string[];
}

/** Recipients → one plan per account, in account-id order (the lock order). Pure. */
export function planCopies(recipients: readonly SpooledRecipient[]): CopyPlan[] {
  const byAccount = new Map<string, { keywords: Set<string>; tags: Set<string>; reasons: string[] }>();
  for (const r of recipients) {
    for (const accountId of new Set(r.accountIds)) {
      let entry = byAccount.get(accountId);
      if (entry === undefined) {
        entry = { keywords: new Set(), tags: new Set(), reasons: [] };
        byAccount.set(accountId, entry);
      }
      if (r.kind === 'alias') {
        entry.reasons.push(`delivered via alias ${r.address} (one copy per member account)`);
      } else if (r.kind === 'plus') {
        entry.reasons.push(`delivered to ${r.address} via plus address ${r.rcpt}`);
      } else if (r.kind === 'masked') {
        entry.reasons.push(`delivered via masked alias ${r.address}`);
      } else {
        entry.reasons.push(`delivered to ${r.address}`);
      }
      if (r.tag !== undefined) {
        const kw = tagKeyword(r.tag);
        entry.tags.add(r.tag);
        entry.keywords.add(kw);
        entry.reasons.push(`tag "${r.tag}" from ${r.rcpt}: keyword ${kw}`);
      }
      if (r.siteTag !== undefined) {
        const kw = siteKeyword(r.siteTag);
        entry.keywords.add(kw);
        entry.reasons.push(`masked alias site "${r.siteTag}": keyword ${kw}`);
      }
    }
  }
  return [...byAccount.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([accountId, e]) => ({ accountId, keywords: [...e.keywords].sort(), tags: [...e.tags].sort(), reasons: [...new Set(e.reasons)] }));
}

/** The account's mailbox for a bucket: by special use (a renamed Junk still counts), else by name. */
async function targetMailboxName(tx: Tx, accountId: string, bucket: Bucket): Promise<string> {
  const specialUse = bucket === 'junk' ? SpecialUse.junk : SpecialUse.inbox;
  const mb = await tx.mailbox.findFirst({ where: { accountId, specialUse }, select: { name: true }, orderBy: { createdAt: 'asc' } });
  // fileLocalMessage creates INBOX / Junk (with its special use) race-safely when the account has none.
  return mb?.name ?? (bucket === 'junk' ? 'Junk' : 'INBOX');
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** The auth verdicts smtp-in stored, as the Message's verdict keeps them (same shape as Rejects copies). */
function authOf(verdicts: unknown): Json {
  if (!isObject(verdicts)) return {};
  const out: Record<string, unknown> = {};
  for (const k of ['spf', 'dkim', 'dmarc', 'arc', 'arcOverride', 'dnsbl']) {
    if (k in verdicts) out[k] = verdicts[k];
  }
  return JSON.parse(JSON.stringify(out)) as Json;
}

export async function fileStage(
  input: StageInput,
  deps: StageDeps,
  prior: { parse: ParseResult; classify: ClassifyResult; sieve: SieveResult; recipients: readonly SpooledRecipient[] },
): Promise<FileResult> {
  const { inbound } = input;
  const plans = planCopies(prior.recipients);
  if (plans.length === 0) throw new Error(`inbound message ${inbound.id} has no recipient accounts to file for`);
  const bucket = prior.classify.bucket;
  const auth = authOf(inbound.verdicts);
  const denorm = {
    messageIdHeader: prior.parse.messageId,
    subject: prior.parse.subject,
    fromAddress: prior.parse.fromAddress,
    sentAt: prior.parse.sentAt === null ? null : new Date(prior.parse.sentAt),
  };

  const result = await deps.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-inbound:' + inbound.id}, 0))`;
    // The blob store's own lock: no release() can drop the row between our check and our increment.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-blob:' + inbound.blobSha256}, 0))`;
    const blob = await tx.blob.findUnique({ where: { sha256: inbound.blobSha256 }, select: { sha256: true } });
    if (blob === null) throw new Error(`blob ${inbound.blobSha256} vanished before filing inbound message ${inbound.id}`);

    const copies: FiledCopy[] = [];
    let created = 0;
    for (const plan of plans) {
      const existing = await tx.message.findFirst({
        where: { inboundMessageId: inbound.id, mailbox: { accountId: plan.accountId } },
        select: { id: true, uid: true, flags: true, mailbox: { select: { id: true, name: true } } },
        orderBy: { receivedAt: 'asc' },
      });
      if (existing !== null) {
        copies.push({
          accountId: plan.accountId,
          mailboxId: existing.mailbox.id,
          mailbox: existing.mailbox.name,
          messageId: existing.id,
          uid: existing.uid,
          created: false,
          keywords: plan.keywords,
        });
        continue;
      }
      const mailbox = await targetMailboxName(tx, plan.accountId, bucket);
      const filed = await fileLocalMessage(tx, {
        accountId: plan.accountId,
        mailbox,
        blobSha256: inbound.blobSha256,
        size: inbound.size,
        internalDate: inbound.receivedAt,
        flags: plan.keywords,
      });
      await tx.message.update({ where: { id: filed.id }, data: { inboundMessageId: inbound.id, ...denorm } });
      await indexMessage(tx, {
        messageId: filed.id,
        accountId: plan.accountId,
        ...(prior.parse.subject === null ? {} : { subject: prior.parse.subject }),
        ...(prior.parse.fromAddress === null ? {} : { from: prior.parse.fromAddress }),
        ...(prior.parse.toAddress === null ? {} : { to: prior.parse.toAddress }),
        bodyText: prior.parse.bodyText,
        attachmentNames: prior.parse.attachments.map((a) => a.filename).filter((f): f is string => f !== null),
        hasAttachment: prior.parse.attachments.length > 0,
      });
      await tx.messageVerdict.create({
        data: {
          messageId: filed.id,
          auth: json(auth),
          attachments: json(prior.classify.attachments),
          bucket,
          reasons: [...prior.classify.reasons, ...prior.sieve.reasons, ...plan.reasons, `filed to ${mailbox}`],
        },
      });
      created++;
      copies.push({ accountId: plan.accountId, mailboxId: filed.mailboxId, mailbox, messageId: filed.id, uid: filed.uid, created: true, keywords: plan.keywords });
    }
    if (created > 0) {
      await tx.blob.update({ where: { sha256: inbound.blobSha256 }, data: { refcount: { increment: created } } });
    }
    await deps.faults?.inFileTransaction?.(tx, inbound.id);
    const result: FileResult = { bucket, copies, created };
    const now = deps.now();
    await markStage(tx, inbound.id, 'file', result, now);
    await tx.inboundMessage.update({ where: { id: inbound.id }, data: { filedAt: inbound.filedAt ?? now } });
    return result;
  }, TX_OPTIONS);

  // Thread every copy this run created, after the filing transaction has committed (PST-REQ-078,
  // PST-T-3.13). assignThread runs in its own transaction under a per-account advisory lock; a copy
  // found already filed (created: false, a replay or a resumed crash) was threaded the run it was
  // created, so it is left alone here — and a created copy that already carries a threadId (should
  // not happen, but the check makes this loop itself replay-safe) is skipped too.
  const date = prior.parse.sentAt === null ? inbound.receivedAt : new Date(prior.parse.sentAt);
  for (const copy of result.copies) {
    if (!copy.created) continue;
    const current = await deps.db.message.findUnique({ where: { id: copy.messageId }, select: { threadId: true } });
    if (current?.threadId !== null && current?.threadId !== undefined) continue;
    await assignThread(deps.db, {
      accountId: copy.accountId,
      messageId: copy.messageId,
      ...(prior.parse.messageId === null ? {} : { messageIdHeader: prior.parse.messageId }),
      ...(prior.parse.inReplyTo[0] === undefined ? {} : { inReplyTo: prior.parse.inReplyTo[0] }),
      references: prior.parse.references,
      subject: prior.parse.subject ?? '',
      from: prior.parse.fromAddress ?? '',
      to: prior.parse.toAddress ?? '',
      date,
    });
  }

  return result;
}
