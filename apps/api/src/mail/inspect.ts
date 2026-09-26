// GET /api/messages/:id/inspect — the Inspect drawer's evidence for one message (PST-T-6.1,
// PST-REQ-114). "Shows everything": every section is built from what Postroom already stored or
// can read back from the message itself — nothing here decides anything new, and nothing is
// fetched from anywhere else.
//
//   auth       SPF, DKIM[], DMARC, ARC and DNSBL exactly as smtp-in stored them (message_verdict.auth,
//              else the spool row's verdicts), each with its reasons, plus the Authentication-Results
//              fields in the message. Alignment is READ from DMARC's own reasons ("SPF pass for x,
//              relaxedly aligned with y") — the evaluator's words, not a second opinion computed here.
//   received   The Received path, oldest hop first: from/by/with/id/for, the client IP, TLS (version
//              and cipher when a hop wrote them), the hop's timestamp and the delay since the previous
//              hop. Our own hop is marked, and `receipt` adds what the InboundSession recorded.
//   bucket     Why this bucket: the stored bucket, every reason, every score (PST-REQ-103).
//   spam       The classifier's rule signals, the Bayes probabilities, training size and top tokens
//              (parsed back out of the stored "bayes: …" reason), and the attachment policy findings.
//   trackers   The usercontent sanitiser's counts for this message's HTML (PST-REQ-116).
//   mdn        Whether the sender asked for a read receipt (Disposition-Notification-To, RFC 8098
//              §2.1), to whom, and whether Return-Path matches. Sending one is PST-T-9.2: never here.
//   headers    Every top-level header field, in order, encoded-words decoded.
//   raw        Where the RFC 5322 source downloads from, and its size.
//   crypto     PGP/MIME, inline PGP and S/MIME: signature verification and decryption status
//              (PST-T-12.1, PST-REQ-160), from @postroom/pgp over the stored message, with this
//              account's crypto_key rows as the only keys that make a signature 'verified-known-key'.
import { collectMessage, decodeEncodedWords, parseDate, parseMailboxes, type MessageSummary as MimeSummary } from '@postroom/mime';
import type { Db, InboundMessage, InboundSession, Message, MessageVerdict } from '@postroom/db';
import type { Kek } from '@postroom/crypto';
import { analyzeMessage, type CryptoReport } from '@postroom/pgp';
import { z } from 'zod';
import type { BlobStore } from '@postroom/blobstore';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';
import { sanitizeHtml } from '../usercontent/sanitize.js';
import { IdParams } from './schemas.js';
import { loadAccountKeys } from './crypto-keys.js';

// ---------------------------------------------------------------------------------------------
// Response schema

const Iso = z.iso.datetime();
const Reasons = z.array(z.string());
const Alignment = z
  .object({ aligned: z.boolean(), mode: z.enum(['relaxed', 'strict']).nullable() })
  .nullable()
  .describe("Alignment with the From domain as DMARC's evaluator stated it in its reasons; null when it did not say.");

export const InspectSpf = z.object({
  result: z.string(),
  domain: z.string().nullable(),
  scope: z.string().nullable(),
  mechanism: z.string().nullable(),
  alignment: Alignment,
  reasons: Reasons,
});
export const InspectDkim = z.object({
  result: z.string(),
  domain: z.string().nullable(),
  selector: z.string().nullable(),
  algorithm: z.string().nullable(),
  testing: z.boolean(),
  alignment: Alignment,
  reasons: Reasons,
});
export const InspectDmarc = z.object({
  result: z.string(),
  disposition: z.string().nullable(),
  fromDomain: z.string().nullable(),
  policy: z.string().nullable(),
  policySource: z.string().nullable(),
  recordDomain: z.string().nullable(),
  reasons: Reasons,
});
export const InspectArc = z.object({
  result: z.string(),
  instances: z.number().int().nullable(),
  sealerDomains: z.array(z.string()),
  reasons: Reasons,
});
export const InspectDnsbl = z.object({ listed: z.boolean(), zone: z.string().nullable(), reason: z.string().nullable() });

