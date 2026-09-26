// Pure logic behind the reading pane's invite card (PST-T-8.4, PST-REQ-134): kept apart from
// InviteCard.tsx (which imports @d3cloud/ui, and so its CSS) so it can be unit tested directly under
// Node, the same way phish.ts/format.ts are.
import type { InviteView, Partstat } from '../api';
import { fullDate } from '../mail/format';

export const PARTSTAT_LABEL: Record<string, string> = {
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  TENTATIVE: 'Maybe',
  'NEEDS-ACTION': 'Not yet answered',
  DELEGATED: 'Delegated',
};

/** A short label for the invite's own current PARTSTAT, or a generic one when there is none. */
export function partstatLabel(partstat: string | undefined): string {
  if (partstat === undefined) return PARTSTAT_LABEL['NEEDS-ACTION'] ?? 'Not yet answered';
  return PARTSTAT_LABEL[partstat] ?? partstat;
}

/** When to show: a plain date for an all-day event, else a local date/time range. */
export function inviteWhen(invite: Pick<InviteView, 'allDay' | 'start' | 'end'>, locale?: string): string {
  if (invite.start === null) return '';
  if (invite.allDay) {
    const start = isoDayLabel(invite.start, locale);
    if (invite.end === null) return start;
    // DTEND is exclusive (RFC 5545 §3.6.1): the day before it is the last day shown.
    const end = isoDayLabel(dayBefore(invite.end), locale);
    return start === end ? start : `${start} – ${end}`;
  }
  const start = fullDate(invite.start, locale);
  if (invite.end === null) return start;
  return `${start} – ${fullDate(invite.end, locale)}`;
}

/** `YYYYMMDD` for the day before `yyyymmdd` (UTC civil arithmetic; no library needed). */
function dayBefore(yyyymmdd: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (m === null) return yyyymmdd;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d) - 1));
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

function isoDayLabel(yyyymmdd: string, locale?: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd);
  if (m === null) return yyyymmdd;
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The organizer as `Name <address>` — always with the ACTUAL address a reply goes to, never the
 * CN alone (a CN is whatever the sender typed). Just the address when there is no name; the name
 * and "(invalid address)" when the ORGANIZER did not decode to one valid mailbox.
 */
export function organizerLabel(invite: Pick<InviteView, 'organizer'>): string {
  const { cn, email } = invite.organizer;
  const name = cn === null || cn.trim() === '' ? null : cn.trim();
  if (email === null) return name === null ? 'Unknown organizer' : `${name} (invalid address)`;
  return name === null || name.toLowerCase() === email.toLowerCase() ? email : `${name} <${email}>`;
}

/** Where Accept/Maybe/Decline sends the reply — the organizer's address — or null when it cannot. */
export function replyTarget(invite: Pick<InviteView, 'organizer'>): string | null {
  return invite.organizer.email;
}

/** Why a REQUEST cannot be answered (shown on the card instead of the buttons), or null when it can. */
export function replyBlockedReason(invite: Pick<InviteView, 'method' | 'cancelled' | 'organizer'>): string | null {
  if (invite.method !== 'REQUEST' || invite.cancelled) return null;
  return invite.organizer.email === null ? 'Can’t reply: the organizer address is invalid.' : null;
}

/** The line beside the buttons naming the reply's destination. */
export function replyTargetNote(invite: Pick<InviteView, 'organizer'>): string {
  const target = replyTarget(invite);
  return target === null ? '' : `Your reply is sent to ${target}.`;
}

/** "3 people", "1 person" — never listing every address inline (the card stays short). */
export function attendeeCountLabel(invite: Pick<InviteView, 'attendees'>): string {
  const n = invite.attendees.length;
  return n === 1 ? '1 person' : `${String(n)} people`;
}

/** Which of Accept/Maybe/Decline is the current answer, for a pressed state on its button. */
export function isCurrentAnswer(invite: Pick<InviteView, 'you'>, partstat: Partstat): boolean {
  return invite.you?.partstat === partstat;
}

/** Whether the card offers Accept/Maybe/Decline at all: only a live REQUEST with a valid organizer address, never a CANCEL or a reply the caller sent. */
export function offersResponse(invite: Pick<InviteView, 'method' | 'cancelled' | 'organizer'>): boolean {
  return invite.method === 'REQUEST' && !invite.cancelled && invite.organizer.email !== null;
}

/** Whether the card offers "Remove from calendar": a CANCEL that is (or might be) in the calendar. */
export function offersRemoval(invite: Pick<InviteView, 'method'>): boolean {
  return invite.method === 'CANCEL';
}

const RESPONSE_ANNOUNCEMENT: Record<Partstat, string> = { ACCEPTED: 'Accepted.', TENTATIVE: 'Marked maybe.', DECLINED: 'Declined.' };

/** What is announced (aria-live) after a successful response, so a screen reader hears the result — and where the reply went. */
export function responseAnnouncement(partstat: Partstat, target?: string | null): string {
  const base = RESPONSE_ANNOUNCEMENT[partstat];
  return target === undefined || target === null ? base : `${base} Reply sent to ${target}.`;
}
