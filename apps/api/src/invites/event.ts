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

/** The invite's calendar, with every schedulable component's STATUS set to CANCELLED. */
export function withCancelled(calendar: Component): Component {
  const apply = (c: Component): Component => {
    if (!isSchedulable(c.name)) return c;
    const properties: Property[] = [...c.properties.filter((p) => p.name !== 'STATUS'), { name: 'STATUS', params: {}, value: 'CANCELLED' }];
    return { ...c, properties };
  };
  return { ...stripMethod(calendar), components: calendar.components.map(apply) };
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
  for (const c of calendar.components) {
    if (!isSchedulable(c.name)) continue;
    if ((getProperty(c, 'STATUS')?.value ?? '').toUpperCase() === 'CANCELLED') return true;
  }
  return false;
}
