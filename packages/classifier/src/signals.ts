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

import { parseMailboxes } from '@postroom/mime';

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

const ROLE_LOCAL_PARTS = new Set([
  'info',
  'support',
  'sales',
  'admin',
  'administrator',
  'billing',
  'contact',
  'help',
  'abuse',
  'postmaster',
  'webmaster',
  'marketing',
  'careers',
  'jobs',
  'press',
  'hello',
  'team',
]);

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
  return { value: false, reason: 'From local part does not look automated' };
}

function detectHuman(bulk: Signal, automated: Signal, fromAddress: string | null, displayName: string): Signal {
  if (bulk.value) return { value: false, reason: 'bulk mail is not a human sender' };
  if (automated.value) return { value: false, reason: 'automated sender is not human' };
  if (fromAddress === null) return { value: false, reason: 'no From address to inspect' };
  const { local } = localAndDomain(normalizeAddress(fromAddress));
  const isRole = ROLE_LOCAL_PARTS.has(local);
  if (displayName.trim() !== '') return { value: true, reason: `has a personal display name ("${displayName.trim()}")` };
  if (!isRole) return { value: true, reason: 'not a role address and not bulk or automated' };
  return { value: false, reason: `role address "${local}" with no display name` };
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
  const human = detectHuman(bulk, automated, fromAddress, fromDisplayName);

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

  return {
    fromAddress,
    fromDisplayName,
    bulk,
    automated,
    human,
    directness,
    membership,
    threadReply,
    authenticated,
  };
}
