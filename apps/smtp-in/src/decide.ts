// The end-of-DATA decision (PST-REQ-058): accept, reject (5xx, with a Rejects copy — PST-REQ-059),
// or defer (4xx). Pure: every input is a verdict computed elsewhere, and every outcome carries its
// reasons, which data.ts stores on the spool row and the Rejects copy.
//
// Order, first match wins:
//   1. header block over the limit        → 552 5.3.4 reject (we cannot even read From to check DMARC)
//   2. client IP listed on a DNSBL         → 554 5.7.1 reject (the DNSBL client is PST-T-2.9)
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
  type ArcOverrideDecision,
  type ArcResult,
  type DmarcResult,
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

  if (dmarc.result === 'temperror') {
    const reasons = [`DMARC temperror for ${dmarc.fromDomain ?? 'the From domain'}: deferred, not accepted unchecked`, ...dmarc.reasons];
    return { action: 'defer', disposition: 'accept', rule: 'dmarc-temperror', reply: reply(451, '4.4.3', 'Temporary DNS failure checking DMARC, please try again later'), reasons };
  }

  const override = dmarcWithArcOverride(dmarc, arc, input.trustedArcSealers);
  const dmarcReasons = [`dmarc=${dmarc.result} disposition=${dmarc.disposition}`, ...dmarc.reasons, `arc=${arc.result}`, override.reason];

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