export const InspectAuth = z.object({
  source: z.enum(['verdict', 'inbound', 'none']).describe('Where the verdicts came from: the filed message\'s verdict, the spool row, or nowhere (e.g. your own Sent copy).'),
  spf: InspectSpf.nullable(),
  dkim: z.array(InspectDkim),
  dmarc: InspectDmarc.nullable(),
  arc: InspectArc.nullable(),
  arcOverride: z.array(z.string()).nullable().describe('Why a trusted ARC sealer overrode a DMARC failure, when it did.'),
  dnsbl: InspectDnsbl.nullable(),
  authenticationResults: z.array(z.string()).describe('Every Authentication-Results field in the message, top first (RFC 8601).'),
});

export const ReceivedHop = z.object({
  raw: z.string(),
  from: z.string().nullable(),
  fromRdns: z.string().nullable(),
  fromIp: z.string().nullable(),
  by: z.string().nullable(),
  via: z.string().nullable(),
  with: z.string().nullable().describe('The protocol (RFC 5321 §4.4, RFC 3848): ESMTPS means the hop was encrypted.'),
  id: z.string().nullable(),
  for: z.string().nullable(),
  tls: z.object({ encrypted: z.boolean(), version: z.string().nullable(), cipher: z.string().nullable() }),
  timestamp: Iso.nullable(),
  delaySeconds: z.number().nullable().describe('Seconds since the previous (older) hop; null for the first or when either date is unreadable.'),
  ours: z.boolean().describe('Written by this Postroom server.'),
});

export const InboundReceipt = z.object({
  sessionId: z.string().nullable(),
  clientIp: z.string().nullable(),
  proxied: z.boolean(),
  helo: z.string().nullable(),
  rdns: z.string().nullable(),
  tls: z.string().nullable(),
  sessionStartedAt: Iso.nullable(),
  receivedAt: Iso,
  envelopeFrom: z.string(),
  disposition: z.string(),
  dispositionReason: z.string().nullable(),
  smtpReply: z.string().nullable().describe('The SMTP reply smtp-in actually sent at the end of DATA.'),
  decision: z.object({ action: z.string(), rule: z.string().nullable(), reasons: Reasons }).nullable(),
});

const Score = z.object({ name: z.string(), value: z.number() });

export const InspectBucket = z.object({
  bucket: z.string().nullable(),
  reasons: Reasons,
  scores: z.array(Score).describe('Every score stored with the decision (PST-REQ-103), by name.'),
});

export const InspectSpam = z.object({
  signals: z.array(Score).describe('The rule classifier\'s signals (bulk, automated, human, transactional, …).'),
  bayes: z
    .object({
      probabilities: z.array(z.object({ bucket: z.string(), probability: z.number() })),
      trainingDocs: z.number().nullable(),
      topTokens: z.array(z.string()),
      reason: z.string().nullable(),
    })
    .nullable(),
  attachments: z.array(z.object({ partId: z.string(), filename: z.string().nullable(), verdict: z.string(), kind: z.string().nullable(), reasons: Reasons })),
});

export const InspectTrackers = z.object({
  html: z.boolean().describe('Whether the message has an HTML part at all.'),
  remoteImages: z.number().int(),
  trackersBlocked: z.number().int(),
  linksCleaned: z.number().int(),
});

export const InspectMdn = z.object({
  requested: z.boolean(),
  to: z.array(z.string()),
  header: z.string().nullable(),
  options: z.string().nullable(),
  returnPath: z.string().nullable(),
  returnPathMatches: z.boolean().nullable().describe('RFC 8098 §2.1: a receipt to an address other than Return-Path needs the reader\'s say-so.'),
  sent: z.boolean().describe('Postroom never sends a receipt on its own; sending one is a separate, explicit step (PST-T-9.2).'),
});

const SignatureStatus = z
  .string()
  .describe(
    "'verified-known-key' (valid, and the key is one of this account's own or contact keys) | 'valid-signature-unknown-key' (valid, but the key or certificate came only with the message) | 'bad-signature' | 'not-signed' | 'unsupported:<reason>'.",
  );
