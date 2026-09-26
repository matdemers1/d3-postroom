// Phishing and lookalike-domain detection with stated reasons (PST-T-6.5, PST-REQ-120).
//
// Pure and deterministic: no DNS, no network, no clock. `detectPhish` takes a message's From
// (and optionally Reply-To/Return-Path), the auth verdicts already stored by smtp-in/the worker
// (@postroom/classifier's `AuthVerdicts` shape), the account's view of who it has corresponded
// with, and the HTML part's links, and returns a list of warnings — each with a human-readable
// `reason` (PST-ADR-007: every decision carries its reasons). Never throws, and a warning's reason
// is never empty (checked by a fast-check property in test/unit).
import { decodeIdnLabel } from './punycode.js';
import { editDistance, scriptsOf, skeleton } from './skeleton.js';

export const PACKAGE = '@postroom/phish';

// ---------------------------------------------------------------------------------------------
// Input shapes

export interface PhishAddress {
  readonly address: string;
  readonly displayName?: string | null;
}

/** The minimal shape of one auth mechanism's stored verdict; matches @postroom/classifier's AuthResultLike. */
export interface PhishAuthResult {
  readonly result?: string;
}

export interface PhishDmarcResult extends PhishAuthResult {
  /** p= (or sp=/np=) as applied to this message: the policy the domain published. */
  readonly policy?: 'none' | 'quarantine' | 'reject';
  readonly disposition?: 'none' | 'quarantine' | 'reject';
}

/** Same shape smtp-in stores in `inbound_message.verdicts` / `message_verdict.auth` (see apps/smtp-in/src/data.ts). */
export interface PhishAuthVerdicts {
  readonly spf?: PhishAuthResult | null;
  readonly dkim?: readonly PhishAuthResult[] | null;
  readonly dmarc?: PhishDmarcResult | null;
  readonly arc?: PhishAuthResult | null;
}

export interface PhishContact {
  readonly name: string;
  readonly address: string;
}

export interface PhishKnownSenders {
  /** Addresses the account has sent to or received mail from before. */
  readonly addresses?: Iterable<string>;
  /** Domains the account has corresponded with before (a superset of the domains in `addresses`). */
  readonly domains?: Iterable<string>;
}

export interface PhishAccountContext {
  readonly knownSenders: PhishKnownSenders;
  readonly contacts?: Iterable<PhishContact>;
}

export interface PhishLink {
  readonly text: string;
  readonly href: string;
}

export interface DetectPhishInput {
  readonly from: PhishAddress;
  readonly replyTo?: PhishAddress | null;
  readonly returnPath?: string | null;
  readonly authVerdicts: PhishAuthVerdicts;
  readonly account: PhishAccountContext;
  /** Used only for "first-time sender claiming a known brand": the brand may be named in the subject rather than the display name. */
  readonly subject?: string | null;
  readonly links?: readonly PhishLink[];
}

// ---------------------------------------------------------------------------------------------
// Output shapes

export type PhishWarningKind =
  | 'display-name-spoofing'
  | 'lookalike-domain'
  | 'punycode-domain'
  | 'first-time-brand-sender'
  | 'auth-failure'
  | 'link-mismatch';

export type PhishSeverity = 'low' | 'medium' | 'high';

export interface PhishWarning {
  readonly kind: PhishWarningKind;
  readonly severity: PhishSeverity;
  /** Human-readable, always non-empty: states exactly why this warning fired. */
  readonly reason: string;
}

export interface PhishResult {
  readonly warnings: PhishWarning[];
}

// ---------------------------------------------------------------------------------------------
// A small, curated brand list. Not exhaustive — the point is to catch the handful of brands that
// are actually impersonated at volume (payment, big tech, banks), not to be a trademark registry.

const BRANDS: Record<string, readonly string[]> = {
  paypal: ['paypal.com'],
  apple: ['apple.com', 'icloud.com'],
  google: ['google.com', 'gmail.com'],
  microsoft: ['microsoft.com', 'outlook.com', 'live.com'],
  amazon: ['amazon.com'],
  netflix: ['netflix.com'],
  chase: ['chase.com'],
  'bank of america': ['bankofamerica.com'],
  wellsfargo: ['wellsfargo.com'],
  'wells fargo': ['wellsfargo.com'],
  citibank: ['citibank.com', 'citi.com'],
  usps: ['usps.com'],
  fedex: ['fedex.com'],
  dhl: ['dhl.com'],
  docusign: ['docusign.com'],
};

// ---------------------------------------------------------------------------------------------
// Helpers

