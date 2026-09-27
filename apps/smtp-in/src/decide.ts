// The end-of-DATA decision (PST-REQ-058): accept, reject (5xx, with a Rejects copy — PST-REQ-059),
// or defer (4xx). Pure: every input is a verdict computed elsewhere, and every outcome carries its
// reasons, which data.ts stores on the spool row and the Rejects copy.
//
// Order, first match wins:
//   1. header block over the limit        → 552 5.3.4 reject (we cannot even read From to check DMARC)
//   2. client IP listed on a DNSBL         → 554 5.7.1 reject (the DNSBL client is PST-T-2.9; server.ts
//                                            normally refuses at MAIL FROM already — this catches a
//                                            lookup that finished after MAIL FROM stopped waiting)
//   2b. header From claims one of our domains with neither an aligned SPF pass nor an aligned
//       DKIM pass (PST-REQ-184)          → 550 5.7.1 reject, whatever our own DMARC record says
//       …the same, but an aligned check had a DNS temperror → 451 4.4.3 defer
//   3. DMARC temperror                     → 451 4.4.3 defer
//   4. DMARC disposition after ARC override:
//        reject with an ARC temperror      → 451 4.4.3 defer (a trusted chain might have overridden it)
//        reject                            → 550 5.7.1 reject, with the DMARC reasons
//        quarantine                        → accept, disposition quarantine (the filing stage puts it in Junk)
//   5. otherwise                           → accept
//
// Temperror is deferred rather than accepted: RFC 7489 §6.6.3 leaves it to the receiver, and a DNS
// failure at the sender's _dmarc record must not become a way to slip past p=reject. A legitimate
// sender retries, and by then the lookup normally succeeds. 4.4.3 is RFC 3463's "directory server
// failure" — the closest registered code to "a DNS lookup failed".
import {
  dmarcWithArcOverride,
  domainsAligned,
  normalizeDomain,
  type AlignmentMode,
  type ArcOverrideDecision,
  type ArcResult,
  type DmarcDkimInput,
  type DmarcResult,
  type DmarcSpfInput,
} from '@postroom/auth-checks';
import { reply, type SmtpReply } from '@postroom/smtp-proto';

/** A DNSBL verdict for the client IP. Wired to a real DNSBL client in PST-T-2.9. */
export interface DnsblVerdict {
  readonly listed: boolean;
  /** The zone queried, e.g. zen.spamhaus.org. */
  readonly zone: string;
  /** The list's own explanation (TXT), or which sub-list matched (SBL, XBL). */
  readonly reason?: string;
}

export type DecisionAction = 'accept' | 'reject' | 'defer';
export type Disposition = 'accept' | 'reject' | 'quarantine';
export type DecisionRule =
  | 'header-too-large'
  | 'dnsbl'
  | 'own-domain-unauthenticated'
  | 'own-domain-temperror'
  | 'dmarc-temperror'
  | 'arc-temperror'
  | 'dmarc-reject'
  | 'dmarc-quarantine'
  | 'accept';

export interface DecideInput {
  readonly dmarc: DmarcResult;
  readonly arc: ArcResult;
  readonly trustedArcSealers: readonly string[];
  readonly dnsbl?: DnsblVerdict | undefined;
  /** The header block exceeded the limit, so no From could be read. */
  readonly headerTooLarge?: boolean;
  /** The domains we serve (the domain table). With `spf` and `dkim`, enables PST-REQ-184. */
  readonly ownDomains?: readonly string[];
  /** The SPF result DMARC was given (MAIL FROM, or HELO for `<>`). */
  readonly spf?: DmarcSpfInput;
  /** Every DKIM result from the verifier. */
  readonly dkim?: readonly DmarcDkimInput[];
  /** How many From header fields the message has. */
  readonly fromFieldCount?: number;
}

export interface Decision {
  readonly action: DecisionAction;
  /** What the spool row records; for a defer nothing is stored, and this is 'accept' by convention. */
  readonly disposition: Disposition;
  readonly rule: DecisionRule;
  /** The reply for a reject or defer. An accept's reply names the spool id, so data.ts builds it. */
  readonly reply: SmtpReply | null;
  /** Why, in order; never empty. */
  readonly reasons: readonly string[];
  /** The ARC override decision, when DMARC got that far. */
  readonly arcOverride?: ArcOverrideDecision;
}

