// PST-T-8.9: a CANCEL for one occurrence cancels that occurrence, never the whole series.
import { describe, expect, it } from 'vitest';
import { expandCalendar, getProperty, parseICalendar, serializeICalendar, type Component } from '@postroom/ical';
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

// A weekly series whose one override is stored with a UTC RECURRENCE-ID (as the SERIES fixture
// above), used for the raw-string-vs-normalised-instant defect (a CANCEL naming the same instant
// in a different zone must still match the override).
const NY_OVERRIDE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'X-LIC-LOCATION:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:weekly-tz@example.com',
  'DTSTAMP:20260901T000000Z',
  'DTSTART;TZID=America/New_York:20260907T110000',
  'DTEND;TZID=America/New_York:20260907T120000',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'SUMMARY:Weekly',
  'ORGANIZER:mailto:org@example.com',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:weekly-tz@example.com',
  'DTSTAMP:20260901T000000Z',
  'RECURRENCE-ID:20260914T150000Z',
  'DTSTART;TZID=America/New_York:20260914T130000',
  'DTEND;TZID=America/New_York:20260914T140000',
  'SUMMARY:Weekly (moved)',
  'ORGANIZER:mailto:org@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');
const nyCal = (): Component => parseICalendar(NY_OVERRIDE);
const nyStatus = (c: Component): string[] => c.components.filter((x) => x.name === 'VEVENT').map((x) => x.properties.find((p) => p.name === 'STATUS')?.value ?? 'CONFIRMED');

const ALL_DAY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//test//EN',
  'BEGIN:VEVENT',
  'UID:allday@example.com',
  'DTSTAMP:20260901T000000Z',
  'DTSTART;VALUE=DATE:20260907',
  'DTEND;VALUE=DATE:20260908',
  'RRULE:FREQ=DAILY;COUNT=4',
  'SUMMARY:Daily',
  'ORGANIZER:mailto:org@example.com',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');
