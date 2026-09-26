// Turning an iMIP invite into the calendar object stored in the default calendar (PST-T-8.4,
// PST-REQ-134): the invite's own VEVENT/VTIMEZONE, unchanged, except METHOD is dropped (a stored
// calendar object is never itself a REQUEST/REPLY/CANCEL) and the responding ATTENDEE's PARTSTAT is
// set to what was chosen. Pure: no database, no clock.
import {
  calAddressEmail,
  createTimeZoneResolver,
  dateTimeToUtc,
  formatRecur,
  getProperty,
  parseDateOrDateTime,
  parseRecur,
  propertyDate,
  type Component,
  type ICalDateValue,
  type Property,
  type TimeZoneResolver,
} from '@postroom/ical';

/** A calendar object is never itself an iTIP method: only the message wrapping it is. */
export function stripMethod(calendar: Component): Component {
  return { ...calendar, properties: calendar.properties.filter((p) => p.name !== 'METHOD') };
}

const isSchedulable = (name: string): boolean => name === 'VEVENT' || name === 'VTODO';

/** The invite's calendar, with `email`'s ATTENDEE (case-insensitive) set to `partstat`. */
export function withAttendeePartstat(calendar: Component, email: string, partstat: string): Component {
  const target = email.trim().toLowerCase();
  const apply = (c: Component): Component => {
    if (!isSchedulable(c.name)) return c;
    const properties = c.properties.map((p): Property => {
      if (p.name !== 'ATTENDEE' || calAddressEmail(p.value)?.toLowerCase() !== target) return p;
      return { ...p, params: { ...p.params, PARTSTAT: [partstat] } };
    });
    return { ...c, properties };
  };
  return { ...stripMethod(calendar), components: calendar.components.map(apply) };
}

/** The instant a RECURRENCE-ID/DTSTART value names, as a number comparable across DATE and DATE-TIME (UTC seconds, or UTC midnight seconds for an all-day value). Two representations of the same instant (a UTC value and its TZID equivalent) compare equal. */
function instantOf(v: ICalDateValue, resolver: TimeZoneResolver): number {
  return v.type === 'date' ? Date.UTC(v.year, v.month - 1, v.day) / 1000 : dateTimeToUtc(v, resolver, null);
}

/** `value`/`params` (as read off a RECURRENCE-ID) parsed into an `ICalDateValue`. */
function parseRecurrenceValue(value: string, params: Property['params']): ICalDateValue {
  return parseDateOrDateTime(value, params.TZID?.[0] ?? null, params.VALUE?.[0]);
}

/** Only the parameters that describe a date/date-time's *shape* (TZID, VALUE) — never RANGE. */
function shapeParams(params: Property['params']): Property['params'] {
  const out: Property['params'] = {};
  if (params.TZID !== undefined) out.TZID = params.TZID;
  if (params.VALUE !== undefined) out.VALUE = params.VALUE;
  return out;
}

/** `formatDateValue`, inlined for a value this module has already computed the parts of. */
function formatValue(v: ICalDateValue): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const date = `${pad(v.year, 4)}${pad(v.month)}${pad(v.day)}`;
  return v.type === 'date' ? date : `${date}T${pad(v.hour)}${pad(v.minute)}${pad(v.second)}${v.utc ? 'Z' : ''}`;
}

/**
 * RANGE=THISANDFUTURE's UNTIL (RFC 5546 §3.2.5): the same value type as the *master's* DTSTART
 * (DATE for an all-day master; otherwise always UTC, RFC 5545 §3.3.10), naming the instant just
 * before the cancelled occurrence — so that occurrence, and everything the RRULE would produce
 * after it, are excluded, while every earlier one is untouched.
 */
