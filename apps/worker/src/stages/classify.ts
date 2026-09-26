// Stage 3, classify (PST-T-5.1, PST-REQ-101, PST-REQ-103). The junk rules come first and win:
//
//   · smtp-in's disposition was `quarantine` (DMARC p=quarantine, …) → junk;
//   · the dangerous-attachment policy (PST-REQ-065) quarantines an attachment → junk.
//
// Otherwise each recipient ACCOUNT gets its own decision from @postroom/classifier — its own
// addresses, reply graph and Bayes model — via `bucketFor`: Priority or People (INBOX, keyword
// $Priority/$People), or one of Newsletters, Updates, Receipts, Notifications (or Junk, when the
// account's Bayes model learned it).
//
// Account context:
//   · addresses: the account's own addresses (primary, masked, service), the aliases that reach it,
//     and the addresses this message was delivered to it at;
//   · reply graph: has this account sent to the sender — one indexed lookup against its
//     correspondent table (PST-T-5.8), maintained on send, bounded by firstWrittenAt — before this
//     message was received;
//   · contacts: every e-mail address on the account's CardDAV cards (PST-T-8.5), read through
//     @postroom/dav-store's ContactIndex — cached per account on its address books' sync tokens and
//     bounded in cards read — plus an Allow screen (PST-T-5.4). Contacts are the account's CURRENT
//     cards, not bounded by receivedAt: the address books keep no history to bound them by.
// Everything read is bounded by this message's receivedAt, so a replay reaches the same rule
// decision. (The Bayes model can have learned more by a replay; a replay of classify after the file
// stage ran changes nothing anyway, because the file stage finds its copies and files nothing new.)
//
// Every outcome carries its reasons (PST-ADR-007), and nothing is ever dropped: the worst this
// stage can do is put a message in Junk, where its reasons say why.
//
// "Sender history" for the attachment rule: this sender has an earlier message, not in Junk or
// Rejects, in one of the recipient accounts, received before this one. Bounded by this message's
// receivedAt, so a replay reaches the same answer it reached the first time.
import { attachmentPolicy } from '@postroom/attachments';
import type { BlobStore } from '@postroom/blobstore';
import { bucketFor, extractSignals, FILING_BUCKETS, normalizeAddress, tokenize, type AuthVerdicts, type FilingBucket, type HeaderLike, type PinInput } from '@postroom/classifier';
import { loadKek, type Kek } from '@postroom/crypto';
import { contactIndexFor } from '@postroom/dav-store';
import { SpecialUse, type Db, type SenderPin } from '@postroom/db';
import { blobHeaderReader } from '../training/headers.js';
import { loadBayesModel } from '../training/model.js';
import { parseRecipients } from './file.js';
import { collectBlob, openBlobPart } from './parse.js';
import type { AccountDecision, AttachmentFindingJson, ClassifyResult, ParseResult, SpooledRecipient, StageInput, VerifyResult } from './types.js';

function authSummary(verdicts: unknown): string | null {
  if (typeof verdicts !== 'object' || verdicts === null) return null;
  const v = verdicts as Record<string, unknown>;
  const result = (x: unknown): string => (typeof x === 'object' && x !== null && 'result' in x && typeof x.result === 'string' ? x.result : 'none');
  const dkim = Array.isArray(v['dkim']) ? (v['dkim'] as unknown[]).map(result) : [];
  return `auth: spf=${result(v['spf'])} dkim=${dkim.length === 0 ? 'none' : dkim.join(',')} dmarc=${result(v['dmarc'])} arc=${result(v['arc'])}`;
}

export async function senderHasHistory(db: Db, input: { inboundMessageId: string; fromAddress: string | null; accountIds: readonly string[]; before: Date }): Promise<boolean> {
  if (input.fromAddress === null || input.accountIds.length === 0) return false;
  const prior = await db.message.findFirst({
    where: {
      fromAddress: { equals: input.fromAddress, mode: 'insensitive' },
      internalDate: { lt: input.before },
      OR: [{ inboundMessageId: null }, { inboundMessageId: { not: input.inboundMessageId } }],
      mailbox: {
        accountId: { in: [...input.accountIds] },
        OR: [{ specialUse: null }, { specialUse: { notIn: [SpecialUse.junk, SpecialUse.rejects] } }],
      },
    },
    select: { id: true },
  });
  return prior !== null;
}

