// RFC 5545 §3.8.5.3 and §3.6.1 recurrence examples, the §3.6.5 America/New_York VTIMEZONE, and
// the synthetic Apple/Google/Outlook exports (PST-T-8.1 doneWhen).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createTimeZoneResolver,
  expandCalendar,
  formatDateValue,
  occurrences,
  parseDateTime,
  parseICalendar,
  type Instance,
} from '../../src/index.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const read = (f: string): string => readFileSync(join(fixtures, f), 'utf8');

interface RfcExample {
  name: string;
  dtstart: string;
  rrule: string;
  expected: string[];
  take?: number;
  exdate?: string[];
}
const rfc = JSON.parse(read('rfc5545-3.8.5.3-recurrence.json')) as { examples: RfcExample[] };

const iso = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace('.000', '');
const ms = (s: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(s);
  if (m === null) throw new Error(`bad test date ${s}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
};

describe('RFC 5545 §3.8.5.3 recurrence examples', () => {
  it('has every example transcribed', () => {
    expect(rfc.examples.length).toBeGreaterThanOrEqual(40);
  });

  for (const ex of rfc.examples) {
    it(`occurrences(): ${ex.name}`, () => {
      const dtstart = parseDateTime(ex.dtstart);
      const got = occurrences(dtstart, ex.rrule, { maxInstances: (ex.take ?? 10_000) + (ex.exdate?.length ?? 0) });
      let values = got.values.map(formatDateValue);
      if (ex.exdate) values = values.filter((v) => !ex.exdate?.includes(v));
      expect(values.slice(0, ex.expected.length)).toEqual(ex.expected);
      if (ex.take === undefined) {
        // A bounded rule (COUNT or UNTIL) must produce exactly the documented list and stop.
        expect(values).toEqual(ex.expected);
        expect(['count', 'until']).toContain(got.stoppedBy);
      }
    });

    it(`expandCalendar(): ${ex.name}`, () => {
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:rfc@example.com',
        `DTSTART:${ex.dtstart}`,
        `RRULE:${ex.rrule}`,
        ...(ex.exdate ? [`EXDATE:${ex.exdate.join(',')}`] : []),
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n');
      const cal = parseICalendar(ics);
      const result = expandCalendar(cal, {
        start: ms(ex.dtstart),
        end: Date.UTC(2010, 0, 1),
        maxInstances: ex.take ?? 10_000,
      });
      expect(result.instances.map((i) => i.recurrenceId)).toEqual(ex.expected);
      expect(result.truncated).toBe(ex.take !== undefined);
    });
  }
});

describe('RFC 5545 §3.6.1 VEVENT examples', () => {
  const cal = parseICalendar(read('rfc5545-3.6.1-events.ics'));
  it('expands the yearly all-day anniversary', () => {
    const r = expandCalendar(cal, { start: Date.UTC(1997, 0, 1), end: Date.UTC(2001, 0, 1) });
    const anniversary = r.instances.filter((i) => i.uid === '19970901T130000Z-123403@example.com');
    expect(anniversary.map((i) => i.recurrenceId)).toEqual(['19971102', '19981102', '19991102', '20001102']);
    expect(anniversary.every((i) => i.allDay && i.end - i.start === 86_400_000)).toBe(true);
  });
  it('keeps timed and multi-day events as single instances with their DTEND', () => {
    const r = expandCalendar(cal, { start: Date.UTC(1997, 0, 1), end: Date.UTC(2008, 0, 1) });
    const byUid = (uid: string): Instance[] => r.instances.filter((i) => i.uid === uid);
    const review = byUid('19970901T130000Z-123401@example.com');
    expect(review.map((i) => [iso(i.start), iso(i.end)])).toEqual([['19970903T163000Z', '19970903T190000Z']]);
    const laurel = byUid('19970901T130000Z-123402@example.com');
    expect(laurel.map((i) => [iso(i.start), iso(i.end)])).toEqual([['19970401T163000Z', '19970402T010000Z']]);
    const jazz = byUid('20070423T123432Z-541111@example.com');
    expect(jazz).toHaveLength(1);
    expect((jazz[0]?.end ?? 0) - (jazz[0]?.start ?? 0)).toBe(11 * 86_400_000);
  });
  it('finds an instance that started before the range but overlaps it', () => {
    const r = expandCalendar(cal, { start: Date.UTC(2007, 6, 1), end: Date.UTC(2007, 6, 2) });
    expect(r.instances.map((i) => i.uid)).toEqual(['20070423T123432Z-541111@example.com']);
  });
});

describe('RFC 5545 §3.6.5 America/New_York VTIMEZONE', () => {
  const cal = parseICalendar(read('rfc5545-3.6.5-new-york.ics'));
  it('crosses the 1997 fall-back with 09:00 local on both sides (EDT → EST)', () => {
    const r = expandCalendar(cal, { start: Date.UTC(1997, 0, 1), end: Date.UTC(1998, 0, 1) });
    expect(r.truncated).toBe(false);
    expect(r.instances).toHaveLength(113);
    const utc = r.instances.map((i) => iso(i.start));
    expect(utc[0]).toBe('19970902T130000Z');
    expect(utc).toContain('19971025T130000Z');
    expect(utc).toContain('19971026T140000Z');
    expect(utc[utc.length - 1]).toBe('19971223T140000Z');
    expect(r.instances.every((i) => i.end - i.start === 3_600_000)).toBe(true);
    expect(r.instances[0]?.recurrenceId).toBe('19970902T090000');
  });
  it('agrees with the host IANA database for 2026 transitions', () => {
    const vtz = createTimeZoneResolver(cal, { intl: false });
    const intl = createTimeZoneResolver(null);
    for (const t of [Date.UTC(2026, 2, 8, 6, 59), Date.UTC(2026, 2, 8, 7, 0), Date.UTC(2026, 10, 1, 5, 59), Date.UTC(2026, 10, 1, 6, 0), Date.UTC(2026, 6, 4)]) {
      expect(vtz.offsetAt('America/New_York', t / 1000)).toBe(intl.offsetAt('America/New_York', t / 1000));
    }
  });
  it('resolves a local time in the spring-forward gap with the offset before it, and an overlap to its first instant', () => {
    const tz = createTimeZoneResolver(cal, { intl: false });
    const gap = firstStartUtc('America/New_York', '20070311T023000', tz);
    expect(gap).toBe('20070311T073000Z');
    const overlap = firstStartUtc('America/New_York', '20071104T013000', tz);
    expect(overlap).toBe('20071104T053000Z');
  });
});

function firstStartUtc(tzid: string, local: string, tz: ReturnType<typeof createTimeZoneResolver>): string {
  const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;TZID=${tzid}:${local}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const r = expandCalendar(parseICalendar(ics), { start: 0, end: Date.UTC(3000, 0, 1), timezones: tz });
  return iso(r.instances[0]?.start ?? 0);
}

describe('exported calendars (synthetic Apple / Google / Outlook samples)', () => {
  it('Apple: weekly run with an EXDATE and a moved instance, across the DST change', () => {
    const cal = parseICalendar(read('apple-calendar-export.ics'));
    const r = expandCalendar(cal, { start: Date.UTC(2026, 2, 1), end: Date.UTC(2026, 3, 1) });
    const runs = r.instances.filter((i) => i.uid === '3F1C7A0E-5B7D-4E3A-9C1B-2A6D8E4F0A11');
    expect(runs.map((i) => [i.recurrenceId, iso(i.start), i.override])).toEqual([
      ['20260302T083000', '20260302T163000Z', false], // PST, UTC-8
      ['20260309T083000', '20260309T153000Z', false], // PDT from 8 March, UTC-7
      // 16 March is an EXDATE; 23 March moved to Tuesday 09:00.
      ['20260323T083000', '20260324T160000Z', true],
      ['20260330T083000', '20260330T153000Z', false],
    ]);
    expect(runs.every((i) => i.end - i.start === 3_600_000)).toBe(true);
  });
  it('Apple: yearly all-day birthday', () => {
    const cal = parseICalendar(read('apple-calendar-export.ics'));
    const r = expandCalendar(cal, { start: Date.UTC(2026, 0, 1), end: Date.UTC(2029, 0, 1) });
    expect(r.instances.filter((i) => i.allDay).map((i) => i.recurrenceId)).toEqual(['20260415', '20270415', '20280415']);
  });
  it('Google: MO/WE/FR stand-up, override moved across the CEST change, UNTIL honoured', () => {
    const cal = parseICalendar(read('google-calendar-export.ics'));
    const r = expandCalendar(cal, { start: Date.UTC(2026, 2, 23), end: Date.UTC(2026, 4, 1) });
    const standups = r.instances.filter((i) => i.uid === '0a1b2c3d4e5f6g7h8i9j@google.com');
    expect(standups[0] && iso(standups[0].start)).toBe('20260323T090000Z'); // CET, UTC+1
    const moved = standups.find((i) => i.override);
    expect(moved && [moved.recurrenceId, iso(moved.start)]).toEqual(['20260330T100000', '20260330T093000Z']);
    const wed = standups.find((i) => i.recurrenceId === '20260401T100000');
    expect(wed && iso(wed.start)).toBe('20260401T080000Z'); // CEST, UTC+2
    expect(standups[standups.length - 1]?.recurrenceId).toBe('20260429T100000');
    const monthly = r.instances.filter((i) => i.uid === 'monthly-review-000000@google.com').map((i) => i.recurrenceId);
    expect(monthly).toEqual(['20260401']);
  });
  it('Outlook: Windows TZID with 1601 rules, BYSETPOS=-1 quarterly for 4', () => {
    const cal = parseICalendar(read('outlook-export.ics'));
    const r = expandCalendar(cal, { start: Date.UTC(2026, 0, 1), end: Date.UTC(2028, 0, 1) });
    expect(r.instances.map((i) => [i.recurrenceId, iso(i.start)])).toEqual([
      ['20260129T140000', '20260129T190000Z'],
      ['20260430T140000', '20260430T180000Z'],
      ['20260730T140000', '20260730T180000Z'],
      ['20261029T140000', '20261029T180000Z'],
    ]);
  });
});

describe('bounds', () => {
  const cal = (rrule: string, dtstart = '20260101T000000Z'): ReturnType<typeof parseICalendar> =>
    parseICalendar(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:${dtstart}\r\nRRULE:${rrule}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);

  it('caps instances and reports truncation', () => {
    const r = expandCalendar(cal('FREQ=SECONDLY'), { start: Date.UTC(2026, 0, 1), end: Date.UTC(2027, 0, 1), maxInstances: 50 });
    expect(r.instances).toHaveLength(50);
    expect(r.truncated).toBe(true);
  });
  it('caps iterations on a rule that never matches', () => {
    const r = expandCalendar(cal('FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30'), { start: Date.UTC(2026, 0, 1), end: Date.UTC(2100, 0, 1), maxIterations: 5000 });
    expect(r.instances).toHaveLength(1); // DTSTART only
    expect(r.truncated).toBe(true);
  });
  it('stops a never-matching YEARLY rule at year 9999 without a cap', () => {
    const got = occurrences(parseDateTime('20260101T000000'), 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', { maxIterations: 1_000_000 });
    expect(got.values).toHaveLength(1);
    expect(got.stoppedBy).toBe('exhausted');
  });
  it('skips ahead to a far range cheaply when there is no COUNT', () => {
    // 126 years of minutes is 66 million periods; only the few days around the range are walked.
    const r = expandCalendar(cal('FREQ=MINUTELY', '19000101T000000Z'), { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 1, 1), maxIterations: 20_000 });
    expect(r.instances).toHaveLength(60);
    expect(r.truncated).toBe(false);
  });
  it('a dense YEARLY rule with BYSETPOS does not materialise every candidate', () => {
    const r = expandCalendar(cal('FREQ=YEARLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12;BYHOUR=0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23;BYMINUTE=0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59;BYSETPOS=-1;BYMONTHDAY=1,-1'), {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2030, 0, 1),
    });
    expect(r.instances.map((i) => iso(i.start))).toEqual(['20260101T000000Z', '20261231T235900Z', '20271231T235900Z', '20281231T235900Z', '20291231T235900Z']);
  });
});
