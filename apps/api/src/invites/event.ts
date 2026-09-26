// Turning an iMIP invite into the calendar object stored in the default calendar (PST-T-8.4,
// PST-REQ-134): the invite's own VEVENT/VTIMEZONE, unchanged, except METHOD is dropped (a stored
// calendar object is never itself a REQUEST/REPLY/CANCEL) and the responding ATTENDEE's PARTSTAT is
// set to what was chosen. Pure: no database, no clock.
import { calAddressEmail, getProperty, type Component, type Property } from '@postroom/ical';

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

/**
 * The stored calendar with a CANCEL applied (RFC 5546 §3.2.5). Without a RECURRENCE-ID the whole
 * series is cancelled: every schedulable component gets STATUS:CANCELLED. With one (PST-T-8.9) only
 * that occurrence is: its override, if the calendar has one, gets STATUS:CANCELLED; otherwise the
 * master gains an EXDATE for it, carrying the RECURRENCE-ID's own TZID/VALUE parameters.
 */
export function withCancelled(calendar: Component, recurrenceId: { value: string; params: Property['params'] } | null = null): Component {
  const cancel = (c: Component): Component => ({
    ...c,
    properties: [...c.properties.filter((p) => p.name !== 'STATUS'), { name: 'STATUS', params: {}, value: 'CANCELLED' }],
  });
  const base = stripMethod(calendar);
  if (recurrenceId === null) return { ...base, components: calendar.components.map((c) => (isSchedulable(c.name) ? cancel(c) : c)) };

  const wanted = recurrenceId.value.trim();
  const isOverride = (c: Component): boolean => isSchedulable(c.name) && getProperty(c, 'RECURRENCE-ID')?.value.trim() === wanted;
  if (calendar.components.some(isOverride)) {
    return { ...base, components: calendar.components.map((c) => (isOverride(c) ? cancel(c) : c)) };
  }
  const main = master(calendar);
  return {
    ...base,
    components: calendar.components.map((c) =>
      c === main ? { ...c, properties: [...c.properties, { name: 'EXDATE', params: recurrenceId.params, value: wanted }] } : c,
    ),
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