function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/** Every non-empty ASCII/Unicode "word" token, for scanning display names and subjects for brand names. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.[A-Za-z0-9.-]+)/;
// A bare domain-looking token, e.g. "paypal.com" appearing in a display name with no local part.
const BARE_DOMAIN_RE = /\b([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/;

function reasonNonEmpty(reason: string): string {
  return reason.trim() === '' ? '(no further detail)' : reason;
}

function warn(kind: PhishWarningKind, severity: PhishSeverity, reason: string): PhishWarning {
  return { kind, severity, reason: reasonNonEmpty(reason) };
}

// ---------------------------------------------------------------------------------------------
// Detection: display-name spoofing

function detectDisplayNameSpoofing(input: DetectPhishInput, fromDomain: string | null): PhishWarning[] {
  const out: PhishWarning[] = [];
  const name = input.from.displayName?.trim() ?? '';
  if (name === '') return out;

  const emailMatch = EMAIL_RE.exec(name);
  if (emailMatch !== null) {
    const namedDomain = normalizeDomain(emailMatch[1] ?? '');
    if (namedDomain !== '' && namedDomain !== fromDomain) {
      out.push(
        warn(
          'display-name-spoofing',
          'high',
          `display name "${name}" contains the address ${emailMatch[0]} (domain ${namedDomain}), but the message is actually From ${input.from.address}${fromDomain === null ? '' : ` (domain ${fromDomain})`}`,
        ),
      );
    }
  } else {
    const bareMatch = BARE_DOMAIN_RE.exec(name);
    if (bareMatch !== null) {
      const namedDomain = normalizeDomain(bareMatch[1] ?? '');
      if (namedDomain !== '' && namedDomain !== fromDomain) {
        out.push(
          warn(
            'display-name-spoofing',
            'medium',
            `display name "${name}" names the domain ${namedDomain}, but the message is actually From ${input.from.address}${fromDomain === null ? '' : ` (domain ${fromDomain})`}`,
          ),
        );
      }
    }
  }

  for (const contact of input.account.contacts ?? []) {
    if (contact.name.trim() === '' || contact.name.trim().toLowerCase() !== name.toLowerCase()) continue;
    if (contact.address.trim().toLowerCase() === input.from.address.trim().toLowerCase()) continue;
    out.push(
      warn(
        'display-name-spoofing',
        'high',
        `display name "${name}" matches contact ${contact.name} <${contact.address}>, but this message is From ${input.from.address}`,
      ),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Detection: lookalike / punycode domains

function idnMixedScriptReason(domain: string): { reason: string; mixed: boolean } | null {
  const labels = domain.split('.');
  const decodedLabels: string[] = [];
  let anyIdn = false;
  for (const label of labels) {
    if (label.toLowerCase().startsWith('xn--')) {
      anyIdn = true;
      const decoded = decodeIdnLabel(label);
      decodedLabels.push(decoded ?? label);
    } else {
      decodedLabels.push(label);
    }
  }
  if (!anyIdn) return null;
  const decodedDomain = decodedLabels.join('.');
  const scripts = scriptsOf(decodedDomain);
  if (scripts.size > 1) {
    return { mixed: true, reason: `domain ${domain} is an internationalized (punycode) domain decoding to "${decodedDomain}", which mixes scripts (${[...scripts].sort().join(', ')}) — a classic homoglyph trick` };
  }
  return { mixed: false, reason: `domain ${domain} is an internationalized (punycode) domain decoding to "${decodedDomain}", written in one script` };
}

function detectLookalikeDomains(input: DetectPhishInput, fromDomain: string | null): PhishWarning[] {
  const out: PhishWarning[] = [];
  if (fromDomain === null) return out;

  // A mixed-script IDN is a homoglyph trick (high). A single-script one — bücher.de — is how most of
  // the world writes domains: still named (PST-REQ-120 lists punycode domains), but low severity;
  // a single-script IDN that imitates a brand is caught by the lookalike check below.
  const idn = idnMixedScriptReason(fromDomain);
  if (idn !== null) out.push(warn('punycode-domain', idn.mixed ? 'high' : 'low', idn.reason));

  const knownDomains = new Set<string>();
  for (const d of input.account.knownSenders.domains ?? []) knownDomains.add(normalizeDomain(d));
  for (const a of input.account.knownSenders.addresses ?? []) {
    const d = domainOf(a);
    if (d !== null) knownDomains.add(d);
  }
  for (const domains of Object.values(BRANDS)) for (const d of domains) knownDomains.add(d);

  const fromSkeleton = skeleton(fromDomain);
  const seen = new Set<string>();
  for (const candidate of knownDomains) {
    if (candidate === fromDomain || seen.has(candidate)) continue;
    seen.add(candidate);

    if (skeleton(candidate) === fromSkeleton && candidate !== fromDomain) {
      out.push(
        warn(
          'lookalike-domain',
          'high',
          `domain ${fromDomain} looks identical to the known domain ${candidate} once homoglyphs are normalized (confusable character substitution)`,
        ),
      );
      continue;
    }

    const distance = editDistance(fromDomain, candidate, 2);
    if (distance >= 1 && distance <= 2) {
      out.push(
        warn(
          'lookalike-domain',
          distance === 1 ? 'high' : 'medium',
          `domain ${fromDomain} is only ${distance} character${distance === 1 ? '' : 's'} different from the known domain ${candidate} — a likely lookalike`,
        ),
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Detection: first-time sender claiming a known brand

function detectFirstTimeBrandSender(input: DetectPhishInput, fromDomain: string | null): PhishWarning[] {
  const out: PhishWarning[] = [];
  const displayWords = new Set(words(input.from.displayName ?? ''));
  const subjectWords = new Set(words(input.subject ?? ''));

  const knownAddresses = new Set<string>();
  for (const a of input.account.knownSenders.addresses ?? []) knownAddresses.add(a.trim().toLowerCase());
  const isFirstTime = !knownAddresses.has(input.from.address.trim().toLowerCase());
  if (!isFirstTime) return out;

  for (const [brand, domains] of Object.entries(BRANDS)) {
    const brandWords = words(brand);
    const named = brandWords.every((w) => displayWords.has(w)) || brandWords.every((w) => subjectWords.has(w));
    if (!named) continue;
    if (fromDomain !== null && domains.includes(fromDomain)) continue; // legitimately that brand's own domain
    const where = brandWords.every((w) => displayWords.has(w)) ? 'display name' : 'subject';
    out.push(
      warn(
        'first-time-brand-sender',
        'medium',
        `${where} names "${brand}", a first-time sender at ${input.from.address}${fromDomain === null ? '' : ` (domain ${fromDomain})`}, which is not one of ${brand}'s known domains (${domains.join(', ')})`,
      ),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Detection: authentication failure

function detectAuthFailure(input: DetectPhishInput, fromDomain: string | null): PhishWarning[] {
  const out: PhishWarning[] = [];
  const { spf, dkim, dmarc } = input.authVerdicts;

  const dmarcResult = dmarc?.result;
  const policy = dmarc?.policy ?? dmarc?.disposition;
  if (dmarcResult === 'fail') {
    out.push(
      warn(
        'auth-failure',
        policy === 'reject' || policy === 'quarantine' ? 'high' : 'medium',
        `DMARC failed for ${fromDomain ?? 'the From domain'}${policy === undefined ? '' : ` (published policy p=${policy})`}`,
      ),
    );
  } else if (dmarcResult === 'none' && (policy === 'reject' || policy === 'quarantine')) {
    out.push(
      warn(
        'auth-failure',
        policy === 'reject' ? 'high' : 'medium',
        `${fromDomain ?? 'the From domain'} publishes DMARC p=${policy}, but this message had no DMARC result (SPF/DKIM did not align)`,
      ),
    );
  }

  if (spf?.result === 'fail') {
    out.push(warn('auth-failure', 'medium', `SPF failed for ${fromDomain ?? 'the From domain'}`));
  }

  const dkimResults = dkim ?? [];
  const knownDomains = new Set<string>();
  for (const d of input.account.knownSenders.domains ?? []) knownDomains.add(normalizeDomain(d));
  for (const a of input.account.knownSenders.addresses ?? []) {
    const d = domainOf(a);
    if (d !== null) knownDomains.add(d);
  }
  const dkimAllFailed = dkimResults.length > 0 && dkimResults.every((r) => r.result !== 'pass');
  if (dkimAllFailed && fromDomain !== null && dmarcResult !== 'pass') {
    const isKnown = knownDomains.has(fromDomain);
    out.push(
      warn(
        'auth-failure',
        isKnown ? 'high' : 'medium',
        `DKIM did not pass for ${fromDomain} (${dkimResults.map((r) => r.result ?? 'none').join(', ')})${isKnown ? ', a domain this account has previously received authenticated mail from' : ''}`,
      ),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------------------------
// Detection: link text/href mismatch

function hostOf(href: string): string | null {
  try {
    return new URL(href).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

const TEXT_URL_RE = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[/?#][^\s]*)?/i;

function detectLinkMismatch(input: DetectPhishInput): PhishWarning[] {
  const out: PhishWarning[] = [];
  for (const link of input.links ?? []) {
    const textMatch = TEXT_URL_RE.exec(link.text.trim());
    if (textMatch === null) continue;
    const textHost = normalizeDomain(textMatch[1] ?? '');
    const hrefHost = hostOf(link.href);
    if (textHost === '' || hrefHost === null) continue;
    if (textHost === hrefHost || hrefHost.endsWith(`.${textHost}`)) continue;
    out.push(
      warn(
        'link-mismatch',
        'high',
        `link text shows "${link.text.trim()}" (${textHost}) but actually goes to ${hrefHost} (${link.href})`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

/** Detect phishing/lookalike signals in a message, each with a human-readable reason (PST-REQ-120). Never throws. */
export function detectPhish(input: DetectPhishInput): PhishResult {
  try {
    const fromDomain = domainOf(input.from.address);
    const warnings: PhishWarning[] = [
      ...detectDisplayNameSpoofing(input, fromDomain),
      ...detectLookalikeDomains(input, fromDomain),
      ...detectFirstTimeBrandSender(input, fromDomain),
      ...detectAuthFailure(input, fromDomain),
      ...detectLinkMismatch(input),
    ];
    return { warnings };
  } catch {
    // Never throws: a malformed message degrades to "no signal found", not a crash.
    return { warnings: [] };
  }
}