const DecryptionStatus = z.string().describe("'decrypted' | 'no-key' | 'not-encrypted' | 'failed:<reason>'.");

export const InspectCryptoSigner = z.object({
  keyId: z.string().nullable().describe('OpenPGP key ID, or the certificate serial number.'),
  fingerprint: z.string().nullable().describe('OpenPGP v4 fingerprint, or the certificate SHA-256.'),
  algorithm: z.string().nullable(),
  hash: z.string().nullable(),
  userIds: z.array(z.string()).describe('User IDs of the key, or the certificate subject.'),
  addresses: z.array(z.string()).describe('Addresses the key or certificate speaks for (rfc822Name for S/MIME).'),
  fromMatches: z.boolean().nullable().describe('Whether the From address is one of `addresses`; null when either is unknown.'),
  createdAt: Iso.nullable().describe('Signature creation time (OpenPGP) or signingTime (S/MIME).'),
  keySource: z.enum(['account', 'message', 'none']).describe("Where the key came from: this account's keys, the message itself (never trusted on its own), or nowhere."),
  knownKeyId: z.string().nullable().describe('The crypto_key row that matched.'),
  owner: z.enum(['own', 'contact']).nullable(),
});

export const InspectCertificate = z.object({
  subject: z.string(),
  issuer: z.string(),
  fingerprint: z.string(),
  serial: z.string(),
  notBefore: Iso,
  notAfter: Iso,
  rfc822Names: z.array(z.string()),
  selfSigned: z.boolean(),
  signatureVerified: z.boolean().describe('Signed by the next certificate presented (or by itself, when self-signed).'),
});

export const InspectCrypto = z.object({
  signature: z.object({
    status: SignatureStatus,
    format: z.enum(['pgp-mime', 'pgp-inline', 'pgp-encrypted', 'smime', 'smime-opaque']).nullable(),
    reasons: Reasons,
    signer: InspectCryptoSigner.nullable(),
    certificates: z.array(InspectCertificate).describe('S/MIME: the certificate chain as presented in the message, signer first.'),
    chain: z
      .object({ verified: z.boolean(), endsAtSelfSigned: z.boolean(), reason: z.string() })
      .nullable()
      .describe('Whether the chain verifies up to what the message carried. No system trust store is consulted.'),
  }),
  encryption: z.object({
    status: DecryptionStatus,
    format: z.enum(['pgp-mime', 'pgp-inline', 'smime']).nullable(),
    reasons: Reasons,
    recipients: z.array(z.object({ id: z.string(), algorithm: z.string().nullable(), matchedKeyId: z.string().nullable() })),
    cipher: z.string().nullable(),
    integrity: z.string().nullable(),
    openedWithKeyId: z.string().nullable(),
    plaintextBytes: z.number().int().nullable(),
  }),
});

export const MessageInspect = z.object({
  id: z.uuid(),
  auth: InspectAuth,
  received: z.array(ReceivedHop).describe('The Received path, oldest hop first.'),
  receipt: InboundReceipt.nullable().describe('What smtp-in recorded about the session that delivered it here; null for mail that did not arrive over SMTP.'),
  bucket: InspectBucket.nullable(),
  spam: InspectSpam,
  trackers: InspectTrackers,
  mdn: InspectMdn,
  headers: z.array(z.object({ name: z.string(), value: z.string() })),
  raw: z.object({ url: z.string(), size: z.number().int() }),
  crypto: InspectCrypto.describe('PGP/MIME, inline PGP and S/MIME signature and decryption status (PST-REQ-160).'),
});

export type MessageInspectJson = z.infer<typeof MessageInspect>;
export type ReceivedHopJson = z.infer<typeof ReceivedHop>;
export type InspectCryptoJson = z.infer<typeof InspectCrypto>;

