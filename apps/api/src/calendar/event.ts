// Events as the webmail edits them, and the iCalendar they are stored as (PST-REQ-136). Pure: no
// database, no clock but the one passed in.
//
// What the web form edits: summary, location, description, all-day or timed (in an IANA zone),
// start and end, and a recurrence of FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, weekly BYDAY
// and COUNT or UNTIL. Everything else on an event — alarms, attendees, a rule with BYSETPOS the form
// cannot show — is kept as the phone wrote it: an edit changes only the properties the form owns.
//
// One instance of a recurring event is edited by writing a RECURRENCE-ID override (RFC 5545
// §3.8.4.4) beside the master, and deleted by an EXDATE. "This and following" (RANGE=THISANDFUTURE,
// or splitting the series) is out of scope: the web edits the whole series or one instance.
//
// Documented choices:
// - A timed event is written with TZID=<IANA zone> and no VTIMEZONE; Postroom's expansion and iOS
//   both resolve IANA names themselves. `UTC` is written as a UTC (`Z`) time.
// - UNTIL is given as a date and means "through the end of that day" in the event's zone; for a
//   timed event it is written as the UTC instant of 23:59:59 local, as RFC 5545 requires.
// - Changing when the series starts or its rule drops its overrides and exclusions: their
//   RECURRENCE-IDs named instances of the old series.
import {
  expandCalendar,
  formatRecur,
  getProperties,
  getProperty,
  intlOffsetAt,
  localToUtc,
  parseDuration,
  parseRecur,
  parseText,
  propertyDate,
  WEEKDAYS,
  escapeText,
  type Component,
  type ICalDateValue,
  type Instance,
  type Property,
  type Recur,
} from '@postroom/ical';

export const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export type Weekday = (typeof WEEKDAYS)[number];

export interface RecurrenceInput {
  readonly freq: Frequency;
  readonly interval: number;
  /** WEEKLY only: the weekdays it falls on (empty: DTSTART's weekday). */
  readonly byDay: readonly Weekday[];
  readonly count: number | null;
  /** Last day (inclusive), `YYYY-MM-DD`. */
  readonly until: string | null;
}

export interface EventInput {
  readonly summary: string;
  readonly description: string;
  readonly location: string;
  readonly allDay: boolean;
  /** `YYYY-MM-DD` when all-day, else local `YYYY-MM-DDTHH:mm` in `timezone`. */
  readonly start: string;
  /** Exclusive: the day after the last day when all-day; else local `YYYY-MM-DDTHH:mm`. */
  readonly end: string;
  /** An IANA zone (or `UTC`). Ignored for all-day events. */
  readonly timezone: string;
  /** null: not recurring. undefined (on an update): keep the series' rule as it is. */
  readonly recurrence?: RecurrenceInput | null | undefined;
}

export interface RecurrenceView {
  readonly freq: string;
  readonly interval: number;
  readonly byDay: string[];
  readonly count: number | null;
  readonly until: string | null;
  /** The RRULE as stored. */
  readonly rule: string;
  /** False when the rule uses parts the web form cannot show (BYSETPOS, BYMONTHDAY, …). */
  readonly editable: boolean;
}

export interface EventView {
  readonly uid: string;
  readonly summary: string;
  readonly description: string;
  readonly location: string;
  readonly allDay: boolean;
  readonly start: string;
  readonly end: string;
  /** IANA zone, `UTC`, or null for a floating time (and for all-day events). */
  readonly timezone: string | null;
  readonly recurrence: RecurrenceView | null;
  /** RECURRENCE-IDs of the instances edited on their own. */
  readonly overrides: string[];
  /** EXDATE values: instances deleted from the series. */
  readonly exdates: string[];
}

export class EventError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

interface Civil {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseDay(s: string, field: string): Civil {
  const m = DAY.exec(s);
  if (m === null) throw new EventError('invalid_event', `${field} must be YYYY-MM-DD`);
  const c = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: 0, minute: 0, second: 0 };
  checkCivil(c, field);
  return c;
}

function parseLocal(s: string, field: string): Civil {
  const m = LOCAL.exec(s);
  if (m === null) throw new EventError('invalid_event', `${field} must be YYYY-MM-DDTHH:mm`);
  const c = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: 0 };
  checkCivil(c, field);
  if (c.hour > 23 || c.minute > 59) throw new EventError('invalid_event', `${field} is not a time of day`);
  return c;
}

