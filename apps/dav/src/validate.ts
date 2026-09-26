// What a PUT may store (RFC 4791 §4.1 and §5.3.2.1, RFC 6352 §5.1 and §6.3.2.1). A body that fails
// is refused with the precondition the RFC names, and nothing is stored. A body that passes is
// stored byte for byte as the client sent it — clients compare what they wrote with what they read.
import { NS, clark, DavRequestError } from '@postroom/dav-proto';
import { getProperty, ICalError, parseICalendarAll, type Component } from '@postroom/ical';
import { getProperty as getCardProperty, parseVCards, VCardError, versionOf } from '@postroom/vcard';

export const CALENDAR_COMPONENTS = ['VEVENT', 'VTODO', 'VJOURNAL'] as const;
export const VCARD_VERSIONS = ['3.0', '4.0'] as const;

export interface ValidCalendarObject {
  readonly uid: string;
  readonly componentType: string;
  readonly calendar: Component;
}

const cal = (local: string): string => clark(NS.CALDAV, local);
const card = (local: string): string => clark(NS.CARDDAV, local);

/** `text/calendar; charset=utf-8` → `text/calendar`. */
export function mediaType(header: string | undefined): string | null {
  if (header === undefined) return null;
  const t = header.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return t === '' ? null : t;
}

export function validateCalendarObject(body: Buffer, contentType: string | undefined, supported: readonly string[], maxBytes: number): ValidCalendarObject {
  const type = mediaType(contentType);
  if (type !== null && type !== 'text/calendar') throw new DavRequestError(403, `Content-Type ${type} is not text/calendar`, cal('supported-calendar-data'));
  let roots: Component[];
  try {
    roots = parseICalendarAll(body, { maxBytes });
  } catch (err) {
    if (err instanceof ICalError) throw new DavRequestError(403, `not valid iCalendar: ${err.message}`, cal('valid-calendar-data'));
    throw err;
  }
  const calendar = roots[0];
  if (calendar === undefined || roots.length !== 1 || calendar.name !== 'VCALENDAR') {
    throw new DavRequestError(403, 'a calendar object is exactly one VCALENDAR', cal('valid-calendar-data'));
  }
  const invalid = (why: string): never => {
    throw new DavRequestError(403, why, cal('valid-calendar-object-resource'));
  };
  // A scheduling message (METHOD) is not a stored calendar object (RFC 4791 §4.1).
  if (getProperty(calendar, 'METHOD') !== undefined) invalid('a stored calendar object has no METHOD');
  const members = calendar.components.filter((c) => c.name !== 'VTIMEZONE');
  const first = members[0];
  if (first === undefined) invalid('the calendar holds no event, to-do or journal');
  const componentType = first?.name ?? '';
  if (members.some((c) => c.name !== componentType)) invalid('one calendar object holds one kind of component');
  if (!(CALENDAR_COMPONENTS as readonly string[]).includes(componentType)) {
    throw new DavRequestError(403, `${componentType} is not a calendar object component`, cal('supported-calendar-component'));
  }
  if (!supported.includes(componentType)) throw new DavRequestError(403, `this calendar does not hold ${componentType}`, cal('supported-calendar-component'));
  const uids = new Set(members.map((c) => getProperty(c, 'UID')?.value.trim() ?? ''));
  const [uid = ''] = uids;
  if (uids.size !== 1 || uid === '') invalid('every component carries the same, non-empty UID');
  if (uid.length > 1024) invalid('UID longer than 1024 characters');
  return { uid, componentType, calendar };
}

export function validateVCard(body: Buffer, contentType: string | undefined, maxBytes: number): { readonly uid: string } {
  const type = mediaType(contentType);
  if (type !== null && type !== 'text/vcard' && type !== 'text/x-vcard' && type !== 'text/directory') {
    throw new DavRequestError(403, `Content-Type ${type} is not text/vcard`, card('supported-address-data'));
  }
  let cards;
  try {
    cards = parseVCards(body, { maxBytes, maxCards: 2 });
  } catch (err) {
    if (err instanceof VCardError) throw new DavRequestError(403, `not a valid vCard: ${err.message}`, card('valid-address-data'));
    throw err;
  }
  const first = cards[0];
  if (first === undefined || cards.length !== 1) throw new DavRequestError(403, 'an address object is exactly one vCard', card('valid-address-data'));
  const version = versionOf(first);
  if (version === null || !(VCARD_VERSIONS as readonly string[]).includes(version)) {
    throw new DavRequestError(403, `vCard version ${version ?? '(none)'} is not supported`, card('supported-address-data'));
  }
  const uid = getCardProperty(first, 'UID')?.value.trim() ?? '';
  if (uid === '' || uid.length > 1024) throw new DavRequestError(403, 'a stored vCard carries a UID', card('valid-address-data'));
  return { uid };
}

/** A resource name a client may PUT to. */
export function validResourceName(name: string): boolean {
  return name.length > 0 && Buffer.byteLength(name, 'utf8') <= 255 && name !== '.' && name !== '..';
}