function untilBefore(instant: ICalDateValue, masterAllDay: boolean, resolver: TimeZoneResolver): ICalDateValue {
  if (masterAllDay) {
    const day = instant.type === 'date' ? instant : { year: instant.year, month: instant.month, day: instant.day };
    const d = new Date(Date.UTC(day.year, day.month - 1, day.day) - 86_400_000);
    return { type: 'date', year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
  }
  const utc = instantOf(instant, resolver);
  const d = new Date((utc - 1) * 1000);
  return { type: 'date-time', utc: true, tzid: null, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

/** `master`'s RRULE(s), each truncated with `until` in place of any COUNT/UNTIL it already had. */
function truncateRrules(c: Component, until: ICalDateValue): Component {
  const properties = c.properties.map((p): Property => {
    if (p.name !== 'RRULE') return p;
    const rule = parseRecur(p.value);
    return { ...p, value: formatRecur({ ...rule, until, count: null }) };
  });
  return { ...c, properties };
}

/**
 * The stored calendar with a CANCEL applied (RFC 5546 §3.2.5). Without a RECURRENCE-ID the whole
 * series is cancelled: every schedulable component gets STATUS:CANCELLED. With one (PST-T-8.9),
 * matched by normalised instant rather than raw text so a UTC RECURRENCE-ID and its TZID
 * equivalent still agree:
 *  - a plain RECURRENCE-ID cancels only that occurrence — its override, if there is one, gets
 *    STATUS:CANCELLED; otherwise the master gains an EXDATE for it (only the RECURRENCE-ID's own
 *    TZID/VALUE parameters are copied — never RANGE);
 *  - RECURRENCE-ID;RANGE=THISANDFUTURE (RFC 5546 §3.2.5) cancels that occurrence and every later
 *    one: every override at or after it is cancelled, and the master's RRULE(s) are truncated with
 *    an UNTIL just before it.
 */
export function withCancelled(calendar: Component, recurrenceId: { value: string; params: Property['params'] } | null = null): Component {
  const cancel = (c: Component): Component => ({
    ...c,
    properties: [...c.properties.filter((p) => p.name !== 'STATUS'), { name: 'STATUS', params: {}, value: 'CANCELLED' }],
  });
  const base = stripMethod(calendar);
  if (recurrenceId === null) return { ...base, components: calendar.components.map((c) => (isSchedulable(c.name) ? cancel(c) : c)) };

  const resolver = createTimeZoneResolver(calendar);
  const wanted = parseRecurrenceValue(recurrenceId.value.trim(), recurrenceId.params);
  const wantedInstant = instantOf(wanted, resolver);
  const isRange = (recurrenceId.params.RANGE?.[0] ?? '').toUpperCase() === 'THISANDFUTURE';

  const overrideInstant = (c: Component): number | null => {
    const rid = getProperty(c, 'RECURRENCE-ID');
    return rid === undefined ? null : instantOf(propertyDate(rid), resolver);
  };
  const cancelled = (c: Component): boolean => {
    const instant = overrideInstant(c);
    return instant !== null && (isRange ? instant >= wantedInstant : instant === wantedInstant);
  };
  const hasExactOverride = calendar.components.some((c) => isSchedulable(c.name) && overrideInstant(c) === wantedInstant);

  const main = master(calendar);
  const masterDtstart = main === undefined ? undefined : getProperty(main, 'DTSTART');
  const masterAllDay = masterDtstart !== undefined && propertyDate(masterDtstart).type === 'date';

  return {
    ...base,
    components: calendar.components.map((c) => {
      if (isSchedulable(c.name) && cancelled(c)) return cancel(c);
      if (c !== main) return c;
      if (isRange) return truncateRrules(c, untilBefore(wanted, masterAllDay, resolver));
      if (hasExactOverride) return c;
      return { ...c, properties: [...c.properties, { name: 'EXDATE', params: shapeParams(recurrenceId.params), value: formatValue(wanted) }] };
    }),
  };
}

/** The PARTSTAT of `email` in the master (non-override) schedulable component, or null. */
export function attendeePartstat(calendar: Component, email: string): string | null {
  const target = email.trim().toLowerCase();
  for (const c of calendar.components) {
    if (!isSchedulable(c.name)) continue;
    for (const p of c.properties) {
      if (p.name === 'ATTENDEE' && calAddressEmail(p.value)?.toLowerCase() === target) {
        return (p.params['PARTSTAT']?.[0] ?? 'NEEDS-ACTION').toUpperCase();
      }
    }
  }
  return null;
}

/** True when the master (non-override) schedulable component's STATUS is CANCELLED. */
export function isCancelled(calendar: Component): boolean {
  const c = master(calendar);
  return c !== undefined && (getProperty(c, 'STATUS')?.value ?? '').toUpperCase() === 'CANCELLED';
}

/** The master (non-override) schedulable component, or undefined. */
function master(calendar: Component): Component | undefined {
  const schedulable = calendar.components.filter((c) => isSchedulable(c.name));
  return schedulable.find((c) => getProperty(c, 'RECURRENCE-ID') === undefined) ?? schedulable[0];
}

/** The ORGANIZER of the stored event, lower-cased, when it is one valid mailbox; null otherwise. */
export function storedOrganizer(calendar: Component): string | null {
  const c = master(calendar);
  const prop = c === undefined ? undefined : getProperty(c, 'ORGANIZER');
  return prop === undefined ? null : (calAddressEmail(prop.value)?.toLowerCase() ?? null);
}

/** The stored event's SEQUENCE (RFC 5545 §3.8.7.4; absent means 0). */
export function storedSequence(calendar: Component): number {
  const c = master(calendar);
  const n = Number((c === undefined ? undefined : getProperty(c, 'SEQUENCE'))?.value ?? '0');
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** The RECURRENCE-ID a CANCEL names (value and TZID/VALUE parameters), or null for the whole series. */
export function cancelRecurrence(invite: { component: Component }): { value: string; params: Property['params'] } | null {
  const p = getProperty(invite.component, 'RECURRENCE-ID');
  return p === undefined ? null : { value: p.value, params: p.params };
}
