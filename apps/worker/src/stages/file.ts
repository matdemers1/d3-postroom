// Stage 5, file: one copy per recipient ACCOUNT into the mailbox its sorting decision names
// (PST-T-2.7, PST-T-2.11, PST-T-5.1): INBOX with the keyword $Priority or $People, one of the bucket
// folders (Newsletters, Updates, Receipts, Notifications), or Junk. The copy's MessageVerdict stores
// the account's bucket, every reason, and the scores (PST-REQ-103).
//
// Addressing (PST-REQ-066, PST-REQ-067). smtp-in resolved every RCPT to account ids already:
//   · an alias names several accounts → one copy for each (team@ reaches two mailboxes);
//   · two RCPTs reaching the same account (you@ and team@, or you@ twice) → still one copy, with
//     the union of their keywords and reasons;
//   · a plus address `you+github@` → you's mailbox, keyword `$Postroom.tag.github`, and the tag
//     named in the verdict's reasons;
//   · a masked alias → its owner's mailbox, keyword `$Postroom.site.<site>`.
//
// Sieve (PST-T-9.5, PST-REQ-148). When the account has an active script, the sieve stage's outcome
// decides where its copies go instead (resolveTargets): fileinto (an existing folder, or :create),
// keep, imap4flags flags, vnd.postroom.bucket over the classifier, a redirect only to the account's
// own address (delivered here), and a discard that lands in Trash with its reason — never a silent
// deletion. One account may then get several copies (fileinto twice); each has its own verdict.
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
import { BUCKET_FOLDERS, bucketOfMailbox, PEOPLE_KEYWORD, PRIORITY_KEYWORD } from '@postroom/classifier';
import { SpecialUse, type Prisma } from '@postroom/db';
import { fileLocalMessage } from '@postroom/dsn';
import { indexMessage } from '@postroom/search';
import { assignThread } from '@postroom/threading';
import { markStage } from './state.js';
import type {
  AccountDecision,
  Bucket,
  ClassifyResult,
  FileResult,
  FiledCopy,
  Json,
  ParseResult,
  SieveAccountOutcome,
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

/** IMAP keyword on a first-time human sender's INBOX copy (PST-T-5.4). */
export const NEW_SENDER_KEYWORD = '$NewSender';
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

const BUCKETS: readonly Bucket[] = ['priority', 'people', 'newsletters', 'updates', 'receipts', 'notifications', 'junk'];

function asBucket(value: string | null | undefined): Bucket | null {
  return value !== null && value !== undefined && (BUCKETS as readonly string[]).includes(value) ? (value as Bucket) : null;
}

/**
 * The account's decision from the classify result. A classify marker written before per-account
 * sorting (PST-T-5.1) has no `accounts`: its junk still goes to Junk, anything else to INBOX as People.
 */
export function decisionFor(classify: ClassifyResult, accountId: string): AccountDecision {
  const d = (classify.accounts as ClassifyResult['accounts'] | undefined)?.[accountId];
  if (d !== undefined) return d;
  const junk = (classify.bucket as string) === 'junk';
  return {
    bucket: junk ? 'junk' : 'people',
    mailbox: junk ? 'Junk' : 'INBOX',
    keyword: junk ? null : PEOPLE_KEYWORD,
    reasons: [...classify.reasons, junk ? 'junk: classify decided junk' : 'people: classify result has no per-account decision; filed to INBOX as People'],
    scores: {},
  };
}

/** The account's mailbox for a bucket: INBOX and Junk by special use (a renamed Junk still counts), the bucket folders by name. */
async function targetMailboxName(tx: Tx, accountId: string, decision: AccountDecision): Promise<string> {
  if (decision.bucket !== 'junk' && decision.bucket !== 'priority' && decision.bucket !== 'people') return decision.mailbox;
  const specialUse = decision.bucket === 'junk' ? SpecialUse.junk : SpecialUse.inbox;
  const mb = await tx.mailbox.findFirst({ where: { accountId, specialUse }, select: { name: true }, orderBy: { createdAt: 'asc' } });
  // fileLocalMessage creates INBOX / Junk (with its special use) and the bucket folders race-safely when the account has none.
  return mb?.name ?? (decision.bucket === 'junk' ? 'Junk' : 'INBOX');
}

// ─── Sieve (PST-T-9.5, PST-REQ-148) ──────────────────────────────────────────────────────────────

/** The account's outcome from the sieve stage, or null when it has no active script (or the marker predates Sieve). */
export function sieveOutcomeFor(sieve: SieveResult, accountId: string): SieveAccountOutcome | null {
  const accounts = (sieve as { accounts?: Record<string, unknown> }).accounts;
  const o = accounts?.[accountId];
  return o === undefined || o === null ? null : (o as unknown as SieveAccountOutcome);
}

const SYSTEM_FLAGS: ReadonlyMap<string, string> = new Map(['\\Seen', '\\Answered', '\\Flagged', '\\Deleted', '\\Draft'].map((f) => [f.toLowerCase(), f]));
// RFC 9051 flag-keyword: an atom — no ( ) { SP CTL % * " \ ] — and not starting with "\".
// eslint-disable-next-line no-control-regex
const KEYWORD = /^[^\x00-\x20\x7f(){%*"\\\]]{1,128}$/;

/** imap4flags flags → IMAP flags a message may carry. \Recent and malformed names are dropped, with a reason. */
export function imapFlags(flags: readonly string[] | null): { flags: string[]; dropped: string[] } {
  const out: string[] = [];
  const dropped: string[] = [];
  for (const f of flags ?? []) {
    if (f.startsWith('\\')) {
      const system = SYSTEM_FLAGS.get(f.toLowerCase());
      if (system === undefined) dropped.push(f);
      else out.push(system);
    } else if (KEYWORD.test(f)) {
      out.push(f);
    } else {
      dropped.push(f);
    }
  }
  return { flags: [...new Set(out)], dropped };
}

/** A vnd.postroom.bucket name → the classifier bucket it names (case-insensitive; "inbox" is People), or null. */
export function bucketByName(name: string): Bucket | null {
  const lower = name.trim().toLowerCase();
  if (lower === 'inbox') return 'people';
  return (BUCKETS as readonly string[]).includes(lower) ? (lower as Bucket) : null;
}

/** The decision a known bucket implies: INBOX with $Priority/$People, Junk, or the bucket folder. */
export function decisionForBucket(bucket: Bucket, base: AccountDecision, reason: string): AccountDecision {
  const mailbox = bucket === 'priority' || bucket === 'people' ? 'INBOX' : bucket === 'junk' ? 'Junk' : BUCKET_FOLDERS[bucket];
  const keyword = bucket === 'priority' ? PRIORITY_KEYWORD : bucket === 'people' ? PEOPLE_KEYWORD : null;
  return { bucket, mailbox, keyword, reasons: [...base.reasons, reason], scores: { ...base.scores, [`bucket:${bucket}`]: 1, sieveBucket: 1 } };
}

/** On a copy's verdict when its account has no active Sieve script. */
export const NO_SCRIPT_REASON = 'sieve: no active script';

// ─── Plus-address tag routing (PST-T-5.7, PST-REQ-111) ──────────────────────────────────────────
//
// A plus tag that spells one of the bucket folder names routes the copy there — you+receipts@
// files to Receipts — overriding the classifier's own decision, but never a junk/quarantine rule
// (classify.ts already decided junk before file.ts ever sees the account; that decision is left
// alone here). Any other tag stays keyword-only, as it already was.
const ROUTABLE_TAG_BUCKETS: ReadonlySet<Bucket> = new Set(['newsletters', 'updates', 'receipts', 'notifications']);

/** The bucket a plus tag names, case-insensitively, when it is one of the sorting folders. */
function tagBucket(tag: string): Bucket | null {
  const lower = tag.trim().toLowerCase();
  return (ROUTABLE_TAG_BUCKETS as ReadonlySet<string>).has(lower) ? (lower as Bucket) : null;
}

/**
 * A plus-address tag equal to a bucket name overrides the classifier's decision for this account's
 * copy — the first matching tag among the recipients that reached it wins. Junk is never
 * overridden: the classifier only decides junk for a whole-message rule (quarantine, a blocked
 * sender, a quarantined attachment), and that call stands.
 */
export function applyTagRouting(decision: AccountDecision, tags: readonly string[]): AccountDecision {
  if (decision.bucket === 'junk') return decision;
  for (const tag of tags) {
    const bucket = tagBucket(tag);
    if (bucket === null) continue;
    return decisionForBucket(bucket, decision, `plus-address tag ${bucket}`);
  }
  return decision;
}

export interface FileTarget {
  readonly mailbox: string;
  /** The decision recorded on the copy's verdict (the classifier's, or the one a sieve bucket chose). */
  readonly decision: AccountDecision;
  /** Whether the decision's $Priority/$People keyword goes on this copy (an INBOX keep). */
  readonly useDecisionKeyword: boolean;
  readonly bucket: Bucket | null;
  readonly flags: string[];
  readonly reasons: string[];
}

/**
 * Where one account's copies go. Without a script: the classifier's decision, one copy. With one:
 *   · keep (explicit or implicit) and fileinto "INBOX" → the classifier's decision, unless
 *     vnd.postroom.bucket chose a bucket — then that bucket (a name that is not one of the sorting
 *     buckets files into a folder of that name, created if missing);
 *   · fileinto "X" → X when it exists or :create was given; otherwise the keep target, with why;
 *   · an allowed redirect (only ever to the account's own address) → the keep target: delivered here,
 *     never relayed;
 *   · discard with nothing else → Trash, with the reason: Postroom never deletes mail silently.
 * Two actions naming the same mailbox file one copy with their flags merged.
 */
export async function resolveTargets(tx: Tx, accountId: string, classifier: AccountDecision, outcome: SieveAccountOutcome | null): Promise<FileTarget[]> {
  const keepMailbox = async (decision: AccountDecision): Promise<string> => targetMailboxName(tx, accountId, decision);
  if (outcome === null) {
    return [{ mailbox: await keepMailbox(classifier), decision: classifier, useDecisionKeyword: true, bucket: classifier.bucket, flags: [], reasons: [] }];
  }

  // What a keep means for this account: the classifier's decision, or the script's bucket.
  let keepDecision = classifier;
  let keepFolder: string | null = null;
  if (outcome.bucket !== null) {
    const known = bucketByName(outcome.bucket);
    const reason = `sieve bucket "${outcome.bucket}" overrides the classifier's ${classifier.bucket}`;
    if (known !== null) keepDecision = decisionForBucket(known, classifier, reason);
    else {
      keepFolder = outcome.bucket;
      keepDecision = { ...classifier, reasons: [...classifier.reasons, `${reason}: filed to the folder "${outcome.bucket}"`] };
    }
  }

  const merged = new Map<string, { target: FileTarget; flags: Set<string>; reasons: string[] }>();
  const add = (t: FileTarget): void => {
    const current = merged.get(t.mailbox);
    if (current === undefined) merged.set(t.mailbox, { target: t, flags: new Set(t.flags), reasons: [...t.reasons] });
    else {
      for (const f of t.flags) current.flags.add(f);
      current.reasons.push(...t.reasons);
    }
  };
  const flagReasons = (dropped: string[]): string[] => (dropped.length === 0 ? [] : [`sieve flags not valid for IMAP, left off: ${dropped.join(' ')}`]);
  const addKeep = async (flags: readonly string[] | null, reasons: string[]): Promise<void> => {
    const f = imapFlags(flags);
    if (keepFolder !== null) {
      add({ mailbox: keepFolder, decision: keepDecision, useDecisionKeyword: false, bucket: null, flags: f.flags, reasons: [...reasons, ...flagReasons(f.dropped)] });
      return;
    }
    add({ mailbox: await keepMailbox(keepDecision), decision: keepDecision, useDecisionKeyword: true, bucket: keepDecision.bucket, flags: f.flags, reasons: [...reasons, ...flagReasons(f.dropped)] });
  };

  for (const d of outcome.deliveries) {
    if (d.kind === 'keep' || d.mailbox.toUpperCase() === 'INBOX') {
      await addKeep(d.flags, []);
      continue;
    }
    const exists = await tx.mailbox.findFirst({ where: { accountId, name: d.mailbox }, select: { name: true, specialUse: true } });
    if (exists === null && !d.create) {
      await addKeep(d.flags, [`sieve fileinto "${d.mailbox}" (line ${d.line}): there is no such mailbox and no :create, so it was kept instead`]);
      continue;
    }
    const f = imapFlags(d.flags);
    const sort = exists === null ? null : bucketOfMailbox({ name: exists.name, specialUse: exists.specialUse });
    const bucket = sort === null || sort === 'inbox' ? null : sort;
    add({
      mailbox: d.mailbox,
      decision: classifier,
      useDecisionKeyword: false,
      bucket,
      flags: f.flags,
      reasons: [`sieve fileinto "${d.mailbox}"${exists === null ? ' (created by :create)' : ''}`, ...flagReasons(f.dropped)],
    });
  }
  for (const r of outcome.redirects) {
    if (r.allowed) await addKeep(null, [`sieve redirect to ${r.address} (line ${r.line}): the account's own address, delivered here — never relayed`]);
  }
  if (merged.size === 0) {
    if (outcome.discard) {
      const trash = await tx.mailbox.findFirst({ where: { accountId, specialUse: SpecialUse.trash }, select: { name: true }, orderBy: { createdAt: 'asc' } });
      add({
        mailbox: trash?.name ?? 'Trash',
        decision: classifier,
        useDecisionKeyword: false,
        bucket: null,
        flags: [],
        reasons: ['sieve discard: filed to Trash with this reason instead of being deleted — Postroom never deletes mail silently'],
      });
    } else {
      await addKeep(null, ['sieve decided nothing to file; kept']);
    }
  }
  return [...merged.values()]
    .map(({ target, flags, reasons }) => ({ ...target, flags: [...flags].sort(), reasons }))
    .sort((a, b) => (a.mailbox < b.mailbox ? -1 : a.mailbox > b.mailbox ? 1 : 0));
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
  const bucket = prior.classify.bucket === 'junk' ? 'junk' : 'sorted';
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
      // A copy of this spool row anywhere in this account means an earlier run filed it (every copy
      // for an account is written in one transaction): report them and file nothing new.
      const existing = await tx.message.findMany({
        where: { inboundMessageId: inbound.id, mailbox: { accountId: plan.accountId } },
        select: { id: true, uid: true, flags: true, mailbox: { select: { id: true, name: true } }, verdict: { select: { bucket: true } } },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      });
      if (existing.length > 0) {
        for (const e of existing) {
          copies.push({
            accountId: plan.accountId,
            mailboxId: e.mailbox.id,
            mailbox: e.mailbox.name,
            messageId: e.id,
            uid: e.uid,
            created: false,
            keywords: plan.keywords,
            bucket: asBucket(e.verdict?.bucket),
          });
        }
        continue;
      }
      const classifierDecision = applyTagRouting(decisionFor(prior.classify, plan.accountId), plan.tags);
      const outcome = sieveOutcomeFor(prior.sieve, plan.accountId);
      // $NewSender marks a first-time human sender (PST-REQ-106) so every IMAP client sees the badge,
      // not only the webmail; Allow/Block in the webmail clears it.
      const newSender = classifierDecision.scores['newSender'] === 1 ? [NEW_SENDER_KEYWORD] : [];
      const targets = await resolveTargets(tx, plan.accountId, classifierDecision, outcome);
      for (const target of targets) {
        const extra = target.useDecisionKeyword && target.decision.keyword !== null ? [target.decision.keyword] : [];
        const keywords = [...new Set([...plan.keywords, ...extra, ...newSender, ...target.flags])].sort();
        const mailbox = target.mailbox;
        const filed = await fileLocalMessage(tx, {
          accountId: plan.accountId,
          mailbox,
          blobSha256: inbound.blobSha256,
          size: inbound.size,
          internalDate: inbound.receivedAt,
          flags: keywords,
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
        const sieveReasons = outcome === null ? [NO_SCRIPT_REASON] : outcome.reasons;
        await tx.messageVerdict.create({
          data: {
            messageId: filed.id,
            auth: json(auth),
            attachments: json(prior.classify.attachments),
            bucket: target.bucket,
            reasons: [...target.decision.reasons, ...sieveReasons, ...target.reasons, ...plan.reasons, `filed to ${mailbox}`],
            scores: json(target.decision.scores),
          },
        });
        created++;
        copies.push({ accountId: plan.accountId, mailboxId: filed.mailboxId, mailbox, messageId: filed.id, uid: filed.uid, created: true, keywords, bucket: target.bucket });
      }
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