function checkCivil(c: Civil, field: string): void {
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day));
  if (c.year < 1900 || c.year > 2200 || d.getUTCMonth() !== c.month - 1 || d.getUTCDate() !== c.day) throw new EventError('invalid_event', `${field} is not a date`);
}

/** Wall-clock seconds "as if UTC". */
const localSecondsOf = (c: Civil): number => Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) / 1000;

function civilOfSeconds(s: number): Civil {
  const d = new Date(s * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

const icsDate = (c: Civil): string => `${pad(c.year, 4)}${pad(c.month)}${pad(c.day)}`;
const icsDateTime = (c: Civil, utc: boolean): string => `${icsDate(c)}T${pad(c.hour)}${pad(c.minute)}${pad(c.second)}${utc ? 'Z' : ''}`;
const isoDay = (c: Civil): string => `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}`;
const isoLocal = (c: Civil): string => `${isoDay(c)}T${pad(c.hour)}:${pad(c.minute)}`;

/** True for a zone the host's IANA database knows (or `UTC`). */
export function knownZone(tz: string): boolean {
  if (tz === 'UTC') return true;
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  return intlOffsetAt(tz, 0) !== null;
}

/** UTC seconds of a local wall-clock time in `tz`. */
export function zonedToUtc(c: Civil, tz: string): number {
  const local = localSecondsOf(c);
  if (tz === 'UTC') return local;
  return localToUtc((u) => intlOffsetAt(tz, u) ?? 0, local);
}

/** The local wall-clock time in `tz` of a UTC instant (seconds). */
export function utcToZoned(utcSeconds: number, tz: string): Civil {
  const offset = tz === 'UTC' ? 0 : (intlOffsetAt(tz, utcSeconds) ?? 0);
  return civilOfSeconds(utcSeconds + offset);
}

function prop(name: string, value: string, params: Record<string, string[]> = {}): Property {
  return { name, params, value };
}

interface When {
  readonly start: Property;
  readonly end: Property;
  readonly startCivil: Civil;
  readonly allDay: boolean;
  readonly tz: string;
}

function whenOf(input: EventInput): When {
  if (input.allDay) {
    const s = parseDay(input.start, 'start');
    const e = parseDay(input.end, 'end');
    if (localSecondsOf(e) <= localSecondsOf(s)) throw new EventError('invalid_event', 'an all-day event ends at least one day after it starts');
    return { start: prop('DTSTART', icsDate(s), { VALUE: ['DATE'] }), end: prop('DTEND', icsDate(e), { VALUE: ['DATE'] }), startCivil: s, allDay: true, tz: 'UTC' };
  }
  if (!knownZone(input.timezone)) throw new EventError('invalid_event', `unknown time zone ${input.timezone.slice(0, 64)}`);
  const s = parseLocal(input.start, 'start');
  const e = parseLocal(input.end, 'end');
  if (zonedToUtc(e, input.timezone) < zonedToUtc(s, input.timezone)) throw new EventError('invalid_event', 'an event cannot end before it starts');
  const utc = input.timezone === 'UTC';
  const params = utc ? {} : { TZID: [input.timezone] };
  return {
    start: prop('DTSTART', icsDateTime(s, utc), params),
    end: prop('DTEND', icsDateTime(e, utc), params),
    startCivil: s,
    allDay: false,
    tz: input.timezone,
  };
}

/** The RRULE value for a form's recurrence. */
export function rruleOf(r: RecurrenceInput, when: { allDay: boolean; tz: string }): string {
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 999) throw new EventError('invalid_event', 'interval is 1 to 999');
  if (r.count !== null && r.until !== null) throw new EventError('invalid_event', 'a series ends after a count or on a date, not both');
  if (r.count !== null && (!Number.isInteger(r.count) || r.count < 1 || r.count > 5000)) throw new EventError('invalid_event', 'count is 1 to 5000');
  const parts = [`FREQ=${r.freq}`];
  if (r.until !== null) {
    const u = parseDay(r.until, 'until');
    const last = { ...u, hour: 23, minute: 59, second: 59 };
    parts.push(`UNTIL=${when.allDay ? icsDate(u) : icsDateTime(civilOfSeconds(zonedToUtc(last, when.tz)), true)}`);
  }
  if (r.count !== null) parts.push(`COUNT=${String(r.count)}`);
  if (r.interval !== 1) parts.push(`INTERVAL=${String(r.interval)}`);
  if (r.freq === 'WEEKLY' && r.byDay.length > 0) {
    const days = [...new Set(r.byDay)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    parts.push(`BYDAY=${days.join(',')}`);
  }
  // Round-trip through the parser: what is stored is what expansion will read.
  return formatRecur(parseRecur(parts.join(';')));
}

function textProps(input: EventInput): Property[] {
  const out = [prop('SUMMARY', escapeText(input.summary.trim() === '' ? 'New event' : input.summary.trim()))];
  if (input.location.trim() !== '') out.push(prop('LOCATION', escapeText(input.location.trim())));
  if (input.description.trim() !== '') out.push(prop('DESCRIPTION', escapeText(input.description)));
  return out;
}

const stamp = (now: Date): string => icsDateTime(civilOfSeconds(Math.floor(now.getTime() / 1000)), true);

/** A new VCALENDAR holding one VEVENT. */
export function buildEvent(uid: string, input: EventInput, now: Date): Component {
  const when = whenOf(input);
  const props: Property[] = [
    prop('UID', uid),
    prop('DTSTAMP', stamp(now)),
    prop('CREATED', stamp(now)),
    prop('LAST-MODIFIED', stamp(now)),
    prop('SEQUENCE', '0'),
    ...textProps(input),
    when.start,
    when.end,
  ];
  if (input.recurrence !== null && input.recurrence !== undefined) props.push(prop('RRULE', rruleOf(input.recurrence, when)));
  return {
    name: 'VCALENDAR',
    properties: [prop('VERSION', '2.0'), prop('PRODID', '-//Postroom//Webmail//EN'), prop('CALSCALE', 'GREGORIAN')],
    components: [{ name: 'VEVENT', properties: props, components: [] }],
  };
}

const isOverride = (c: Component): boolean => getProperty(c, 'RECURRENCE-ID') !== undefined;

export function masterOf(calendar: Component): Component {
  const master = calendar.components.find((c) => c.name === 'VEVENT' && !isOverride(c));
  if (master === undefined) throw new EventError('not_an_event', 'this calendar object has no event to edit');
  return master;
}

const OWNED = new Set(['SUMMARY', 'LOCATION', 'DESCRIPTION', 'DTSTART', 'DTEND', 'DURATION', 'DTSTAMP', 'LAST-MODIFIED', 'SEQUENCE']);

function sequenceOf(c: Component): number {
  const n = Number(getProperty(c, 'SEQUENCE')?.value ?? '0');
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function sameProp(a: Property | undefined, b: Property | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The calendar with its master event's editable fields replaced (and everything else kept). */
export function applyEventInput(calendar: Component, input: EventInput, now: Date): Component {
  const master = masterOf(calendar);
  const when = whenOf(input);
  const oldStart = getProperty(master, 'DTSTART');
  const oldRule = getProperty(master, 'RRULE');
  const keepRule = input.recurrence === undefined;
  const rule = keepRule ? oldRule : input.recurrence === null ? undefined : prop('RRULE', rruleOf(input.recurrence, when));
  const seriesMoved = !sameProp(oldStart, when.start) || !sameProp(oldRule, rule);
  const kept = master.properties.filter((p) => !OWNED.has(p.name) && p.name !== 'RRULE' && !(seriesMoved && (p.name === 'EXDATE' || p.name === 'RDATE')));
  const uidAt = kept.findIndex((p) => p.name === 'UID');
  const head = kept.slice(0, uidAt + 1);
  const tail = kept.slice(uidAt + 1);
  const updated: Component = {
    ...master,
    properties: [
      ...head,
      prop('DTSTAMP', stamp(now)),
      prop('LAST-MODIFIED', stamp(now)),
      prop('SEQUENCE', String(sequenceOf(master) + 1)),
      ...textProps(input),
      when.start,
      when.end,
      ...(rule === undefined ? [] : [rule]),
      ...tail,
    ],
  };
  return {
    ...calendar,
    components: calendar.components.flatMap((c) => (c === master ? [updated] : seriesMoved && c.name === 'VEVENT' && isOverride(c) ? [] : [c])),
  };
}

/** The RECURRENCE-ID/EXDATE property form (value type and zone) of the master's DTSTART. */
function instanceProp(master: Component, name: string, recurrenceId: string): Property {
  const start = getProperty(master, 'DTSTART');
  if (start === undefined) throw new EventError('not_an_event', 'the event has no start');
  const v = propertyDate(start);
  const shape = v.type === 'date' ? /^\d{8}$/ : v.utc ? /^\d{8}T\d{6}Z$/ : /^\d{8}T\d{6}$/;
  if (!shape.test(recurrenceId)) throw new EventError('no_such_instance', 'that is not an instance of this series');
  const params: Record<string, string[]> = v.type === 'date' ? { VALUE: ['DATE'] } : v.tzid === null ? {} : { TZID: [v.tzid] };
  return prop(name, recurrenceId, params);
}

/** Is `recurrenceId` one of the series' instances (override or not)? Bounded to a two-day window. */
function hasInstance(calendar: Component, uid: string, recurrenceId: string): boolean {
  const y = Number(recurrenceId.slice(0, 4));
  const m = Number(recurrenceId.slice(4, 6));
  const d = Number(recurrenceId.slice(6, 8));
  const centre = Date.UTC(y, m - 1, d);
  const window = { start: centre - 2 * 86_400_000, end: centre + 3 * 86_400_000, maxInstances: 200 };
  return expandCalendar(calendar, window).instances.some((i) => i.uid === uid && i.recurrenceId === recurrenceId);
}

function overrideRid(c: Component): string | null {
  return getProperty(c, 'RECURRENCE-ID')?.value.trim() ?? null;
}

/**
 * Edit one instance: a RECURRENCE-ID override carrying the new fields (and the master's other
 * properties and alarms), replacing any earlier override of the same instance.
 */
export function applyInstanceOverride(calendar: Component, recurrenceId: string, input: EventInput, now: Date): Component {
  const master = masterOf(calendar);
  const uid = getProperty(master, 'UID')?.value ?? '';
  if (getProperty(master, 'RRULE') === undefined && getProperty(master, 'RDATE') === undefined) throw new EventError('not_recurring', 'this event does not repeat');
  const rid = instanceProp(master, 'RECURRENCE-ID', recurrenceId);
  const previous = calendar.components.find((c) => c.name === 'VEVENT' && overrideRid(c) === recurrenceId);
  if (previous === undefined && !hasInstance(calendar, uid, recurrenceId)) throw new EventError('no_such_instance', 'that is not an instance of this series');
  const when = whenOf({ ...input, recurrence: null });
  const base = previous ?? master;
  const kept = base.properties.filter((p) => !OWNED.has(p.name) && !['RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID', 'UID'].includes(p.name));
  const override: Component = {
    name: 'VEVENT',
    properties: [
      prop('UID', uid),
      rid,
      prop('DTSTAMP', stamp(now)),
      prop('LAST-MODIFIED', stamp(now)),
      prop('SEQUENCE', String(sequenceOf(base) + 1)),
      ...textProps(input),
      when.start,
      when.end,
      ...kept,
    ],
    components: base.components,
  };
  const others = calendar.components.filter((c) => c !== previous);
  return { ...calendar, components: [...others, override] };
}

/** Delete one instance: an EXDATE on the master, and its override (if any) gone. */
export function excludeInstance(calendar: Component, recurrenceId: string): Component {
  const master = masterOf(calendar);
  const uid = getProperty(master, 'UID')?.value ?? '';
  const exdate = instanceProp(master, 'EXDATE', recurrenceId);
  const overridden = calendar.components.some((c) => c.name === 'VEVENT' && overrideRid(c) === recurrenceId);
  if (!overridden && !hasInstance(calendar, uid, recurrenceId)) throw new EventError('no_such_instance', 'that is not an instance of this series');
  const updated: Component = { ...master, properties: [...master.properties, exdate] };
  return {
    ...calendar,
    components: calendar.components.flatMap((c) => (c === master ? [updated] : c.name === 'VEVENT' && overrideRid(c) === recurrenceId ? [] : [c])),
  };
}

function textOf(c: Component, name: string): string {
  const p = getProperty(c, name);
  return p === undefined ? '' : parseText(p.value);
}

function civilOf(v: ICalDateValue): Civil {
  return v.type === 'date' ? { year: v.year, month: v.month, day: v.day, hour: 0, minute: 0, second: 0 } : { year: v.year, month: v.month, day: v.day, hour: v.hour, minute: v.minute, second: v.second };
}

function recurrenceView(rule: string, allDay: boolean, tz: string): RecurrenceView {
  let r: Recur;
  try {
    r = parseRecur(rule);
  } catch {
    return { freq: 'UNKNOWN', interval: 1, byDay: [], count: null, until: null, rule, editable: false };
  }
  const plainDays = r.byDay.every((d) => d.n === 0);
  const editable =
    (FREQUENCIES as readonly string[]).includes(r.freq) &&
    plainDays &&
    (r.byDay.length === 0 || r.freq === 'WEEKLY') &&
    [r.bySecond, r.byMinute, r.byHour, r.byMonthDay, r.byYearDay, r.byWeekNo, r.byMonth, r.bySetPos].every((x) => x.length === 0) &&
    r.extra.length === 0;
  let until: string | null = null;
  if (r.until !== null) {
    const u = r.until;
    until = isoDay(u.type === 'date-time' && u.utc && !allDay ? utcToZoned(localSecondsOf(civilOf(u)), tz) : civilOf(u));
  }
  return {
    freq: r.freq,
    interval: r.interval,
    byDay: r.byDay.map((d) => `${d.n === 0 ? '' : String(d.n)}${WEEKDAYS[d.weekday] ?? 'MO'}`),
    count: r.count,
    until,
    rule,
    editable,
  };
}

/** The master event as the form shows it. */
export function eventView(calendar: Component): EventView {
  const master = masterOf(calendar);
  const startProp = getProperty(master, 'DTSTART');
  if (startProp === undefined) throw new EventError('not_an_event', 'the event has no start');
  const start = propertyDate(startProp);
  const allDay = start.type === 'date';
  const timezone = start.type === 'date' ? null : start.utc ? 'UTC' : start.tzid;
  const sc = civilOf(start);
  let ec: Civil;
  const endProp = getProperty(master, 'DTEND');
  const durProp = getProperty(master, 'DURATION');
  if (endProp !== undefined) {
    ec = civilOf(propertyDate(endProp));
  } else if (durProp !== undefined) {
    const d = parseDuration(durProp.value);
    const seconds = d.sign * (((d.weeks * 7 + d.days) * 24 + d.hours) * 3600 + d.minutes * 60 + d.seconds);
    ec = civilOfSeconds(localSecondsOf(sc) + seconds);
  } else {
    ec = civilOfSeconds(localSecondsOf(sc) + (allDay ? 86_400 : 0));
  }
  const rule = getProperty(master, 'RRULE');
  return {
    uid: getProperty(master, 'UID')?.value ?? '',
    summary: textOf(master, 'SUMMARY'),
    description: textOf(master, 'DESCRIPTION'),
    location: textOf(master, 'LOCATION'),
    allDay,
    start: allDay ? isoDay(sc) : isoLocal(sc),
    end: allDay ? isoDay(ec) : isoLocal(ec),
    timezone,
    recurrence: rule === undefined ? null : recurrenceView(rule.value, allDay, timezone ?? 'UTC'),
    overrides: calendar.components.filter((c) => c.name === 'VEVENT' && isOverride(c)).map((c) => overrideRid(c) ?? ''),
    exdates: getProperties(master, 'EXDATE').flatMap((p) => p.value.split(',').map((v) => v.trim())).filter((v) => v !== ''),
  };
}

export interface InstanceView {
  readonly uid: string;
  readonly recurrenceId: string;
  /** UTC ISO instants; for an all-day instance, midnight in the viewer's zone. */
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  /** All-day only: the first day and the day after the last, `YYYY-MM-DD`. */
  readonly startDay: string | null;
  readonly endDay: string | null;
  readonly summary: string;
  readonly location: string;
  readonly recurring: boolean;
  readonly override: boolean;
}

export function instanceView(i: Instance, recurring: boolean, tz: string): InstanceView {
  const day = (ms: number): string => isoDay(utcToZoned(Math.floor(ms / 1000), tz));
  return {
    uid: i.uid ?? '',
    recurrenceId: i.recurrenceId,
    start: new Date(i.start).toISOString(),
    end: new Date(i.end).toISOString(),
    allDay: i.allDay,
    startDay: i.allDay ? day(i.start) : null,
    endDay: i.allDay ? day(i.end) : null,
    summary: textOf(i.component, 'SUMMARY'),
    location: textOf(i.component, 'LOCATION'),
    recurring,
    override: i.override,
  };
}

/** Is the master of this calendar object a series? */
export function isRecurring(calendar: Component): boolean {
  return calendar.components.some((c) => c.name === 'VEVENT' && !isOverride(c) && (getProperty(c, 'RRULE') !== undefined || getProperty(c, 'RDATE') !== undefined));
}
