// Building an RFC 5546 §3.2.3 REPLY: the organizer's REQUEST answered by exactly one attendee, with
// exactly one ATTENDEE property (the replier) and nothing invented — UID, SEQUENCE and (when this
// invite was for one instance of a series) RECURRENCE-ID travel through unchanged.
import { escapeText, formatDateTime, serializeICalendar, type Component, type Property } from '@postroom/ical';
import { ImipError } from './errors.js';
import type { InviteAttendee, ParsedInvite, Partstat } from './parse.js';

function prop(name: string, value: string, params: Record<string, string[]> = {}): Property {
  return { name, params, value };
}

function stampOf(now: Date): string {
  return formatDateTime({
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    second: now.getUTCSeconds(),
    utc: true,
  });
}

/**
 * The invite's attendee matching one of `accountAddresses`, case-insensitively — the account may
 * have been invited at an alias rather than its primary address, and the reply must go out as
 * whichever address the organizer actually invited (RFC 5546 §3.2.3: the ATTENDEE is the replier,
 * unchanged from how the organizer named them).
 */
export function matchAttendee(invite: ParsedInvite, accountAddresses: readonly string[]): InviteAttendee | null {
  const mine = new Set(accountAddresses.map((a) => a.trim().toLowerCase()));
  return invite.attendees.find((a) => mine.has(a.email)) ?? null;
}

/**
 * A VCALENDAR with METHOD:REPLY carrying exactly one ATTENDEE (the replier, with the new PARTSTAT)
 * and the ORGANIZER, UID, SEQUENCE and RECURRENCE-ID copied from the invite (RFC 5546 §3.2.3).
 * Throws when `accountAddresses` matches none of the invite's attendees.
 */
export function buildReply(invite: ParsedInvite, accountAddresses: readonly string[], partstat: Partstat, now: Date): Component {
  const attendee = matchAttendee(invite, accountAddresses);
  if (attendee === null) throw new ImipError('none of this account’s addresses is an attendee of this invitation');
  if (invite.organizer.email === null) throw new ImipError('this invitation has no ORGANIZER to reply to');

  const props: Property[] = [
    prop('ORGANIZER', `mailto:${invite.organizer.email}`, invite.organizer.cn === null ? {} : { CN: [invite.organizer.cn] }),
  ];
  const attendeeParams: Record<string, string[]> = { PARTSTAT: [partstat] };
  if (attendee.cn !== null) attendeeParams['CN'] = [attendee.cn];
  if (attendee.role !== null) attendeeParams['ROLE'] = [attendee.role];
  props.push(prop('ATTENDEE', `mailto:${attendee.email}`, attendeeParams));
  props.push(prop('UID', invite.uid));
  if (invite.recurrenceId !== null) {
    const ridProp = invite.component.properties.find((p) => p.name === 'RECURRENCE-ID');
    props.push(ridProp === undefined ? prop('RECURRENCE-ID', invite.recurrenceId) : { ...ridProp });
  }
  props.push(prop('SEQUENCE', String(invite.sequence)));
  if (invite.summary !== '') props.push(prop('SUMMARY', escapeText(invite.summary)));
  props.push(prop('DTSTAMP', stampOf(now)));
  props.push(prop('REQUEST-STATUS', '2.0;Success'));

  const vevent: Component = { name: 'VEVENT', properties: props, components: [] };
  return {
    name: 'VCALENDAR',
    properties: [prop('PRODID', '-//Postroom//iMIP 1.0//EN'), prop('VERSION', '2.0'), prop('METHOD', 'REPLY')],
    components: [vevent],
  };
}

/** `buildReply`'s VCALENDAR, serialised (CRLF, folded, RFC 5545 §3.4). */
export function serializeReply(calendar: Component): string {
  return serializeICalendar(calendar);
}
