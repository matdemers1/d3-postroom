// Signal extraction for the self-sorting inbox (PST-T-5.2, PST-REQ-102, PST-REQ-173, PST-REQ-103).
//
// This package is pure: it takes a message's headers, its envelope From, the auth verdicts the
// worker already stored, and the account's own view of the world (its addresses, reply graph,
// contacts and pins), and produces named signals with human-readable reasons. Every decision
// carries its reasons (PST-ADR-007) — `decide` never returns an empty `reasons` array.
//
// Address matching is case-insensitive and strips a `+tag` and a trailing dot; the Gmail
// dot-in-local-part rule is deliberately NOT applied (two Gmail addresses that differ only by dots
// are treated as different addresses here).

import { decodeEncodedWords, parseMailboxes } from '@postroom/mime';
import { automatedLocalWord, describeCues, senderShape, type SenderShape } from './sender.js';

/** The minimal shape a header field needs to have; `@postroom/mime`'s `HeaderField` satisfies it. */
export interface HeaderLike {
  readonly name: string;
  readonly value: string;
}

/** The minimal shape of one auth mechanism's stored verdict; only `result` is read. */
export interface AuthResultLike {
  readonly result?: string;
}

/** The minimal shape of the stored DMARC verdict. */
export interface DmarcResultLike extends AuthResultLike {
  readonly alignment?: {
    readonly spf?: { readonly aligned?: boolean };
    readonly dkim?: { readonly aligned?: boolean };
  };
}

export interface AuthVerdicts {
  readonly spf?: AuthResultLike | null;
  readonly dkim?: readonly AuthResultLike[] | null;
  readonly dmarc?: DmarcResultLike | null;
  readonly arc?: AuthResultLike | null;
}

export interface AccountPins {
  readonly vip: Iterable<string>;
  readonly blocked?: Iterable<string>;
}

export interface AccountContext {
  /** The account's own addresses, including aliases. */
  readonly addresses: Iterable<string>;
  /** Addresses the account has sent mail to. */
  readonly replyGraph: Iterable<string>;
  /** The account's saved contacts. */
  readonly contacts: Iterable<string>;
  readonly pins: AccountPins;
}

export interface SignalInput {
  readonly headers: readonly HeaderLike[];
  readonly envelopeFrom: string | null;
  readonly authVerdicts: AuthVerdicts;
  readonly account: AccountContext;
}

/** A boolean signal with the reason it took that value. */
export interface Signal {
  readonly value: boolean;
  readonly reason: string;
}

export type Directness = 'to' | 'cc' | 'none';

export interface DirectnessSignal {
  readonly value: Directness;
  /** Number of addresses in the To header (0 when there was none). */
  readonly toCount: number;
  readonly reason: string;
}

export interface MembershipSignals {
  readonly replyGraph: Signal;
  readonly contact: Signal;
  readonly vip: Signal;
  readonly blocked: Signal;
}

export interface Signals {
  readonly fromAddress: string | null;
  readonly fromDisplayName: string;
  readonly bulk: Signal;
  readonly automated: Signal;
  readonly human: Signal;
  /** Sender-shape evidence (PST-T-5.9): does the From look like an organisation's system? */
  readonly transactional: Signal & { readonly shape: SenderShape };
  readonly directness: DirectnessSignal;
  readonly membership: MembershipSignals;
  readonly threadReply: Signal;
  readonly authenticated: Signal;
}

function headerGet(headers: readonly HeaderLike[], name: string): string | null {
  const key = name.toLowerCase();
  for (const h of headers) if (h.name.toLowerCase() === key) return h.value;
  return null;
}

function headerGetAll(headers: readonly HeaderLike[], name: string): string[] {
  const key = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === key).map((h) => h.value);
}

function headerHas(headers: readonly HeaderLike[], name: string): boolean {
  return headerGet(headers, name) !== null;
}

