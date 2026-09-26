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

/** The organizer's name, or their address when there is none. */
export function organizerLabel(invite: Pick<InviteView, 'organizer'>): string {
  return invite.organizer.cn ?? invite.organizer.email ?? 'Unknown organizer';
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

/** Whether the card offers Accept/Maybe/Decline at all: only a live REQUEST, never a CANCEL or a reply the caller sent. */
export function offersResponse(invite: Pick<InviteView, 'method' | 'cancelled'>): boolean {
  return invite.method === 'REQUEST' && !invite.cancelled;
}

/** Whether the card offers "Remove from calendar": a CANCEL that is (or might be) in the calendar. */
export function offersRemoval(invite: Pick<InviteView, 'method'>): boolean {
  return invite.method === 'CANCEL';
}

const RESPONSE_ANNOUNCEMENT: Record<Partstat, string> = { ACCEPTED: 'Accepted.', TENTATIVE: 'Marked maybe.', DECLINED: 'Declined.' };

/** What is announced (aria-live) after a successful response, so a screen reader hears the result. */
export function responseAnnouncement(partstat: Partstat): string {
  return RESPONSE_ANNOUNCEMENT[partstat];
}