/** What the drawer shows when the analysis could not run at all. */
export function cryptoUnavailable(reason: string): InspectCryptoJson {
  return {
    signature: { status: `unsupported:${reason}`, format: null, reasons: [], signer: null, certificates: [], chain: null },
    encryption: { status: 'not-encrypted', format: null, reasons: [], recipients: [], cipher: null, integrity: null, openedWithKeyId: null, plaintextBytes: null },
  };
}

/** The pgp package's report, as the schema describes it. */
export function cryptoSection(report: CryptoReport): InspectCryptoJson {
  return { signature: report.signature, encryption: report.encryption };
}

// ---------------------------------------------------------------------------------------------
// Received (RFC 5321 §4.4): a small, forgiving clause reader.
//
//   Received: from <domain> (<comment>) by <domain> (<comment>) [via …] [with <protocol>] [id …]
//             [for <path>] (<comment>)* ; <date-time>
//
// Real-world hops add free text ("with Microsoft SMTP Server (version=TLS1_2, cipher=…)"), so a
// word that is not a clause keyword extends the current clause's value. TLS is read from the
// protocol (RFC 3848's trailing S) and from the comments the big MTAs write:
//   Postfix   (using TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits))
//   Sendmail / Exchange  (version=TLS1.3 cipher=TLS_AES_256_GCM_SHA384 bits=256)
//   Gmail     (Google Transport Security)

const KEYWORDS = new Set(['from', 'by', 'via', 'with', 'id', 'for']);
type Clause = 'from' | 'by' | 'via' | 'with' | 'id' | 'for';

/** Index of the last `;` outside a comment, or -1. */
function lastSemicolon(value: string): number {
  let depth = 0;
  let at = -1;
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c === '\\') i++;
    else if (c === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
    else if (c === ';' && depth === 0) at = i;
  }
  return at;
}

const ENCRYPTED_PROTOCOL = /^(?:E|UTF8)?(?:SMTP|LMTP)SA?$/i;

export function readTls(protocol: string | null, comments: readonly string[]): { encrypted: boolean; version: string | null; cipher: string | null } {
  let version: string | null = null;
  let cipher: string | null = null;
  let transportSecurity = false;
  for (const c of comments) {
    version ??= /\bversion=([A-Za-z0-9_.v]+)/.exec(c)?.[1] ?? /\busing\s+(TLSv?[\d.]+|SSLv?[\d.]+)/i.exec(c)?.[1] ?? null;
    cipher ??= /\bcipher=([A-Za-z0-9_-]+)/.exec(c)?.[1] ?? /\bwith cipher\s+([A-Za-z0-9_-]+)/i.exec(c)?.[1] ?? null;
    if (/transport security/i.test(c)) transportSecurity = true;
  }
  const word = protocol?.split(/\s+/)[0] ?? '';
  const encrypted = ENCRYPTED_PROTOCOL.test(word) || version !== null || cipher !== null || transportSecurity;
  return { encrypted, version, cipher };
}