/** Lowercase, strip a `+tag` from the local part, and strip a trailing dot from the domain. Gmail's
 * dot-in-local-part folding is deliberately not applied. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return trimmed;
  let local = trimmed.slice(0, at);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  const domain = trimmed.slice(at + 1).replace(/\.+$/, '');
  return `${local}@${domain}`;
}

function normalizedSet(addresses: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const a of addresses) out.add(normalizeAddress(a));
  return out;
}

function addressOf(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  const lt = trimmed.indexOf('<');
  const gt = trimmed.indexOf('>');
  const spec = lt >= 0 && gt > lt ? trimmed.slice(lt + 1, gt) : trimmed;
  return spec.length === 0 ? null : spec;
}

const AUTOMATED_LOCAL_PART = /(^|[._-])(no-?reply|donotreply|notifications?)($|[._-])/i;

const BOUNCE_LOCAL_PART = /^(bounce|bounces|prvs|srs)([-+._]|$)/i;

const ESP_FINGERPRINT_HEADERS = ['x-ses-outgoing', 'x-sg-eid', 'x-mc-user'];

function isEspFingerprint(name: string): boolean {
  const key = name.toLowerCase();
  if (ESP_FINGERPRINT_HEADERS.includes(key)) return true;
  return key.startsWith('x-mailgun-');
}

function localAndDomain(address: string): { local: string; domain: string } {
  const at = address.lastIndexOf('@');
  if (at < 0) return { local: address, domain: '' };
  return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

function detectBulk(headers: readonly HeaderLike[], fromAddress: string | null): Signal {
  const listId = headerGet(headers, 'list-id');
  if (listId !== null) return { value: true, reason: `List-Id present ("${listId.trim()}") → bulk` };

  const listUnsubscribe = headerGet(headers, 'list-unsubscribe');
  if (listUnsubscribe !== null) return { value: true, reason: 'List-Unsubscribe present → bulk' };

  const precedence = headerGet(headers, 'precedence');
  if (precedence !== null && /^(bulk|list|junk)$/i.test(precedence.trim())) {
    return { value: true, reason: `Precedence: ${precedence.trim()} → bulk` };
  }

  const autoSubmitted = headerGet(headers, 'auto-submitted');
  if (autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== 'no') {
    return { value: true, reason: `Auto-Submitted: ${autoSubmitted.trim()} → bulk` };
  }

  if (headerHas(headers, 'x-auto-response-suppress')) {
    return { value: true, reason: 'X-Auto-Response-Suppress present → bulk' };
  }

  if (headerHas(headers, 'feedback-id')) {
    return { value: true, reason: 'Feedback-ID present → bulk' };
  }

  for (const h of headers) {
    if (isEspFingerprint(h.name)) return { value: true, reason: `${h.name} present (ESP fingerprint) → bulk` };
  }

  const returnPathAddr = addressOf(headerGet(headers, 'return-path'));
  if (returnPathAddr !== null && fromAddress !== null) {
    const rp = localAndDomain(normalizeAddress(returnPathAddr));
    const from = localAndDomain(normalizeAddress(fromAddress));
    if (rp.domain !== from.domain && BOUNCE_LOCAL_PART.test(rp.local)) {
      return { value: true, reason: `Return-Path ${rp.local}@${rp.domain} is bounce-style and differs from From domain ${from.domain} → bulk` };
    }
  }

  return { value: false, reason: 'no bulk markers found' };
}

function detectAutomated(fromAddress: string | null): Signal {
  if (fromAddress === null) return { value: false, reason: 'no From address to inspect' };
  const { local } = localAndDomain(normalizeAddress(fromAddress));
  if (AUTOMATED_LOCAL_PART.test(local)) {
    return { value: true, reason: `From local part "${local}" looks automated (noreply-style)` };
  }
  const word = automatedLocalWord(local);
  if (word !== null) return { value: true, reason: `From local part "${local}" looks automated (noreply-style: "${word}")` };
  return { value: false, reason: 'From local part does not look automated' };
}

function detectTransactional(fromAddress: string | null, displayName: string, subject: string, threadReply: boolean): Signal & { shape: SenderShape } {
  const shape = senderShape({ address: fromAddress === null ? '' : normalizeAddress(fromAddress), displayName, subject, threadReply });
  const summary = `transactional ${shape.transactionalScore} [${describeCues(shape.cues, 'transactional')}] vs personal ${shape.personalScore} [${describeCues(shape.cues, 'personal')}]`;
  if (shape.transactional) return { value: true, shape, reason: `sender looks transactional: ${summary}` };
  return { value: false, shape, reason: `sender does not look transactional: ${summary}` };
}

/** Human unless bulk, automated, or transactional sender-shape evidence outweighs personal evidence
 * (PST-T-5.9). A known correspondent — reply graph, contacts or a VIP pin — stays human whatever
 * their address looks like (billing@ a supplier you write to is still that supplier's person); only
 * bulk and noreply-style senders are never human, known or not. */
function detectHuman(bulk: Signal, automated: Signal, transactional: Signal & { shape: SenderShape }, membership: MembershipSignals, fromAddress: string | null, displayName: string): Signal {
  if (bulk.value) return { value: false, reason: 'bulk mail is not a human sender' };
  if (automated.value) return { value: false, reason: 'automated sender is not human' };
  if (fromAddress === null) return { value: false, reason: 'no From address to inspect' };
  const member = membership.replyGraph.value ? 'reply graph' : membership.contact.value ? 'contacts' : membership.vip.value ? 'VIP pins' : null;
  if (transactional.value) {
    if (member !== null) return { value: true, reason: `known correspondent (${member}) overrides transactional sender cues: ${transactional.reason}` };
    return { value: false, reason: `not a human sender — ${transactional.reason}` };
  }
  const name = displayName.trim();
  const shape = transactional.shape;
  if (shape.transactionalScore > 0) {
    return { value: true, reason: `human sender${name !== '' ? ` ("${name}")` : ''}: personal evidence holds — ${transactional.reason.replace(/^sender does not look transactional: /, '')}` };
  }
  if (name !== '') return { value: true, reason: `has a personal display name ("${name}") and no transactional sender cues` };
  return { value: true, reason: 'not a role address and not bulk or automated' };
}