/** SMTP reply text: printable ASCII only, one line, bounded. */
export function replyText(text: string, max = 400): string {
  const clean = text.replace(/[^\x20-\x7e]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

/** `domain` is one of ours, or a subdomain of one (news.d3cloud.io claims d3cloud.io too). */
export function isOwnDomain(domain: string, ownDomains: readonly string[]): boolean {
  const d = normalizeDomain(domain);
  if (d === undefined) return false;
  return ownDomains.some((own) => {
    const o = normalizeDomain(own);
    return o !== undefined && (d === o || d.endsWith(`.${o}`));
  });
}

type OwnDomainVerdict =
  | { readonly kind: 'not-ours' }
  | { readonly kind: 'aligned'; readonly reasons: readonly string[] }
  | { readonly kind: 'unauthenticated' | 'temperror'; readonly domain: string; readonly reasons: readonly string[] };

/**
 * PST-REQ-184. Our domains publish p=none today, so DMARC alone lets a stranger's forgery of
 * `From: anyone@d3cloud.io` straight into the inbox. For our own domains we do not need the
 * sender's permission to be strict: every From domain of ours must have an aligned SPF pass or an
 * aligned (non-testing) DKIM pass, relaxed alignment unless our DMARC record says strict — the
 * same test DMARC itself applies, but enforced regardless of p=. Several From header fields naming
 * one of our domains are refused outright: a signature covers one From while a reader sees
 * another (RFC 6376 §8.15), which is the DKIM-replay shape of this same forgery.
 */
function checkOwnDomain(input: DecideInput): OwnDomainVerdict {
  const own = input.ownDomains ?? [];
  if (own.length === 0 || input.spf === undefined || input.dkim === undefined) return { kind: 'not-ours' };
  const { dmarc } = input;
  const ours = dmarc.fromDomains.filter((d) => isOwnDomain(d, own));
  if (ours.length === 0) return { kind: 'not-ours' };
  const first = ours[0] ?? '';
  if ((input.fromFieldCount ?? 1) > 1) {
    return {
      kind: 'unauthenticated',
      domain: first,
      reasons: [`message has ${String(input.fromFieldCount)} From header fields, one naming our domain ${first}: alignment is ambiguous (RFC 6376 §8.15)`],
    };
  }
  const reasons: string[] = [];
  for (const domain of ours) {
    // The DMARC result for this domain carries our own record's alignment modes, when there is one.
    const perDomain = dmarc.fromDomain === domain ? dmarc : dmarc.perDomain?.find((r) => r.fromDomain === domain);
    const record = perDomain?.record;
    const spfMode: AlignmentMode = record?.aspf === 's' ? 'strict' : 'relaxed';
    const dkimMode: AlignmentMode = record?.adkim === 's' ? 'strict' : 'relaxed';
    const spf = input.spf;
    const spfAligns = domainsAligned(spf.domain, domain, spfMode);
    if (spf.result === 'pass' && spfAligns) {
      reasons.push(`header From ${domain} is ours: SPF pass for ${spf.domain}, ${spfMode}ly aligned`);
      continue;
    }
    const dkimPass = input.dkim.find((d) => d.result === 'pass' && !d.testing && d.domain !== undefined && domainsAligned(d.domain, domain, dkimMode));
    if (dkimPass !== undefined) {
      reasons.push(`header From ${domain} is ours: DKIM pass for d=${dkimPass.domain ?? '?'}, ${dkimMode}ly aligned`);
      continue;
    }
    // Not authenticated. If an aligned check could not complete, the sender may be genuine.
    const spfTemp = spf.result === 'temperror' && spfAligns;
    const dkimTemp = input.dkim.some((d) => d.result === 'temperror' && d.domain !== undefined && domainsAligned(d.domain, domain, dkimMode));
    const temporary = spfTemp || dkimTemp;
    return {
      kind: temporary ? 'temperror' : 'unauthenticated',
      domain,
      reasons: [
        `header From ${domain} is one of our domains but has neither an aligned SPF pass nor an aligned DKIM pass (SPF ${spf.result} for ${spf.domain || 'no domain'}, ${spfMode} alignment; ${
          input.dkim.length === 0 ? 'no DKIM signatures' : input.dkim.map((d) => `DKIM ${d.result} d=${d.domain ?? '?'}`).join(', ')
        }, ${dkimMode} alignment)`,
        ...(temporary ? ['an aligned check had a temporary DNS failure, so deferred rather than rejected'] : []),
      ],
    };
  }
  return { kind: 'aligned', reasons };
}

export function decide(input: DecideInput): Decision {
  const { dmarc, arc } = input;

  if (input.headerTooLarge === true) {
    const why = 'the header section exceeds 1 MiB';
    return { action: 'reject', disposition: 'reject', rule: 'header-too-large', reply: reply(552, '5.3.4', replyText(`Message rejected: ${why}`)), reasons: [why] };
  }

  if (input.dnsbl?.listed === true) {
    const d = input.dnsbl;
    const why = `client IP is listed on ${d.zone}${d.reason === undefined ? '' : `: ${d.reason}`}`;
    return { action: 'reject', disposition: 'reject', rule: 'dnsbl', reply: reply(554, '5.7.1', replyText(`Message rejected: ${why}`)), reasons: [why] };
  }

  const own = checkOwnDomain(input);
  if (own.kind === 'temperror') {
    return { action: 'defer', disposition: 'accept', rule: 'own-domain-temperror', reply: reply(451, '4.4.3', 'Temporary DNS failure authenticating the From domain, please try again later'), reasons: own.reasons };
  }
  if (own.kind === 'unauthenticated') {
    const text = `Message claims to be from ${own.domain} but is not authenticated by it (no aligned SPF or DKIM pass)`;
    return { action: 'reject', disposition: 'reject', rule: 'own-domain-unauthenticated', reply: reply(550, '5.7.1', replyText(text)), reasons: own.reasons };
  }
  const ownReasons = own.kind === 'aligned' ? own.reasons : [];

  if (dmarc.result === 'temperror') {
    const reasons = [`DMARC temperror for ${dmarc.fromDomain ?? 'the From domain'}: deferred, not accepted unchecked`, ...dmarc.reasons];
    return { action: 'defer', disposition: 'accept', rule: 'dmarc-temperror', reply: reply(451, '4.4.3', 'Temporary DNS failure checking DMARC, please try again later'), reasons };
  }

  const override = dmarcWithArcOverride(dmarc, arc, input.trustedArcSealers);
  const dmarcReasons = [`dmarc=${dmarc.result} disposition=${dmarc.disposition}`, ...dmarc.reasons, `arc=${arc.result}`, override.reason, ...ownReasons];

  if (override.disposition === 'reject') {
    if (arc.temporary) {
      return {
        action: 'defer',
        disposition: 'accept',
        rule: 'arc-temperror',
        reply: reply(451, '4.4.3', 'Temporary DNS failure checking ARC, please try again later'),
        reasons: [...dmarcReasons, 'ARC had a temporary failure; a trusted chain might override the DMARC reject, so deferred'],
        arcOverride: override,
      };
    }
    const policy = dmarc.record === undefined ? '' : ` (p=${dmarc.record.p})`;
    const first = dmarc.reasons[0];
    const text = `Rejected by the DMARC policy of ${dmarc.fromDomain ?? 'the From domain'}${policy}${first === undefined ? '' : `: ${first}`}`;
    return { action: 'reject', disposition: 'reject', rule: 'dmarc-reject', reply: reply(550, '5.7.1', replyText(text)), reasons: dmarcReasons, arcOverride: override };
  }

  if (override.disposition === 'quarantine') {
    return { action: 'accept', disposition: 'quarantine', rule: 'dmarc-quarantine', reply: null, reasons: dmarcReasons, arcOverride: override };
  }

  return { action: 'accept', disposition: 'accept', rule: 'accept', reply: null, reasons: dmarcReasons, arcOverride: override };
}
