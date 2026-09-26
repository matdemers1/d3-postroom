// Pure logic behind ReadingPane's delivery timeline (PST-T-6.4, PST-REQ-119): state labels and
// tones, the deferral sentence, the next-retry countdown, and one attempt's summary line. Kept
// apart from ReadingPane.tsx (which imports @d3cloud/ui, and so its CSS) so this can be unit tested
// directly under Node, the same way phish.ts and thread.ts are.
import type { DeliveryAttemptView, DeliveryRecipient, DeliveryState } from '../api';

export const STATE_LABEL: Readonly<Record<DeliveryState, string>> = {
  queued: 'Queued',
  attempting: 'Attempting',
  deferred: 'Deferred',
  delivered: 'Delivered',
  bounced: 'Bounced',
  cancelled: 'Cancelled',
};

/** `neutral` for anything in progress, parked or terminal; `attention` where seeing it should
 *  change what the reader does next; `danger` for a permanent failure — matches @d3cloud/ui's
 *  Badge tones. */
export const STATE_TONE: Readonly<Record<DeliveryState, 'neutral' | 'attention' | 'danger'>> = {
  queued: 'neutral',
  attempting: 'neutral',
  deferred: 'attention',
  delivered: 'neutral',
  bounced: 'danger',
  cancelled: 'neutral',
};

/** While a recipient's state can still change on its own, the timeline is worth polling. */
export function isPending(state: DeliveryState): boolean {
  return state === 'queued' || state === 'attempting' || state === 'deferred';
}

/** "in 42 min" / "in 3 hr" / "any moment" / "12 min ago" — for "next retry at <time> (<this>)". */
export function relativeMinutes(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return '';
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 1) return ms >= 0 ? 'any moment' : 'just now';
  const label = minutes < 60 ? `${String(minutes)} min` : `${String(Math.round(minutes / 60))} hr`;
  return ms >= 0 ? `in ${label}` : `${label} ago`;
}

/** The deferral sentence: the remote server's own words when it left any, otherwise a plain one. */
export function deferralReason(r: Pick<DeliveryRecipient, 'state' | 'lastText' | 'lastCode' | 'lastEnhanced'>): string | null {
  if (r.state !== 'deferred') return null;
  if (r.lastText !== null && r.lastText !== '') {
    const code = r.lastCode !== null ? `${String(r.lastCode)} ` : '';
    const enhanced = r.lastEnhanced !== null ? `${r.lastEnhanced} ` : '';
    return `${code}${enhanced}${r.lastText}`.trim();
  }
  return 'The remote server asked to try again later.';
}

/** One attempt's summary: which transport, which host, and TLS — never the remote response, which
 *  attemptRemoteText carries so it can be shown (or omitted) on its own line. */
export function attemptSummary(a: Pick<DeliveryAttemptView, 'transport' | 'mxHost' | 'tls'>): string {
  const bits: string[] = [a.transport === 'ses' ? 'SES' : 'Direct'];
  if (a.mxHost !== null) bits.push(a.mxHost);
  if (a.tls.version !== null) bits.push(a.tls.peer !== null ? `TLS ${a.tls.version} (${a.tls.peer})` : `TLS ${a.tls.version}`);
  return bits.join(' · ');
}

/** What the remote server said, or null when this attempt never got a response. */
export function attemptRemoteText(a: Pick<DeliveryAttemptView, 'remote'>): string | null {
  const { code, enhanced, text } = a.remote;
  if (code === null && enhanced === null && (text === null || text === '')) return null;
  return [code !== null ? String(code) : null, enhanced, text].filter((s): s is string => s !== null && s !== '').join(' ');
}

/** True once a delivery-status notification has been filed to the account's own Inbox for this
 *  outcome — the reader is told where to find it, since there is no per-DSN id to link to directly. */
export function dsnFiledAt(r: Pick<DeliveryRecipient, 'dsn'>): string | null {
  return r.dsn.failureSentAt ?? r.dsn.delaySentAt;
}

/** Shown when a message has no linked OutboundMessage row (PST-T-6.7, PST-REQ-119) — never sent
 *  through Postroom at all, or a Sent copy another mail client APPENDed directly, which never went
 *  through Postroom's queue either. */
export const NO_DELIVERY_RECORD_TEXT = "No delivery record — this copy wasn't sent through Postroom.";

/** Which of the section's two states to show, given the (already-fetched) outbound lookup: an
 *  explicit note with no linked row, or 'lookup' to fetch and show the real timeline. */
export type DeliveryPhase = 'no-record' | 'lookup';
export function deliveryPhase(outboundId: string | null): DeliveryPhase {
  return outboundId === null ? 'no-record' : 'lookup';
}
