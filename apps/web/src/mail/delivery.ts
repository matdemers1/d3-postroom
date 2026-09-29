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
  cancelled: 'Canceled',
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

// --- The calm view (PST-T-14.1, design audit CPY-01) ----------------------------------------------
//
// The reading view says what happened to each recipient in plain words — "Delivered", "Retrying at
// 3:40 PM", "Bounced — address doesn't exist" — and never the remote server's raw reply. The SMTP
// text, the attempt log and the reply codes are evidence: they live in the Inspect drawer only.

/** Why a bounce happened, in words a person uses. Keyed off the enhanced status code (RFC 3463) first,
 *  then the reply text, then the basic code; never echoes the remote's own text. */
export function bounceReason(r: Pick<DeliveryRecipient, 'lastCode' | 'lastEnhanced' | 'lastText'>): string {
  const enhanced = r.lastEnhanced?.trim() ?? '';
  const text = r.lastText ?? '';
  const byCode: Readonly<Record<string, string>> = {
    '5.1.1': 'address doesn’t exist',
    '5.1.2': 'that domain doesn’t exist',
    '5.1.3': 'the address isn’t valid',
    '5.1.6': 'the address has moved',
    '5.1.10': 'that domain doesn’t accept mail',
    '5.2.1': 'the mailbox is disabled',
    '5.2.2': 'the mailbox is full',
    '5.2.3': 'the message is too large',
    '5.3.4': 'the message is too large',
    '5.4.4': 'that domain has no mail server',
    '4.4.7': 'no server accepted it in time',
    '5.4.7': 'no server accepted it in time',
  };
  const known = byCode[enhanced];
  if (known !== undefined) return known;
  if (/null mx/i.test(text)) return 'that domain doesn’t accept mail';
  if (/(user unknown|unknown user|no such (user|mailbox|recipient)|does ?n[o’']t exist|mailbox unavailable)/i.test(text)) return 'address doesn’t exist';
  if (/(mailbox full|over quota|quota exceeded)/i.test(text)) return 'the mailbox is full';
  if (enhanced.startsWith('5.7.')) return 'the receiving server refused it';
  if (enhanced.startsWith('5.4.')) return 'the receiving server couldn’t be reached';
  if (r.lastCode !== null && r.lastCode >= 500) return 'the receiving server refused it';
  return 'it couldn’t be delivered';
}

/** "3:40 PM" today, "Tue 3:40 PM" within the week, a date after that. */
export function retryTime(iso: string, now: Date = new Date(), locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'soon';
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (at.toDateString() === now.toDateString()) return at.toLocaleTimeString(locale, time);
  const days = (at.getTime() - now.getTime()) / 86_400_000;
  if (days > 0 && days < 6) return at.toLocaleString(locale, { weekday: 'short', ...time });
  return at.toLocaleString(locale, { month: 'short', day: 'numeric', ...time });
}

/** One recipient's state, as one plain sentence fragment. */
export function deliveryLine(
  r: Pick<DeliveryRecipient, 'state' | 'nextAttemptAt' | 'lastCode' | 'lastEnhanced' | 'lastText'>,
  now: Date = new Date(),
  locale?: string,
): string {
  switch (r.state) {
    case 'delivered':
      return 'Delivered';
    case 'deferred':
      return `Retrying at ${retryTime(r.nextAttemptAt, now, locale)}`;
    case 'queued':
      return 'Waiting to send';
    case 'attempting':
      return 'Sending now';
    case 'bounced':
      return `Bounced — ${bounceReason(r)}`;
    case 'cancelled':
      return 'Canceled — not sent';
  }
}
