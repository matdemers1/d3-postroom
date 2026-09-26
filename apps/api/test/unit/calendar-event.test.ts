// PST-T-8.5 (PST-REQ-136): the event form ↔ iCalendar, pure. Weekly recurrence expands to the right
// days, an instance edit is a RECURRENCE-ID override, an instance delete an EXDATE, and an edit of
// the series keeps what the form does not own.
import { expandCalendar, getProperties, getProperty, parseICalendar, serializeICalendar } from '@postroom/ical';
import { describe, expect, it } from 'vitest';
import {
  applyEventInput,
  applyInstanceOverride,
  buildEvent,
  EventError,
  eventView,
  excludeInstance,
  knownZone,
  rruleOf,
  type EventInput,
} from '../../src/calendar/event.js';

const NOW = new Date('2026-09-26T12:00:00Z');
const WEEKLY: EventInput = {
  summary: 'Standup',
  description: 'Daily-ish, with commas, and; semicolons',
  location: 'Room 1',
  allDay: false,
  start: '2026-10-05T09:00',
  end: '2026-10-05T09:30',
  timezone: 'America/New_York',
  recurrence: { freq: 'WEEKLY', interval: 1, byDay: ['WE', 'MO'], count: 6, until: null },
};
const OCTOBER = { start: Date.parse('2026-10-01T00:00:00Z'), end: Date.parse('2026-11-01T00:00:00Z') };

const roundTrip = (c: ReturnType<typeof buildEvent>) => parseICalendar(serializeICalendar(c));

