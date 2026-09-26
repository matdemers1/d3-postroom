// Parsing an iMIP calendar object (RFC 6047) into what the webmail's invite card and REQUEST/REPLY
// flow need. Google Calendar and Outlook REQUEST/CANCEL bodies both parse: VTIMEZONE blocks, folded
// lines, CRLF, X- properties (X-MICROSOFT-CDO-*, X-WR-*) are read by @postroom/ical and ignored here.
import {
  calAddressEmail,
  createTimeZoneResolver,
  dateTimeToUtc,
  formatDate,
  getComponents,
  getParam,
  getProperties,
  getProperty,
  parseICalendarAll,
  parseText,
  propertyDate,
  type Component,
} from '@postroom/ical';
import { ImipError } from './errors.js';

/** RFC 5546 §1.4: the methods iTIP defines. Postroom only builds REPLY; every method parses. */
export const IMIP_METHODS = ['PUBLISH', 'REQUEST', 'REPLY', 'ADD', 'CANCEL', 'REFRESH', 'COUNTER', 'DECLINECOUNTER'] as const;
export type ImipMethod = (typeof IMIP_METHODS)[number];

export type Partstat = 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';

export type OrganizerStatus = 'valid' | 'invalid' | 'missing';

export interface InviteOrganizer {
  readonly email: string | null;
  readonly cn: string | null;
}

export interface InviteAttendee {
  /** Lower-cased, as it will be matched and replied to. */
  readonly email: string;
  readonly cn: string | null;
  readonly role: string | null;
  readonly rsvp: boolean;
  /** RFC 5545 §3.2.12 default is NEEDS-ACTION. */
  readonly partstat: string;
}

export interface ParsedInvite {
  readonly method: ImipMethod;
  readonly uid: string;
  readonly sequence: number;
  /** ISO instant when DTSTAMP parses; the raw value otherwise; null when absent. */
  readonly dtstamp: string | null;
  readonly summary: string;
  readonly location: string;
  readonly allDay: boolean;
  /** ISO instant (UTC) for a timed event, `YYYY-MM-DD` for all-day, null when DTSTART is missing. */
  readonly start: string | null;
  readonly end: string | null;
  readonly organizer: InviteOrganizer;
  /**
   * `valid` when ORGANIZER decodes to exactly one mailbox; `invalid` when it is present but does not
   * (a CR/LF, a list, angle brackets, not `mailto:` …); `missing` when there is none. Only a `valid`
   * organizer can be replied to — an invalid address never reaches an envelope or a header.
   */
  readonly organizerStatus: OrganizerStatus;
  readonly attendees: readonly InviteAttendee[];
  /** The RECURRENCE-ID value, when this invite is about one instance of a series. */
  readonly recurrenceId: string | null;
  /** The VEVENT (or VTODO) this was read from, unmodified — for a reply's RECURRENCE-ID/other fields. */
  readonly component: Component;
  /** The whole VCALENDAR, unmodified — VTIMEZONE blocks and all. */
  readonly calendar: Component;
}

function resolveWhen(prop: ReturnType<typeof getProperty>, calendar: Component): { value: string | null; allDay: boolean } {
  if (prop === undefined) return { value: null, allDay: false };
  const v = propertyDate(prop);
  if (v.type === 'date') return { value: formatDate(v), allDay: true };
  const resolver = createTimeZoneResolver(calendar);
  const utcSeconds = dateTimeToUtc(v, resolver);
  return { value: new Date(utcSeconds * 1000).toISOString(), allDay: false };
}

function organizerOf(comp: Component): InviteOrganizer {
  const prop = getProperty(comp, 'ORGANIZER');
  if (prop === undefined) return { email: null, cn: null };
  return { email: calAddressEmail(prop.value), cn: getParam(prop, 'CN') ?? null };
}

function attendeesOf(comp: Component): InviteAttendee[] {
  return getProperties(comp, 'ATTENDEE')
    .map((p) => ({ email: calAddressEmail(p.value), cn: getParam(p, 'CN') ?? null, role: getParam(p, 'ROLE') ?? null, rsvp: (getParam(p, 'RSVP') ?? '').toUpperCase() === 'TRUE', partstat: (getParam(p, 'PARTSTAT') ?? 'NEEDS-ACTION').toUpperCase() }))
    .filter((a): a is InviteAttendee => a.email !== null)
    .map((a) => ({ ...a, email: a.email.toLowerCase() }));
}

function dtstampOf(comp: Component): string | null {
  const prop = getProperty(comp, 'DTSTAMP');
  if (prop === undefined) return null;
  try {
    const v = propertyDate(prop);
    if (v.type === 'date') return formatDate(v);
    return new Date(dateTimeToUtc(v, { offsetAt: () => null }) * 1000).toISOString();
  } catch {
    return prop.value;
  }
}

/** Parse one iMIP calendar object: a Google Calendar or Outlook REQUEST/CANCEL, or a reply. */
export function parseInvite(input: string | Uint8Array): ParsedInvite {
  let roots: Component[];
  try {
    roots = parseICalendarAll(input);
  } catch (err) {
    throw new ImipError(`not a calendar object: ${err instanceof Error ? err.message : String(err)}`);
  }
  const calendar = roots.find((r) => r.name === 'VCALENDAR');
  if (calendar === undefined) throw new ImipError('no VCALENDAR in this iMIP part');
  const methodValue = getProperty(calendar, 'METHOD')?.value.trim().toUpperCase();
  if (methodValue === undefined) throw new ImipError('no METHOD: property (RFC 6047 requires one)');
  if (!(IMIP_METHODS as readonly string[]).includes(methodValue)) throw new ImipError(`unknown iTIP METHOD "${methodValue.slice(0, 40)}"`);
  const method = methodValue as ImipMethod;

  const events = [...getComponents(calendar, 'VEVENT'), ...getComponents(calendar, 'VTODO')];
  const component = events.find((c) => getProperty(c, 'RECURRENCE-ID') === undefined) ?? events[0];
  if (component === undefined) throw new ImipError('no VEVENT or VTODO in this calendar object');

  const uid = getProperty(component, 'UID')?.value.trim();
  if (uid === undefined || uid === '') throw new ImipError('the event has no UID');
  const sequence = Number(getProperty(component, 'SEQUENCE')?.value ?? '0');

  const start = resolveWhen(getProperty(component, 'DTSTART'), calendar);
  const end = resolveWhen(getProperty(component, 'DTEND'), calendar);

  return {
    method,
    uid,
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
    dtstamp: dtstampOf(component),
    summary: getProperty(component, 'SUMMARY') === undefined ? '' : parseText(getProperty(component, 'SUMMARY')?.value ?? ''),
    location: getProperty(component, 'LOCATION') === undefined ? '' : parseText(getProperty(component, 'LOCATION')?.value ?? ''),
    allDay: start.allDay,
    start: start.value,
    end: end.value,
    organizer: organizerOf(component),
    organizerStatus: getProperty(component, 'ORGANIZER') === undefined ? 'missing' : organizerOf(component).email === null ? 'invalid' : 'valid',
    attendees: attendeesOf(component),
    recurrenceId: getProperty(component, 'RECURRENCE-ID')?.value.trim() ?? null,
    component,
    calendar,
  };
}

/** Why this invite cannot be replied to, in words for the card; null when it can. */
export function replyBlockReason(invite: Pick<ParsedInvite, 'organizerStatus'>): string | null {
  switch (invite.organizerStatus) {
    case 'valid':
      return null;
    case 'invalid':
      return 'Can’t reply: the organizer address is invalid.';
    case 'missing':
      return 'Can’t reply: this invitation names no organizer.';
  }
}
