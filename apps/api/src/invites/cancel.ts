// Who may cancel a calendar event (PST-T-8.4, PST-REQ-134; RFC 5546 §3.2.5: only the organizer
// sends CANCEL). A CANCEL is honoured only when all three hold:
//   1. its ORGANIZER equals, case-insensitively, the ORGANIZER stored on the event with that UID —
//      otherwise anyone who knows (or guesses) a UID could cancel someone else's meeting;
//   2. the message is authenticated as coming from the organizer's domain — the same eligibility
//      gate PST-T-5.6's One-Click unsubscribe uses (senders/unsubscribe.ts's dmarcPassed over the
//      stored message_verdict.auth), plus the evaluated RFC5322.From domain equal to the
//      organizer's domain; or, failing DMARC, a From domain equal to the organizer's with a passing
//      DKIM signature by that same domain;
//   3. its SEQUENCE is not older than the stored event's (RFC 5546 §2.1.5).
// Pure: the caller loads the stored event and the verdict.
import { dmarcPassed } from '../senders/unsubscribe.js';

export type CancelRefusal =
  | { ok: false; status: 403; error: 'cancel_organizer_mismatch'; message: string }
  | { ok: false; status: 403; error: 'cancel_unauthenticated'; message: string }
  | { ok: false; status: 409; error: 'cancel_stale'; message: string };

export interface CancelInput {
  /** The CANCEL's ORGANIZER, as parsed (already a validated mailbox, or null). */
  readonly cancelOrganizer: string | null;
  readonly cancelSequence: number;
  /** The stored event's ORGANIZER (lower-cased) and SEQUENCE. */
  readonly storedOrganizer: string | null;
  readonly storedSequence: number;
  /** The CANCEL message's stored message_verdict.auth, or null when there is no verdict. */
  readonly auth: unknown;
  /** The message's denormalised From address, the fallback when the DMARC result names no From domain. */
  readonly fromAddress: string | null;
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).toLowerCase().replace(/\.$/, '');

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The RFC5322.From domain the DMARC evaluation saw, else the denormalised From address's domain. */
function fromDomainOf(auth: unknown, fromAddress: string | null): string | null {
  const dmarc = record(record(auth)?.['dmarc']);
  const evaluated = dmarc?.['fromDomain'];
  if (typeof evaluated === 'string' && evaluated !== '') return evaluated.toLowerCase().replace(/\.$/, '');
  if (fromAddress !== null && fromAddress.includes('@')) return domainOf(fromAddress.trim());
  return null;
}

/** A passing DKIM signature whose d= is exactly `domain`. */
function dkimPassFor(auth: unknown, domain: string): boolean {
  const dkim = record(auth)?.['dkim'];
  const results = Array.isArray(dkim) ? dkim : dkim === undefined ? [] : [dkim];
  return results.some((r) => {
    const o = record(r);
    return o !== null && o['result'] === 'pass' && typeof o['domain'] === 'string' && o['domain'].toLowerCase().replace(/\.$/, '') === domain;
  });
}

/** Whether this CANCEL may mark the stored event cancelled; the refusal carries the card's words. */
export function cancelEligibility(input: CancelInput): { ok: true } | CancelRefusal {
  const organizer = input.cancelOrganizer?.toLowerCase() ?? null;
  if (organizer === null || input.storedOrganizer === null || organizer !== input.storedOrganizer) {
    return {
      ok: false,
      status: 403,
      error: 'cancel_organizer_mismatch',
      message: 'Not removed: this cancellation does not come from the organizer of the event in your calendar.',
    };
  }
  const orgDomain = domainOf(organizer);
  const fromDomain = fromDomainOf(input.auth, input.fromAddress);
  const aligned = fromDomain === orgDomain && (dmarcPassed(input.auth) || dkimPassFor(input.auth, orgDomain));
  if (!aligned) {
    return {
      ok: false,
      status: 403,
      error: 'cancel_unauthenticated',
      message: `Not removed: this cancellation could not be verified as sent by ${orgDomain} (DMARC/DKIM did not pass for the organizer’s domain).`,
    };
  }
  if (input.cancelSequence < input.storedSequence) {
    return { ok: false, status: 409, error: 'cancel_stale', message: 'Not removed: this cancellation is older than the event in your calendar.' };
  }
  return { ok: true };
}