/** One Received field's value, unfolded. Never throws: an unreadable hop keeps its raw text. */
export function parseReceived(value: string): Omit<ReceivedHopJson, 'delaySeconds'> {
  const semi = lastSemicolon(value);
  const clausesText = semi < 0 ? value : value.slice(0, semi);
  const dateText = semi < 0 ? '' : value.slice(semi + 1).trim();
  const date = dateText === '' ? null : parseDate(dateText);

  const values: Partial<Record<Clause, string>> = {};
  const commentsOf: Partial<Record<Clause | 'none', string[]>> = {};
  let current: Clause | 'none' = 'none';
  let expectValue = false;
  let i = 0;
  while (i < clausesText.length) {
    const c = clausesText.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      let depth = 0;
      let j = i;
      for (; j < clausesText.length; j++) {
        const d = clausesText.charAt(j);
        if (d === '\\') j++;
        else if (d === '(') depth++;
        else if (d === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const comment = clausesText.slice(i + 1, Math.min(j, clausesText.length)).trim();
      (commentsOf[current] ??= []).push(comment);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < clausesText.length && !/[\s(]/.test(clausesText.charAt(j))) j++;
    const word = clausesText.slice(i, j);
    i = j;
    const lower = word.toLowerCase();
    if (KEYWORDS.has(lower) && !expectValue && !(lower in values)) {
      current = lower as Clause;
      expectValue = true;
      continue;
    }
    if (current === 'none') continue;
    values[current] = values[current] === undefined ? word : `${values[current]} ${word}`;
    expectValue = false;
  }

  const fromComments = commentsOf.from ?? [];
  let fromIp: string | null = null;
  let fromRdns: string | null = null;
  for (const text of [values.from ?? '', ...fromComments]) {
    const ip = /\[(?:IPv6:)?([0-9A-Fa-f:.]+)\]/.exec(text)?.[1];
    if (ip !== undefined && fromIp === null) fromIp = ip;
  }
  const firstComment = fromComments[0];
  if (firstComment !== undefined) {
    const word = firstComment.split(/\s+/)[0] ?? '';
    if (word !== '' && !word.startsWith('[') && word.toLowerCase() !== 'unknown' && word.includes('.')) fromRdns = word.replace(/[[\]]/g, '');
  }
  const allComments = Object.values(commentsOf).flat();
  const withValue = values.with ?? null;
  const forValue = values.for === undefined ? null : values.for.replace(/^<|>$/g, '');
  return {
    raw: value,
    from: values.from ?? null,
    fromRdns,
    fromIp,
    by: values.by ?? null,
    via: values.via ?? null,
    with: withValue,
    id: values.id ?? null,
    for: forValue,
    tls: readTls(withValue, allComments),
    timestamp: date === null ? null : date.toISOString(),
    ours: (commentsOf.by ?? []).some((c) => /^Postroom\b/.test(c)),
  };
}

/** The Received fields as they appear (newest first) → the path, oldest hop first, with delays. */
export function receivedPath(valuesNewestFirst: readonly string[]): ReceivedHopJson[] {
  const hops = [...valuesNewestFirst].reverse().map(parseReceived);
  return hops.map((hop, index) => {
    const previous = index === 0 ? undefined : hops[index - 1];
    const delaySeconds =
      previous === undefined || previous.timestamp === null || hop.timestamp === null ? null : Math.round((Date.parse(hop.timestamp) - Date.parse(previous.timestamp)) / 1000);
    return { ...hop, delaySeconds };
  });
}

// ---------------------------------------------------------------------------------------------
// Verdicts: tolerant readers over stored JSON (older rows may lack a field; nothing here throws).

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** What DMARC's reasons say about one identifier's alignment (packages/auth-checks' wording). */
export function alignmentFromReasons(reasons: readonly string[], kind: 'spf' | 'dkim', domain: string | null): z.infer<typeof Alignment> {
  if (domain === null) return null;
  const d = domain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const subject = kind === 'spf' ? `SPF pass for ${d}` : `DKIM pass for d=${d}`;
  for (const r of reasons) {
    const not = new RegExp(`^${subject} is not (relaxed|strict)ly aligned`, 'i').exec(r);
    if (not !== null) return { aligned: false, mode: (not[1]?.toLowerCase() ?? 'relaxed') as 'relaxed' | 'strict' };
    const yes = new RegExp(`^${subject}(?:,| is aligned) ?(?:(relaxed|strict)ly aligned)?`, 'i').exec(r);
    if (yes !== null) return { aligned: true, mode: (yes[1]?.toLowerCase() ?? null) as 'relaxed' | 'strict' | null };
  }
  return null;
}

export function authSection(stored: unknown, source: 'verdict' | 'inbound' | 'none', authenticationResults: string[]): z.infer<typeof InspectAuth> {
  const a = isObj(stored) ? stored : {};
  const dmarcRaw = isObj(a['dmarc']) ? a['dmarc'] : null;
  const dmarcReasons = dmarcRaw === null ? [] : strs(dmarcRaw['reasons']);
  const spfRaw = isObj(a['spf']) ? a['spf'] : null;
  const spfDomain = spfRaw === null ? null : str(spfRaw['domain']);
  const arcRaw = isObj(a['arc']) ? a['arc'] : null;
  const dnsblRaw = isObj(a['dnsbl']) ? a['dnsbl'] : null;
  const override = a['arcOverride'];
  return {
    source,
    spf:
      spfRaw === null
        ? null
        : {
            result: str(spfRaw['result']) ?? 'none',
            domain: spfDomain,
            scope: str(spfRaw['scope']),
            mechanism: str(spfRaw['mechanism']),
            alignment: alignmentFromReasons(dmarcReasons, 'spf', spfDomain),
            reasons: strs(spfRaw['reasons']),
          },
    dkim: (Array.isArray(a['dkim']) ? a['dkim'] : []).filter(isObj).map((d) => {
      const domain = str(d['domain']);
      return {
        result: str(d['result']) ?? 'none',
        domain,
        selector: str(d['selector']),
        algorithm: str(d['algorithm']),
        testing: d['testing'] === true,
        alignment: alignmentFromReasons(dmarcReasons, 'dkim', domain),
        reasons: strs(d['reasons']),
      };
    }),
    dmarc:
      dmarcRaw === null
        ? null
        : {
            result: str(dmarcRaw['result']) ?? 'none',
            disposition: str(dmarcRaw['disposition']),
            fromDomain: str(dmarcRaw['fromDomain']),
            policy: str(dmarcRaw['policy']),
            policySource: str(dmarcRaw['policySource']),
            recordDomain: str(dmarcRaw['recordDomain']),
            reasons: dmarcReasons,
          },
    arc:
      arcRaw === null
        ? null
        : { result: str(arcRaw['result']) ?? 'none', instances: num(arcRaw['instances']), sealerDomains: strs(arcRaw['sealerDomains']), reasons: strs(arcRaw['reasons']) },
    arcOverride: override === undefined || override === null ? null : isObj(override) ? strs(override['reasons']).concat(str(override['reason']) ?? []) : typeof override === 'string' ? [override] : [JSON.stringify(override)],
    dnsbl: dnsblRaw === null ? null : { listed: dnsblRaw['listed'] === true, zone: str(dnsblRaw['zone']), reason: str(dnsblRaw['reason']) },
    authenticationResults,
  };
}

/** "bayes: newsletters 0.87 (tokens: a, b, c); then receipts 0.10" → its top tokens. */
export function bayesTokens(reasons: readonly string[]): { reason: string | null; tokens: string[] } {
  for (const r of reasons) {
    if (!r.startsWith('bayes: ')) continue;
    const m = /\(tokens: ([^)]*)\)/.exec(r);
    const tokens = m?.[1] === undefined ? [] : m[1].split(', ').map((t) => t.trim()).filter((t) => t !== '');
    if (m !== null || /\(no distinguishing tokens\)/.test(r)) return { reason: r, tokens };
  }
  return { reason: null, tokens: [] };
}

/** Score keys that mark how the bucket was decided, rather than a signal that fed it. */
const DECISION_KEY = /^(?:bucket:|heuristic:)|^(?:pinned|sieveBucket|newSender)$/;

export function spamSection(verdict: Pick<MessageVerdict, 'scores' | 'reasons' | 'attachments'> | null): z.infer<typeof InspectSpam> {
  const scores = verdict !== null && isObj(verdict.scores) ? verdict.scores : {};
  const signals: { name: string; value: number }[] = [];
  const probabilities: { bucket: string; probability: number }[] = [];
  let trainingDocs: number | null = null;
  for (const [name, raw] of Object.entries(scores)) {
    const value = num(raw);
    if (value === null) continue;
    if (name === 'bayes:trainingDocs') trainingDocs = value;
    else if (name.startsWith('bayes:')) probabilities.push({ bucket: name.slice('bayes:'.length), probability: value });
    else if (!DECISION_KEY.test(name)) signals.push({ name, value });
  }
  probabilities.sort((x, y) => y.probability - x.probability);
  const b = bayesTokens(verdict?.reasons ?? []);
  const bayes = probabilities.length === 0 && trainingDocs === null && b.reason === null ? null : { probabilities, trainingDocs, topTokens: b.tokens, reason: b.reason };
  const rawAttachments: unknown[] = Array.isArray(verdict?.attachments) ? verdict.attachments : [];
  const attachments = rawAttachments.filter(isObj).map((f) => ({
    partId: str(f['partId']) ?? '',
    filename: str(f['filename']),
    verdict: str(f['verdict']) ?? 'ok',
    kind: str(f['kind']),
    reasons: strs(f['reasons']),
  }));
  return { signals, bayes, attachments };
}

export function bucketSection(verdict: Pick<MessageVerdict, 'bucket' | 'reasons' | 'scores'> | null): z.infer<typeof InspectBucket> | null {
  if (verdict === null) return null;
  const scores = isObj(verdict.scores) ? verdict.scores : {};
  return {
    bucket: verdict.bucket,
    reasons: verdict.reasons,
    scores: Object.entries(scores)
      .map(([name, v]) => ({ name, value: num(v) }))
      .filter((s): s is { name: string; value: number } => s.value !== null),
  };
}

const bare = (addr: string | null): string | null => {
  if (addr === null) return null;
  const inside = /<([^<>]*)>/.exec(addr)?.[1] ?? addr;
  const t = inside.trim().toLowerCase();
  return t === '' ? null : t;
};

/** RFC 8098 §2.1/§2.2: the read-receipt request, if any. Nothing is ever sent from here. */
export function mdnSection(headers: readonly { name: string; value: string }[]): z.infer<typeof InspectMdn> {
  const get = (n: string): string | null => headers.find((h) => h.name.toLowerCase() === n)?.value ?? null;
  const header = get('disposition-notification-to');
  const to = header === null ? [] : parseMailboxes(header).map((m) => m.address).filter((a) => a !== '');
  const returnPath = get('return-path');
  const rp = bare(returnPath);
  return {
    requested: header !== null,
    to,
    header,
    options: get('disposition-notification-options'),
    returnPath,
    returnPathMatches: header === null || rp === null ? null : to.length > 0 && to.every((a) => a.toLowerCase() === rp),
    sent: false,
  };
}

// ---------------------------------------------------------------------------------------------
// The whole object

type InboundWithSession = InboundMessage & { session: InboundSession | null };

export function receiptOf(inbound: InboundWithSession | null): z.infer<typeof InboundReceipt> | null {
  if (inbound === null) return null;
  const v = isObj(inbound.verdicts) ? inbound.verdicts : {};
  const d = isObj(v['decision']) ? v['decision'] : null;
  const s = inbound.session;
  return {
    sessionId: s?.id ?? null,
    clientIp: s?.clientIp ?? null,
    proxied: s?.proxied ?? false,
    helo: s?.helo ?? null,
    rdns: s?.rdns ?? null,
    tls: s?.tls ?? null,
    sessionStartedAt: s === null ? null : s.startedAt.toISOString(),
    receivedAt: inbound.receivedAt.toISOString(),
    envelopeFrom: inbound.envelopeFrom,
    disposition: inbound.disposition,
    dispositionReason: inbound.dispositionReason,
    smtpReply: inbound.smtpReply,
    decision: d === null ? null : { action: str(d['action']) ?? 'accept', rule: str(d['rule']), reasons: strs(d['reasons']) },
  };
}

export function buildInspect(
  message: Message & { verdict: MessageVerdict | null },
  inbound: InboundWithSession | null,
  summary: MimeSummary,
  rawUrl: string,
  crypto: InspectCryptoJson = cryptoUnavailable('not-analysed'),
): MessageInspectJson {
  const fields = summary.headers.fields;
  const headers = fields.map((f) => ({ name: f.name, value: decodeEncodedWords(f.value) }));
  const received = fields.filter((f) => f.key === 'received').map((f) => f.value);
  const authResults = fields.filter((f) => f.key === 'authentication-results').map((f) => f.value);

  const verdictAuth = message.verdict?.auth;
  const hasVerdictAuth = isObj(verdictAuth) && Object.keys(verdictAuth).length > 0;
  const inboundAuth = inbound !== null && isObj(inbound.verdicts) && Object.keys(inbound.verdicts).length > 0 ? inbound.verdicts : null;
  const auth = hasVerdictAuth
    ? authSection(verdictAuth, 'verdict', authResults)
    : inboundAuth !== null
      ? authSection(inboundAuth, 'inbound', authResults)
      : authSection(null, 'none', authResults);

  const stats = summary.html === null ? null : sanitizeHtml(summary.html.text);
  return {
    id: message.id,
    auth,
    received: receivedPath(received),
    receipt: receiptOf(inbound),
    bucket: bucketSection(message.verdict),
    spam: spamSection(message.verdict),
    trackers: { html: summary.html !== null, remoteImages: stats?.remoteImages ?? 0, trackersBlocked: stats?.trackersBlocked ?? 0, linksCleaned: stats?.linksCleaned ?? 0 },
    mdn: mdnSection(headers),
    headers,
    raw: { url: rawUrl, size: message.size },
    crypto,
  };
}

export interface InspectOptions {
  /** Opens this account's sealed private keys for decryption; without it, decryption reports failed:private-key-unavailable. */
  kek?: Kek | null;
}

/**
 * Signature and decryption status (PST-REQ-160): a second streamed read of the stored message
 * through @postroom/pgp. A failure here never fails the rest of the drawer.
 */
export async function inspectCrypto(db: Db, blobs: BlobStore, message: Message, opts: InspectOptions = {}): Promise<InspectCryptoJson> {
  const mailbox = await db.mailbox.findUnique({ where: { id: message.mailboxId }, select: { accountId: true } });
  if (mailbox === null) return cryptoUnavailable('no-mailbox');
  const keys = await loadAccountKeys(db, mailbox.accountId, opts.kek ?? null);
  try {
    return cryptoSection(await analyzeMessage(await blobs.get(message.blobSha256), keys));
  } catch (err) {
    return cryptoUnavailable(`analysis-failed:${err instanceof Error ? err.name : 'error'}`);
  }
}

/** Reads the message back from the blob store and assembles the evidence. */
export async function inspectMessage(db: Db, blobs: BlobStore, message: Message & { verdict: MessageVerdict | null }, opts: InspectOptions = {}): Promise<MessageInspectJson> {
  const inbound = message.inboundMessageId === null ? null : await db.inboundMessage.findUnique({ where: { id: message.inboundMessageId }, include: { session: true } });
  const summary = await collectMessage(await blobs.get(message.blobSha256));
  const crypto = await inspectCrypto(db, blobs, message, opts);
  return buildInspect(message, inbound, summary, `/api/messages/${message.id}/raw`, crypto);
}

// ---------------------------------------------------------------------------------------------
// OpenAPI (PST-REQ-085): spread into src/openapi/document.ts.

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });

export const INSPECT_COMPONENTS: Record<string, z.ZodType> = { MessageInspect };

export const INSPECT_ROUTES: RouteSpec[] = [
  {
    method: 'get',
    path: '/api/messages/{id}/inspect',
    operationId: 'inspectMessage',
    tag: 'Messages',
    summary: 'Everything Postroom knows about one message, with its reasons (PST-REQ-114).',
    description:
      'Authentication verdicts with their evidence, the Received path with TLS per hop, the session that delivered it, why it is in its bucket, the spam-score breakdown, trackers removed, the read-receipt request, every header, where the raw source downloads from, and PGP/S/MIME signature and decryption status (PST-REQ-160). A read: nothing is stored and nothing is fetched from anywhere else.',
    params: IdParams,
    responses: {
      '200': { description: 'The evidence.', schema: 'MessageInspect' },
      '400': err('The request failed validation.'),
      '401': err('No session.'),
      '404': err('Not a message of the caller.'),
      '503': err('POSTROOM_KEK is not set, so the message cannot be read back.'),
    },
  },
];