/** The account's own addresses: the ones it owns, the aliases that reach it, and the ones this message reached it at. */
export async function accountAddresses(db: Db, accountId: string, recipients: readonly SpooledRecipient[]): Promise<string[]> {
  const out = new Set<string>();
  const owned = await db.address.findMany({
    where: { OR: [{ accountId }, { targets: { some: { accountId } } }] },
    select: { localPart: true, domain: { select: { name: true } } },
  });
  for (const a of owned) out.add(`${a.localPart}@${a.domain.name}`);
  for (const r of recipients) {
    if (!r.accountIds.includes(accountId)) continue;
    out.add(r.address);
    out.add(r.rcpt);
  }
  return [...out].sort();
}

/**
 * Whether this account had written to `address` before `before` (PST-T-5.8, PST-REQ-102): one
 * indexed lookup against the per-account correspondent table (maintained on send by
 * acceptSubmission), keyed by the same normalization the classifier and sender pins use, bounded by
 * comparing its firstWrittenAt — so a replay of an older message still reaches the same rule
 * decision even though the account has gone on writing to this address since.
 */
export async function inReplyGraph(db: Db, input: { accountId: string; address: string | null; before: Date }): Promise<boolean> {
  if (input.address === null || input.address === '') return false;
  const normalized = normalizeAddress(input.address);
  const row = await db.correspondent.findUnique({
    where: { accountId_address: { accountId: input.accountId, address: normalized } },
    select: { firstWrittenAt: true },
  });
  return row !== null && row.firstWrittenAt < input.before;
}

function authVerdicts(verdicts: unknown): AuthVerdicts {
  if (typeof verdicts !== 'object' || verdicts === null) return {};
  return verdicts;
}

function isFilingBucket(value: string | null): value is FilingBucket {
  return value !== null && (FILING_BUCKETS as readonly string[]).includes(value);
}

/** This account's sender pin/screen row for `address` (PST-T-5.4, PST-REQ-105, PST-REQ-106), or null. */
export async function loadSenderPin(db: Db, accountId: string, address: string | null): Promise<SenderPin | null> {
  if (address === null) return null;
  return db.senderPin.findUnique({ where: { accountId_address: { accountId, address: normalizeAddress(address) } } });
}

/** The account's contact addresses (lower-cased), for the classifier's "contact" signal. */
export type ContactLookup = (accountId: string) => Promise<readonly string[]>;

let envKek: Kek | null | undefined;

/**
 * The default lookup: the worker's KEK from POSTROOM_KEK (the one its blob store is opened with).
 * Without one, no contacts — logged once, never fatal: sorting still works, only less well.
 */
