// DST edge cases (PST-T-8.1 follow-up): DTSTART/DTEND in the spring-forward gap and at the
// ambiguous fall-back hour, for single and recurring events, with DTEND and with DURATION, under
// both the embedded VTIMEZONE and the host IANA database.
//
// RFC 5545 §3.3.5: a nonexistent local time takes the UTC offset from before the gap (02:30 on
// 8 March 2026 is 02:30 EST = 07:30Z, shown as 03:30 EDT); an ambiguous one is its first
// occurrence (01:30 on 1 November 2026 is 01:30 EDT = 05:30Z). §3.8.5.3: a DTEND gives every
// instance the same exact duration, and a DURATION the same nominal duration.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createTimeZoneResolver, expandCalendar, parseICalendar, type TimeZoneResolver } from '../../src/index.js';

const cal = parseICalendar(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'dst-gap-overlap.ics'), 'utf8'));
const iso = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace('.000', '');

const resolvers: [string, TimeZoneResolver | undefined][] = [
  ['embedded VTIMEZONE', undefined],
  ['Intl (IANA)', createTimeZoneResolver(null)],
];

for (const [label, timezones] of resolvers) {
  describe(`DST gap and overlap — ${label}`, () => {
    const r = expandCalendar(cal, { start: Date.UTC(2026, 0, 1), end: Date.UTC(2027, 0, 1), ...(timezones ? { timezones } : {}) });
    const of = (uid: string): [string, string, string][] =>
      r.instances.filter((i) => i.uid === uid).map((i) => [i.recurrenceId, iso(i.start), iso(i.end)]);

    it('a single event starting in the gap keeps its hour (DTEND)', () => {
      expect(of('gap-single-dtend@example.com')).toEqual([['20260308T023000', '20260308T073000Z', '20260308T083000Z']]);
    });
    it('a single event starting in the gap keeps its hour (DURATION)', () => {
      expect(of('gap-single-duration@example.com')).toEqual([['20260308T023000', '20260308T073000Z', '20260308T083000Z']]);
    });
    it('a single event ending in the gap keeps its hour', () => {
      expect(of('gap-end-dtend@example.com')).toEqual([['20260308T013000', '20260308T063000Z', '20260308T073000Z']]);
    });
    for (const kind of ['dtend', 'duration']) {
      it(`a daily event whose instance lands in the gap keeps an hour on every day (${kind.toUpperCase()})`, () => {
        expect(of(`gap-daily-${kind}@example.com`)).toEqual([
          ['20260306T023000', '20260306T073000Z', '20260306T083000Z'], // EST
          ['20260307T023000', '20260307T073000Z', '20260307T083000Z'], // EST
          ['20260308T023000', '20260308T073000Z', '20260308T083000Z'], // in the gap: EST offset, i.e. 03:30 EDT
          ['20260309T023000', '20260309T063000Z', '20260309T073000Z'], // EDT
          ['20260310T023000', '20260310T063000Z', '20260310T073000Z'], // EDT
        ]);
      });
    }
    it('a single event at the ambiguous 01:30 starts at its first occurrence (EDT); DTEND 02:30 EST is exact', () => {
      // 01:30 EDT = 05:30Z; 02:30 EST = 07:30Z. The exact duration between them is two hours.
      expect(of('overlap-single-dtend@example.com')).toEqual([['20261101T013000', '20261101T053000Z', '20261101T073000Z']]);
    });
    for (const kind of ['dtend', 'duration']) {
      it(`a daily 01:30 event across the fall-back takes the first occurrence and keeps an hour (${kind.toUpperCase()})`, () => {
        expect(of(`overlap-daily-${kind}@example.com`)).toEqual([
          ['20261030T013000', '20261030T053000Z', '20261030T063000Z'], // EDT
          ['20261031T013000', '20261031T053000Z', '20261031T063000Z'], // EDT
          ['20261101T013000', '20261101T053000Z', '20261101T063000Z'], // ambiguous: first occurrence, EDT
          ['20261102T013000', '20261102T063000Z', '20261102T073000Z'], // EST
        ]);
      });
    }
    it('no instance ever collapses to zero length', () => {
      expect(r.instances.every((i) => i.end > i.start)).toBe(true);
    });
  });
}

// Local midnight (as UTC ms) of each zone's 2026 spring and autumn transition days.
const TRANSITION_DAYS: Record<string, [number, number]> = {
  'America/New_York': [Date.UTC(2026, 2, 8), Date.UTC(2026, 10, 1)],
  'America/St_Johns': [Date.UTC(2026, 2, 8), Date.UTC(2026, 10, 1)],
  'Europe/Berlin': [Date.UTC(2026, 2, 29), Date.UTC(2026, 9, 25)],
  'Australia/Sydney': [Date.UTC(2026, 9, 4), Date.UTC(2026, 3, 5)],
};

describe('property: a positive wall-clock DTEND never yields a zero-length instance', () => {
  it('holds for every start minute and length, in DST-observing zones', () => {
    const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
    fc.assert(
      fc.property(
        fc.constantFrom(...Object.keys(TRANSITION_DAYS)),
        fc.oneof(
          // Half the time: the first five hours of a 2026 transition day, where gaps and overlaps live.
          fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 5 * 60 - 1 })).map(([second, m]) => ({ day: second ? 1 : 0, m })),
          fc.integer({ min: 0, max: 365 * 24 * 60 - 1 }).map((m) => ({ day: -1, m })),
        ),
        fc.oneof(fc.constantFrom(30, 60, 90, 120), fc.integer({ min: 1, max: 6 * 60 })),
        fc.boolean(),
        (tzid, at, length, recurring) => {
          const days = TRANSITION_DAYS[tzid] ?? [0, 0];
          const startLocal = at.day < 0 ? Date.UTC(2026, 0, 1) + at.m * 60_000 : (days[at.day] ?? 0) + at.m * 60_000;
          const ics = [
            'BEGIN:VCALENDAR',
            'BEGIN:VEVENT',
            'UID:p@example.com',
            `DTSTART;TZID=${tzid}:${stamp(startLocal)}`,
            `DTEND;TZID=${tzid}:${stamp(startLocal + length * 60_000)}`,
            ...(recurring ? ['RRULE:FREQ=DAILY;COUNT=3'] : []),
            'END:VEVENT',
            'END:VCALENDAR',
            '',
          ].join('\r\n');
          const r = expandCalendar(parseICalendar(ics), { start: Date.UTC(2025, 11, 1), end: Date.UTC(2027, 1, 1) });
          expect(r.instances.length).toBe(recurring ? 3 : 1);
          for (const i of r.instances) expect(i.end).toBeGreaterThan(i.start);
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 300) },
    );
  });
});