const allDayCal = (): Component => parseICalendar(ALL_DAY);

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

  // --- The verifier's refutation (PST-T-8.9 retry) -----------------------------------------------

  it('DEFECT 1: RECURRENCE-ID;RANGE=THISANDFUTURE cancels that occurrence and every later one, never the whole series, and writes a valid truncated RRULE (not EXDATE;RANGE=…)', () => {
    const out = withCancelled(cal(), { value: '20260914T150000Z', params: { RANGE: ['THISANDFUTURE'] } });
    const master = out.components.find((x) => x.name === 'VEVENT' && !x.properties.some((p) => p.name === 'RECURRENCE-ID'));
    expect(master?.properties.some((p) => p.name === 'EXDATE')).toBe(false);
    const rrule = master?.properties.find((p) => p.name === 'RRULE')?.value ?? '';
    expect(rrule).toContain('UNTIL=20260914T145959Z');
    expect(rrule).not.toContain('COUNT=');
    // The 09-21 override (at or after the cancelled instant) is cancelled too.
    expect(status(out)).toEqual(['CONFIRMED', 'CANCELLED']);
    expect(isCancelled(out)).toBe(false);

    // Every instance the calendar expands to over the range: 09-07 stays CONFIRMED, 09-21 (the
    // override, moved to it's own time) is CANCELLED, and the RRULE truncation drops 09-14 and
    // 09-28 from the expansion entirely (RFC 4791 §9.9: the recurrence set no longer produces them).
    const reparsed = parseICalendar(serializeICalendar(out));
    const instances = expandCalendar(reparsed, { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') }).instances;
    const statusOf = (i: (typeof instances)[number]): string => getProperty(i.component, 'STATUS')?.value ?? 'CONFIRMED';
    expect(instances.map((i) => [new Date(i.start).toISOString(), statusOf(i)])).toEqual([
      ['2026-09-07T15:00:00.000Z', 'CONFIRMED'],
      ['2026-09-21T17:00:00.000Z', 'CANCELLED'],
    ]);
  });

  it('DEFECT 2: an override stored with a UTC RECURRENCE-ID matches a CANCEL naming the same instant with a TZID', () => {
    const out = withCancelled(nyCal(), { value: '20260914T110000', params: { TZID: ['America/New_York'] } });
    expect(nyStatus(out)).toEqual(['CONFIRMED', 'CANCELLED']);
    expect(isCancelled(out)).toBe(false);

    // The other three occurrences expand CONFIRMED; the cancelled one is still produced (as
    // CalDAV expand does) but carries STATUS:CANCELLED — never silently dropped, never mistaken
    // for a master EXDATE.
    const reparsed = parseICalendar(serializeICalendar(out));
    const instances = expandCalendar(reparsed, { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-10-31T00:00:00Z') }).instances;
    const statusOf = (i: (typeof instances)[number]): string => getProperty(i.component, 'STATUS')?.value ?? 'CONFIRMED';
    const cancelledOnes = instances.filter((i) => statusOf(i) === 'CANCELLED');
    const confirmedOnes = instances.filter((i) => statusOf(i) === 'CONFIRMED');
    expect(cancelledOnes).toHaveLength(1);
    expect(new Date(cancelledOnes[0]?.start ?? 0).toISOString()).toBe('2026-09-14T17:00:00.000Z');
    expect(confirmedOnes).toHaveLength(3);
    const master = out.components.find((x) => x.name === 'VEVENT' && !x.properties.some((p) => p.name === 'RECURRENCE-ID'));
    expect(master?.properties.some((p) => p.name === 'EXDATE')).toBe(false);
  });

  it('a VALUE=DATE all-day RECURRENCE-ID cancels only that day, and RANGE=THISANDFUTURE truncates with a DATE UNTIL', () => {
    const single = withCancelled(allDayCal(), { value: '20260908', params: { VALUE: ['DATE'] } });
    const singleMaster = single.components.find((x) => x.name === 'VEVENT');
    expect(singleMaster?.properties.filter((p) => p.name === 'EXDATE').map((p) => p.value)).toEqual(['20260908']);
    const singleStarts = expandCalendar(parseICalendar(serializeICalendar(single)), { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-30T00:00:00Z') }).instances;
    expect(singleStarts).toHaveLength(3);

    const range = withCancelled(allDayCal(), { value: '20260909', params: { VALUE: ['DATE'], RANGE: ['THISANDFUTURE'] } });
    const rangeMaster = range.components.find((x) => x.name === 'VEVENT');
    const rrule = rangeMaster?.properties.find((p) => p.name === 'RRULE')?.value ?? '';
    expect(rrule).toContain('UNTIL=20260908');
    expect(rrule).not.toContain('COUNT=');
    const rangeStarts = expandCalendar(parseICalendar(serializeICalendar(range)), { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-09-30T00:00:00Z') }).instances;
    expect(rangeStarts).toHaveLength(2); // 09-07 and 09-08 only
  });

  it('a TZID master: RANGE=THISANDFUTURE truncates the RRULE in UTC, not the master’s local zone', () => {
    const out = withCancelled(nyCal(), { value: '20260914T110000', params: { TZID: ['America/New_York'], RANGE: ['THISANDFUTURE'] } });
    const master = out.components.find((x) => x.name === 'VEVENT' && !x.properties.some((p) => p.name === 'RECURRENCE-ID'));
    const rrule = master?.properties.find((p) => p.name === 'RRULE')?.value ?? '';
    // 20260914T110000 America/New_York (EDT, UTC-4) is 20260914T150000Z; just before it is 14:59:59Z.
    expect(rrule).toContain('UNTIL=20260914T145959Z');
    expect(nyStatus(out)).toEqual(['CONFIRMED', 'CANCELLED']);
  });
});

describe('withCancelled: THISANDFUTURE edges (PST-T-8.9)', () => {
  const range = (value: string) => ({ value, params: { RANGE: ['THISANDFUTURE'] } });
  const live = (c: Component): string[] =>
    expandCalendar(parseICalendar(serializeICalendar(c)), { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2026-12-31T00:00:00Z') })
      .instances.filter((i) => (i.component.properties.find((p) => p.name === 'STATUS')?.value ?? 'CONFIRMED') !== 'CANCELLED')
      .map((i) => new Date(i.start).toISOString());

  it('from the first occurrence cancels the whole series, master included', () => {
    const out = withCancelled(cal(), range('20260907T150000Z'));
    expect(isCancelled(out)).toBe(true);
    expect(status(out).every((s) => s === 'CANCELLED')).toBe(true);
    expect(live(out)).toEqual([]);
  });

  it('removes RDATE occurrences at or after the cut, keeping earlier ones', () => {
    const withRdates = parseICalendar(SERIES.replace('RRULE:FREQ=WEEKLY;COUNT=4', 'RRULE:FREQ=WEEKLY;COUNT=4\r\nRDATE:20260910T150000Z,20261015T150000Z'));
    const out = withCancelled(withRdates, range('20260914T150000Z'));
    const starts = live(out);
    expect(starts).toContain('2026-09-10T15:00:00.000Z');
    expect(starts.filter((s) => s >= '2026-09-14')).toEqual([]);
  });
});