export function defaultContactLookup(db: Db): ContactLookup {
  return async (accountId) => {
    if (envKek === undefined) {
      try {
        envKek = loadKek({ env: process.env });
      } catch (error) {
        envKek = null;
        process.stderr.write(`${JSON.stringify({ daemon: 'worker', event: 'contacts-unavailable', error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }
    if (envKek === null) return [];
    return [...(await contactIndexFor(db, envKek).emails(accountId))];
  };
}

export async function classifyStage(
  input: StageInput,
  deps: { db: Db; blobs: BlobStore; contacts?: ContactLookup },
  prior: { verify: VerifyResult; parse: ParseResult; accountIds: readonly string[] },
): Promise<ClassifyResult> {
  const reasons: string[] = [];
  let junk = false;

  const auth = authSummary(input.inbound.verdicts);
  if (auth !== null) reasons.push(auth);

  if (prior.verify.disposition === 'quarantine') {
    junk = true;
    reasons.push(`junk: smtp-in quarantined it${input.inbound.dispositionReason === null ? '' : ` (${input.inbound.dispositionReason})`}`);
  }

  const history = await senderHasHistory(deps.db, {
    inboundMessageId: input.inbound.id,
    fromAddress: prior.parse.fromAddress,
    accountIds: prior.accountIds,
    before: input.inbound.receivedAt,
  });
  let findings: AttachmentFindingJson[] = [];
  let attachmentQuarantine = false;
  if (prior.parse.attachments.length > 0) {
    // The parse stage kept only JSON; the policy needs the sniffing bytes, so collect again (streamed).
    const collected = await collectBlob(deps.blobs, input.inbound.blobSha256);
    const policy = await attachmentPolicy(collected, {
      senderHasHistory: history,
      openPart: (partId) => openBlobPart(deps.blobs, input.inbound.blobSha256, partId),
    });
    attachmentQuarantine = policy.quarantine;
    findings = policy.findings.map((f) => ({ partId: f.partId, filename: f.filename, verdict: f.verdict, kind: f.kind, reasons: [...f.reasons] }));
    for (const f of policy.findings) {
      if (f.verdict !== 'quarantine') continue;
      reasons.push(`junk: attachment ${f.filename ?? `part ${f.partId}`} quarantined (${f.reasons.join('; ')})`);
    }
    if (attachmentQuarantine) {
      junk = true;
      reasons.push(`attachment policy: sender ${history ? 'has' : 'has no'} prior history with the recipient`);
    }
  }

  const accountIds = [...new Set(prior.accountIds)].sort();
  const accounts: Record<string, AccountDecision> = {};
  if (junk) {
    for (const accountId of accountIds) {
      accounts[accountId] = { bucket: 'junk', mailbox: 'Junk', keyword: null, reasons: [...reasons, 'junk: a junk rule wins over sorting'], scores: { 'bucket:junk': 1 } };
    }
    return { bucket: 'junk', accounts, senderHasHistory: history, attachmentQuarantine, attachments: findings, reasons };
  }

  const headers: HeaderLike[] = await blobHeaderReader(deps.blobs)(input.inbound.blobSha256);
  const tokens = tokenize({ subject: prior.parse.subject, from: prior.parse.fromAddress, bodyText: prior.parse.bodyText, headers });
  const recipients = parseRecipients(input.inbound.recipients);
  const envelopeFrom = input.inbound.envelopeFrom === '' ? null : input.inbound.envelopeFrom;
  const authVerdictsOf = authVerdicts(input.inbound.verdicts);
  for (const accountId of accountIds) {
    const addresses = await accountAddresses(deps.db, accountId, recipients);
    // A first pass with no reply graph, contacts or pin, just to read this account's From address.
    const bareSignals = extractSignals({
      headers,
      envelopeFrom,
      authVerdicts: authVerdictsOf,
      account: { addresses, replyGraph: [], contacts: [], pins: { vip: [], blocked: [] } },
    });
    const sender = bareSignals.fromAddress;
    const pinRow = await loadSenderPin(deps.db, accountId, sender);
    // A screen decision (PST-T-5.4, PST-REQ-106): Allow treats the sender as a known contact (so a
    // direct first-time human can reach Priority); Block routes their mail to Junk (the account's
    // blocked-pins signal, no authentication required — the same as PST-REQ-105's existing rule).
    const contacts = [...(await (deps.contacts ?? defaultContactLookup(deps.db))(accountId)), ...(sender !== null && pinRow?.screen === 'allow' ? [sender] : [])];
    const blocked = sender !== null && pinRow?.screen === 'block' ? [sender] : [];
    const signalsWith = (replyGraph: readonly string[]) =>
      extractSignals({
        headers,
        envelopeFrom,
        authVerdicts: authVerdictsOf,
        account: {
          addresses,
          replyGraph,
          contacts, // The account's CardDAV cards, and an Allow screen.
          pins: { vip: [], blocked },
        },
      });
    let signals = signalsWith([]);
    if (sender !== null && (await inReplyGraph(deps.db, { accountId, address: sender, before: input.inbound.receivedAt }))) {
      signals = signalsWith([sender]);
    }
    const model = await loadBayesModel(deps.db, accountId, tokens);
    const pin: PinInput | null = isFilingBucket(pinRow?.bucket ?? null) ? { bucket: pinRow?.bucket as FilingBucket } : null;
    const d = bucketFor({ signals, headers, subject: prior.parse.subject, pin }, { model, tokens });

    // A new-sender badge (PST-REQ-106): a first-time human this account has never heard from —
    // not in its reply graph, contacts or any pin/screen — offering Allow and Block. Recorded in the
    // scores (surfaced by the API as `newSender: true`) rather than a rule outcome, so it never
    // changes the filed bucket.
    const known = signals.membership.replyGraph.value || signals.membership.contact.value || signals.membership.vip.value || signals.membership.blocked.value || pinRow !== null;
    const newSender =
      signals.human.value &&
      !known &&
      !(await senderHasHistory(deps.db, { inboundMessageId: input.inbound.id, fromAddress: sender, accountIds: [accountId], before: input.inbound.receivedAt }));
    const dReasons = newSender ? [...d.reasons, `new-sender: first message from ${sender ?? 'unknown sender'}; offering Allow and Block`] : d.reasons;
    const dScores = newSender ? { ...d.scores, newSender: 1 } : d.scores;

    accounts[accountId] = { bucket: d.bucket, mailbox: d.folder, keyword: d.keyword, reasons: [...reasons, ...dReasons], scores: dScores };
  }
  return { bucket: 'sorted', accounts, senderHasHistory: history, attachmentQuarantine, attachments: findings, reasons };
}