describe('events as iCalendar (PST-REQ-136)', () => {
  it('a weekly BYDAY=MO,WE COUNT=6 event expands to exactly its six days', () => {
    const cal = roundTrip(buildEvent('UID-1', WEEKLY, NOW));
    const master = cal.components[0];
    expect(getProperty(master ?? cal, 'RRULE')?.value).toBe('FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE');
    expect(getProperty(master ?? cal, 'DTSTART')).toEqual({ name: 'DTSTART', params: { TZID: ['America/New_York'] }, value: '20261005T090000' });
    const { instances } = expandCalendar(cal, OCTOBER);
    expect(instances.map((i) => new Date(i.start).toISOString())).toEqual([
      '2026-10-05T13:00:00.000Z',
      '2026-10-07T13:00:00.000Z',
      '2026-10-12T13:00:00.000Z',
      '2026-10-14T13:00:00.000Z',
      '2026-10-19T13:00:00.000Z',
      '2026-10-21T13:00:00.000Z',
    ]);
    expect(instances.every((i) => i.end - i.start === 30 * 60_000)).toBe(true);
  });

  it('reads back as the form wrote it', () => {
    const view = eventView(roundTrip(buildEvent('UID-1', WEEKLY, NOW)));
    expect(view).toMatchObject({
      uid: 'UID-1',
      summary: 'Standup',
      description: 'Daily-ish, with commas, and; semicolons',
      location: 'Room 1',
      allDay: false,
      start: '2026-10-05T09:00',
      end: '2026-10-05T09:30',
      timezone: 'America/New_York',
      recurrence: { freq: 'WEEKLY', interval: 1, byDay: ['MO', 'WE'], count: 6, until: null, editable: true },
      overrides: [],
      exdates: [],
    });
  });

  it('UNTIL is the end of the given day in the event’s zone, written in UTC', () => {
    expect(rruleOf({ freq: 'DAILY', interval: 2, byDay: [], count: null, until: '2026-10-10' }, { allDay: false, tz: 'America/New_York' })).toBe('FREQ=DAILY;UNTIL=20261011T035959Z;INTERVAL=2');
    expect(rruleOf({ freq: 'MONTHLY', interval: 1, byDay: [], count: null, until: '2026-12-31' }, { allDay: true, tz: 'UTC' })).toBe('FREQ=MONTHLY;UNTIL=20261231');
    const cal = roundTrip(buildEvent('U', { ...WEEKLY, recurrence: { freq: 'DAILY', interval: 1, byDay: [], count: null, until: '2026-10-07' } }, NOW));
    expect(expandCalendar(cal, OCTOBER).instances).toHaveLength(3);
    expect(eventView(cal).recurrence?.until).toBe('2026-10-07');
    // BYDAY is only for weekly rules.
    expect(rruleOf({ freq: 'MONTHLY', interval: 1, byDay: ['MO'], count: 3, until: null }, { allDay: false, tz: 'UTC' })).toBe('FREQ=MONTHLY;COUNT=3');
    expect(() => rruleOf({ freq: 'DAILY', interval: 1, byDay: [], count: 2, until: '2026-10-10' }, { allDay: false, tz: 'UTC' })).toThrow(EventError);
  });

  it('all-day events are DATE values with an exclusive end', () => {
    const cal = roundTrip(buildEvent('AD', { ...WEEKLY, allDay: true, start: '2026-10-05', end: '2026-10-07', recurrence: { freq: 'YEARLY', interval: 1, byDay: [], count: 2, until: null } }, NOW));
    const master = cal.components[0] ?? cal;
    expect(getProperty(master, 'DTSTART')).toEqual({ name: 'DTSTART', params: { VALUE: ['DATE'] }, value: '20261005' });
    expect(getProperty(master, 'DTEND')?.value).toBe('20261007');
    const all = expandCalendar(cal, { start: Date.parse('2026-01-01T00:00:00Z'), end: Date.parse('2028-01-01T00:00:00Z') }).instances;
    expect(all.map((i) => [i.allDay, i.recurrenceId])).toEqual([
      [true, '20261005'],
      [true, '20271005'],
    ]);
    expect(() => buildEvent('X', { ...WEEKLY, allDay: true, start: '2026-10-05', end: '2026-10-05' }, NOW)).toThrow(/at least one day/);
  });

  it('editing one instance writes a RECURRENCE-ID override that moves just that instance', () => {
    const cal = roundTrip(buildEvent('UID-2', WEEKLY, NOW));
    const moved = roundTrip(applyInstanceOverride(cal, '20261012T090000', { ...WEEKLY, summary: 'Standup (moved)', start: '2026-10-13T10:00', end: '2026-10-13T11:00' }, NOW));
    const override = moved.components.find((c) => getProperty(c, 'RECURRENCE-ID') !== undefined);
    expect(getProperty(override ?? moved, 'RECURRENCE-ID')).toEqual({ name: 'RECURRENCE-ID', params: { TZID: ['America/New_York'] }, value: '20261012T090000' });
    expect(getProperty(override ?? moved, 'RRULE')).toBeUndefined();
    expect(getProperty(override ?? moved, 'UID')?.value).toBe('UID-2');
    const { instances } = expandCalendar(moved, OCTOBER);
    expect(instances).toHaveLength(6);
    const edited = instances.find((i) => i.override);
    expect(edited).toMatchObject({ recurrenceId: '20261012T090000', start: Date.parse('2026-10-13T14:00:00Z'), end: Date.parse('2026-10-13T15:00:00Z') });
    expect(getProperty(edited?.component ?? moved, 'SUMMARY')?.value).toBe('Standup (moved)');
    expect(eventView(moved).overrides).toEqual(['20261012T090000']);
    // Editing the same instance again replaces its override rather than adding a second.
    const again = applyInstanceOverride(moved, '20261012T090000', { ...WEEKLY, summary: 'Again', start: '2026-10-13T10:00', end: '2026-10-13T11:00' }, NOW);
    expect(again.components.filter((c) => getProperty(c, 'RECURRENCE-ID') !== undefined)).toHaveLength(1);
    // Not an instance: refused.
    expect(() => applyInstanceOverride(cal, '20261013T090000', WEEKLY, NOW)).toThrow(/not an instance/);
    expect(() => applyInstanceOverride(cal, '20261012', WEEKLY, NOW)).toThrow(/not an instance/);
  });

  it('deleting one instance adds an EXDATE and drops its override', () => {
    const cal = roundTrip(buildEvent('UID-3', WEEKLY, NOW));
    const moved = applyInstanceOverride(cal, '20261014T090000', { ...WEEKLY, start: '2026-10-14T12:00', end: '2026-10-14T13:00' }, NOW);
    const cut = roundTrip(excludeInstance(moved, '20261014T090000'));
    expect(getProperties(cut.components[0] ?? cut, 'EXDATE')).toEqual([{ name: 'EXDATE', params: { TZID: ['America/New_York'] }, value: '20261014T090000' }]);
    expect(cut.components.some((c) => getProperty(c, 'RECURRENCE-ID') !== undefined)).toBe(false);
    expect(expandCalendar(cut, OCTOBER).instances.map((i) => i.recurrenceId)).toEqual(['20261005T090000', '20261007T090000', '20261012T090000', '20261019T090000', '20261021T090000']);
  });

  it('editing the series keeps alarms and unknown properties; moving it drops stale overrides', () => {
    const phone = parseICalendar(
      [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Apple Inc.//iPhone OS 26.0//EN',
        'BEGIN:VEVENT',
        'UID:PHONE-1',
        'DTSTAMP:20260901T000000Z',
        'DTSTART;TZID=America/New_York:20261005T090000',
        'DTEND;TZID=America/New_York:20261005T093000',
        'RRULE:FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE',
        'SUMMARY:Standup',
        'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
        'SEQUENCE:3',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT15M',
        'DESCRIPTION:Reminder',
        'END:VALARM',
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n'),
    );
    const renamed = applyEventInput(phone, { ...WEEKLY, summary: 'Renamed', recurrence: undefined }, NOW);
    const master = renamed.components[0] ?? renamed;
    expect(getProperty(master, 'SUMMARY')?.value).toBe('Renamed');
    expect(getProperty(master, 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR')?.value).toBe('AUTOMATIC');
    expect(getProperty(master, 'SEQUENCE')?.value).toBe('4');
    expect(getProperty(master, 'RRULE')?.value).toBe('FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE');
    expect(master.components.map((c) => c.name)).toEqual(['VALARM']);

    const withOverride = applyInstanceOverride(renamed, '20261007T090000', { ...WEEKLY, start: '2026-10-07T11:00', end: '2026-10-07T12:00' }, NOW);
    // Same start and rule: the override survives a rename.
    expect(applyEventInput(withOverride, { ...WEEKLY, summary: 'Again', recurrence: undefined }, NOW).components).toHaveLength(2);
    // A new start: the override named an instance of the old series, so it goes.
    expect(applyEventInput(withOverride, { ...WEEKLY, start: '2026-10-06T09:00', end: '2026-10-06T09:30', recurrence: undefined }, NOW).components).toHaveLength(1);
    // recurrence: null stops it repeating.
    expect(getProperty(applyEventInput(phone, { ...WEEKLY, recurrence: null }, NOW).components[0] ?? phone, 'RRULE')).toBeUndefined();
  });

  it('refuses nonsense', () => {
    expect(() => buildEvent('X', { ...WEEKLY, timezone: 'Mars/Olympus_Mons' }, NOW)).toThrow(/time zone/);
    expect(() => buildEvent('X', { ...WEEKLY, end: '2026-10-05T08:00' }, NOW)).toThrow(/end before/);
    expect(() => buildEvent('X', { ...WEEKLY, start: '2026-02-30T09:00' }, NOW)).toThrow(/not a date/);
    expect(knownZone('Europe/London')).toBe(true);
    expect(knownZone('UTC')).toBe(true);
    expect(knownZone('../etc')).toBe(false);
  });

  it('a rule the form cannot show is reported as not editable', () => {
    const cal = parseICalendar(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20261001T100000Z\r\nDTEND:20261001T110000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=-1FR\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
    expect(eventView(cal)).toMatchObject({ timezone: 'UTC', start: '2026-10-01T10:00', recurrence: { freq: 'MONTHLY', rule: 'FREQ=MONTHLY;BYDAY=-1FR', editable: false } });
  });
});
