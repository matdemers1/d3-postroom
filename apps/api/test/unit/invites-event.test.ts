// PST-T-8.9: a CANCEL for one occurrence cancels that occurrence, never the whole series.
import { describe, expect, it } from 'vitest';
import { expandCalendar, parseICalendar, serializeICalendar, type Component } from '@postroom/ical';
import { isCancelled, withCancelled } from '../../src/invites/event.js';

const SERIES = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:weekly@example.com',
  'DTSTAMP:20260901T000000Z',
  'DTSTART:20260907T150000Z',
  'DTEND:20260907T160000Z',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'SUMMARY:Weekly',
  'ORGANIZER:mailto:org@example.com',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly@example.com',
  'DTSTAMP:20260901T000000Z',
  'RECURRENCE-ID:20260921T150000Z',
  'DTSTART:20260921T170000Z',
  'DTEND:20260921T180000Z',
  'SUMMARY:Weekly (moved)',
  'ORGANIZER:mailto:org@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const cal = (): Component => parseICalendar(SERIES);
const status = (c: Component): string[] => c.components.filter((x) => x.name === 'VEVENT').map((x) => x.properties.find((p) => p.name === 'STATUS')?.value ?? 'CONFIRMED');

describe('withCancelled', () => {
  it('cancels the whole series without a RECURRENCE-ID', () => {
    const out = withCancelled(cal());
    expect(status(out)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(isCancelled(out)).toBe(true);
  });

  it('cancels only an occurrence that has an override', () => {
    const out = withCancelled(cal(), { value: '20260921T150000Z', params: {} });
    expect(status(out)).toEqual(['CONFIRMED', 'CANCELLED']);
    expect(isCancelled(out)).toBe(false);
  });

  it('adds an EXDATE for an occurrence with no override, and the other occurrences survive', () => {
    const out = withCancelled(cal(), { value: '20260914T150000Z', params: {} });
    const master = out.components.find((x) => x.name === 'VEVENT' && !x.properties.some((p) => p.name === 'RECURRENCE-ID'));
    expect(master?.properties.filter((p) => p.name === 'EXDATE').map((p) => p.value)).toEqual(['20260914T150000Z']);
    expect(isCancelled(out)).toBe(false);
    const reparsed = parseICalendar(serializeICalendar(out));
    const starts = expandCalendar(reparsed, { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') }).instances.map((i) => new Date(i.start).toISOString());
    expect(starts).not.toContain('2026-09-14T15:00:00.000Z');
    expect(starts).toHaveLength(3);
  });
});