function detectDirectness(headers: readonly HeaderLike[], accountAddresses: Set<string>): DirectnessSignal {
  const toValues = headerGetAll(headers, 'to');
  const toMailboxes = toValues.flatMap((v) => parseMailboxes(v));
  const toCount = toMailboxes.length;
  const toMatch = toMailboxes.some((m) => accountAddresses.has(normalizeAddress(m.address)));
  if (toMatch) return { value: 'to', toCount, reason: 'addressed directly (To)' };

  const ccValues = headerGetAll(headers, 'cc');
  const ccMailboxes = ccValues.flatMap((v) => parseMailboxes(v));
  const ccMatch = ccMailboxes.some((m) => accountAddresses.has(normalizeAddress(m.address)));
  if (ccMatch) return { value: 'cc', toCount, reason: 'only on Cc, not addressed directly' };

  return { value: 'none', toCount, reason: 'account address not present in To or Cc (bcc or list expansion)' };
}

function membershipSignal(label: string, fromAddress: string | null, set: Set<string>): Signal {
  if (fromAddress === null) return { value: false, reason: `no From address to check against ${label}` };
  const normalized = normalizeAddress(fromAddress);
  if (set.has(normalized)) return { value: true, reason: `sender in ${label}` };
  return { value: false, reason: `sender not in ${label}` };
}

function subjectOf(headers: readonly HeaderLike[]): string {
  const raw = headerGet(headers, 'subject');
  if (raw === null) return '';
  try {
    return decodeEncodedWords(raw);
  } catch {
    return raw;
  }
}

function detectThreadReply(headers: readonly HeaderLike[]): Signal {
  if (headerHas(headers, 'in-reply-to')) return { value: true, reason: 'In-Reply-To present → thread reply' };
  if (headerHas(headers, 'references')) return { value: true, reason: 'References present → thread reply' };
  return { value: false, reason: 'no In-Reply-To or References' };
}

function detectAuthenticated(auth: AuthVerdicts): Signal {
  const dmarc = auth.dmarc;
  if (dmarc !== null && dmarc !== undefined && dmarc.result === 'pass') {
    return { value: true, reason: 'DMARC pass (aligned SPF or DKIM)' };
  }
  return { value: false, reason: `DMARC did not pass (${dmarc?.result ?? 'no verdict'})` };
}

/** Extract every signal this task owns from a message's headers, envelope and account context.
 * Never throws — an arbitrary or malformed header list degrades to "no signal found", not a crash. */
export function extractSignals(input: SignalInput): Signals {
  const { headers, account } = input;

  const fromValue = headerGet(headers, 'from');
  const fromMailboxes = fromValue === null ? [] : parseMailboxes(fromValue);
  const fromMailbox = fromMailboxes[0];
  const fromAddress = fromMailbox === undefined || fromMailbox.address === '' ? input.envelopeFrom : fromMailbox.address;
  const fromDisplayName = fromMailbox?.name ?? '';

  const bulk = detectBulk(headers, fromAddress);
  const automated = detectAutomated(fromAddress);

  const accountAddresses = normalizedSet(account.addresses);
  const directness = detectDirectness(headers, accountAddresses);

  const membership: MembershipSignals = {
    replyGraph: membershipSignal('reply graph', fromAddress, normalizedSet(account.replyGraph)),
    contact: membershipSignal('contacts', fromAddress, normalizedSet(account.contacts)),
    vip: membershipSignal('VIP pins', fromAddress, normalizedSet(account.pins.vip)),
    blocked: membershipSignal('blocked pins', fromAddress, normalizedSet(account.pins.blocked ?? [])),
  };

  const threadReply = detectThreadReply(headers);
  const authenticated = detectAuthenticated(input.authVerdicts);

  const transactional = detectTransactional(fromAddress, fromDisplayName, subjectOf(headers), threadReply.value);
  const human = detectHuman(bulk, automated, transactional, membership, fromAddress, fromDisplayName);

  return {
    fromAddress,
    fromDisplayName,
    bulk,
    automated,
    human,
    transactional,
    directness,
    membership,
    threadReply,
    authenticated,
  };
}
