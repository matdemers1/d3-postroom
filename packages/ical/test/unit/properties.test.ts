// fast-check properties (PST-T-8.1 doneWhen, PST-REQ-088): round-trip; folding/unfolding identity;
// expansion always sorted, unique, within range and within the cap; COUNT honoured exactly; and
// nothing but the package's documented error classes ever escapes.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  expandCalendar,
  fold,
  formatDateValue,
  ICalError,
  occurrences,
  parseDuration,
  parseICalendar,
  parseICalendarAll,
  parsePeriod,
  parseRecur,
  parseUtcOffset,
  serializeICalendar,
  unfold,
  utf8Length,
  WEEKDAYS,
  type Component,
  type ICalDateValue,
} from '../../src/index.js';

const RUNS = Number(process.env.FC_RUNS ?? 300);
vi.setConfig({ testTimeout: 120_000 });
const fixtures = join(import.meta.dirname, '..', 'fixtures');
const fixtureLines = readdirSync(fixtures)
  .filter((f) => f.endsWith('.ics'))
  .flatMap((f) => readFileSync(join(fixtures, f), 'utf8').split(/\r\n|\n/))
  .filter((l) => l !== '');

/** Run `f`; any throw that is not an ICalError fails the property. Returns undefined on ICalError. */
function tolerant<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (err) {
    if (err instanceof ICalError) return undefined;
    throw err;
  }
}

// ---- generators -------------------------------------------------------------------------------

const nameArb = fc.stringMatching(/^[A-Z][A-Z0-9-]{0,11}$/).filter((n) => n !== 'BEGIN' && n !== 'END');
const noBreak = (s: string): boolean => !/[\r\n]/.test(s);
const textArb = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.string({ unit: 'grapheme', maxLength: 60 }),
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.constantFrom('a,b;c\\d', '"quoted"', '^n^^^\'', 'mailto:x@example.com', '🏃‍♀️ café', ' leading', 'trailing '),
);
const valueArb = textArb.filter(noBreak);
const paramValueArb = textArb.filter((s) => !s.includes('\r'));
const paramsArb = fc.dictionary(nameArb, fc.array(paramValueArb, { minLength: 1, maxLength: 3 }), { maxKeys: 3 });
const propertyArb = fc.record({ name: nameArb, params: paramsArb, value: valueArb });
const componentArb: fc.Arbitrary<Component> = fc.letrec<{ comp: Component }>((tie) => ({
  comp: fc.record({
    name: fc.oneof(fc.constantFrom('VCALENDAR', 'VEVENT', 'VTODO', 'VALARM', 'VTIMEZONE', 'STANDARD'), nameArb),
    properties: fc.array(propertyArb, { maxLength: 5 }),
    components: fc.oneof({ depthSize: 'small', withCrossShrink: true }, fc.constant<Component[]>([]), fc.array(tie('comp'), { maxLength: 3 })),
  }),
})).comp;

/** Text that looks like iCalendar: fixture lines, fragments and noise joined by assorted breaks. */
const icsLikeArb = fc
  .array(
    fc.oneof(
      { weight: 5, arbitrary: fc.constantFrom(...fixtureLines) },
      { weight: 2, arbitrary: fc.constantFrom('BEGIN:VCALENDAR', 'END:VCALENDAR', 'BEGIN:VEVENT', 'END:VEVENT', 'RRULE:FREQ=SECONDLY', 'EXDATE:19970101', 'RDATE;VALUE=PERIOD:19970101T000000Z/PT1H', 'DTSTART;TZID=Nowhere/Zone:20260101T000000', ' ', '\t', ';', ':', '"', '^') },
      { weight: 1, arbitrary: fc.string({ maxLength: 30 }) },
    ),
    { maxLength: 80 },
  )
  .chain((parts) => fc.array(fc.constantFrom('\r\n', '\n', '\r', '\r\n ', ''), { minLength: parts.length, maxLength: parts.length }).map((seps) => parts.map((p, i) => p + (seps[i] ?? '')).join('')));

/** A BYxxx list, empty two times in three so that most generated rules still produce instances. */
const byList = (min: number, max: number, zero = false): fc.Arbitrary<number[]> =>
  fc.oneof(
    { weight: 2, arbitrary: fc.constant<number[]>([]) },
    { weight: 1, arbitrary: fc.array(fc.integer({ min, max }).filter((n) => zero || n !== 0), { minLength: 1, maxLength: 4 }) },
  );

const freqArb = fc.constantFrom('SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY');

const rruleArb = fc
  .record({
    freq: freqArb,
    interval: fc.integer({ min: 1, max: 5 }),
    end: fc.oneof(
      fc.constant(''),
      fc.integer({ min: 1, max: 40 }).map((n) => `;COUNT=${String(n)}`),
      fc.date({ min: new Date('1995-01-01T00:00:00Z'), max: new Date('2035-01-01T00:00:00Z'), noInvalidDate: true }).map((d) => `;UNTIL=${d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`),
    ),
    bySecond: byList(0, 60, true),
    byMinute: byList(0, 59, true),
    byHour: byList(0, 23, true),
    byDay: fc.oneof(
      { weight: 2, arbitrary: fc.constant<[number, string][]>([]) },
      { weight: 1, arbitrary: fc.array(fc.tuple(fc.integer({ min: -5, max: 5 }), fc.constantFrom<string>(...WEEKDAYS)), { minLength: 1, maxLength: 3 }) },
    ),
    byMonthDay: byList(-31, 31),
    byYearDay: fc.oneof({ weight: 4, arbitrary: fc.constant<number[]>([]) }, { weight: 1, arbitrary: byList(-366, 366) }),
    byWeekNo: fc.oneof({ weight: 4, arbitrary: fc.constant<number[]>([]) }, { weight: 1, arbitrary: byList(-53, 53) }),
    byMonth: byList(1, 12),
    bySetPos: fc.oneof({ weight: 3, arbitrary: fc.constant<number[]>([]) }, { weight: 1, arbitrary: byList(-10, 10) }),
    wkst: fc.constantFrom(...WEEKDAYS),
  })
  .map((r) => {
    let s = `FREQ=${r.freq};INTERVAL=${String(r.interval)}${r.end};WKST=${r.wkst}`;
    const add = (k: string, xs: (number | string)[]): void => {
      if (xs.length > 0) s += `;${k}=${xs.join(',')}`;
    };
    add('BYSECOND', r.bySecond);
    add('BYMINUTE', r.byMinute);
    add('BYHOUR', r.byHour);
    add('BYDAY', r.byDay.map(([n, d]) => `${n === 0 ? '' : String(n)}${d}`));
    add('BYMONTHDAY', r.byMonthDay);
    add('BYYEARDAY', r.byYearDay);
    add('BYWEEKNO', r.byWeekNo);
    add('BYMONTH', r.byMonth);
    add('BYSETPOS', r.bySetPos);
    return s;
  });

const localStamp = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
const dtstartArb = fc
  .tuple(
    fc.date({ min: new Date('1995-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z'), noInvalidDate: true }),
    fc.constantFrom('utc', 'floating', 'tzid', 'date'),
  )
  .map(([d, form]) => {
    const t = localStamp(d);
    if (form === 'utc') return `DTSTART:${t}Z`;
    if (form === 'floating') return `DTSTART:${t}`;
    if (form === 'tzid') return `DTSTART;TZID=America/New_York:${t}`;
    return `DTSTART;VALUE=DATE:${t.slice(0, 8)}`;
  });

const rangeArb = fc
  .tuple(fc.date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2035-01-01T00:00:00Z'), noInvalidDate: true }), fc.integer({ min: 0, max: 3 * 365 * 86_400_000 }))
  .map(([s, len]) => ({ start: s.getTime(), end: s.getTime() + len }));

function eventCalendar(dtstart: string, rrule: string, extra: string[] = []): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:prop@example.com', dtstart, 'DURATION:PT1H', `RRULE:${rrule}`, ...extra, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

// ---- properties -------------------------------------------------------------------------------

describe('round-trip', () => {
  it('parse(serialize(tree)) deep-equals the tree', () => {
    fc.assert(
      fc.property(componentArb, (tree) => {
        const text = serializeICalendar(tree);
        expect(parseICalendar(text, { maxDepth: 64 })).toEqual(tree);
      }),
      { numRuns: RUNS },
    );
  });

  it('parse(serialize(parse(x))) deep-equals parse(x) for any x that parses', () => {
    fc.assert(
      fc.property(icsLikeArb, (x) => {
        const once = tolerant(() => parseICalendarAll(x));
        if (once === undefined) return;
        expect(parseICalendarAll(serializeICalendar(once))).toEqual(once);
      }),
      { numRuns: RUNS * 3 },
    );
  });
});

describe('folding', () => {
  it('unfold(fold(line)) is the identity and no physical line exceeds 75 octets', () => {
    fc.assert(
      fc.property(nameArb, fc.oneof(fc.string({ maxLength: 400 }), fc.string({ unit: 'grapheme', maxLength: 200 }), fc.string({ unit: 'binary', maxLength: 200 })).filter(noBreak), (name, value) => {
        const line = `${name}:${value}`;
        const folded = fold(line);
        for (const physical of folded.split('\r\n')) expect(utf8Length(physical)).toBeLessThanOrEqual(75);
        expect(unfold(folded).map((l) => l.text)).toEqual([line]);
        // Never splits a surrogate pair across physical lines.
        expect(/[\uD800-\uDBFF]\r\n [\uDC00-\uDFFF]/.test(folded)).toBe(false);
      }),
      { numRuns: RUNS * 2 },
    );
  });
});

describe('expansion', () => {
  it('is always sorted, unique, within the range and within the cap', () => {
    fc.assert(
      fc.property(dtstartArb, rruleArb, rangeArb, fc.integer({ min: 1, max: 150 }), fc.boolean(), (dtstart, rrule, range, maxInstances, withExtras) => {
        const extra = withExtras ? ['EXDATE:20000101T000000Z,20260101', 'RDATE:20260315T120000Z,20260101T000000Z'] : [];
        const cal = parseICalendar(eventCalendar(dtstart, rrule, extra));
        const r = tolerant(() => expandCalendar(cal, { ...range, maxInstances, maxIterations: 20_000 }));
        if (r === undefined) return;
        expect(r.instances.length).toBeLessThanOrEqual(maxInstances);
        const keys = new Set<string>();
        let prev = Number.NEGATIVE_INFINITY;
        for (const i of r.instances) {
          expect(i.start).toBeGreaterThanOrEqual(prev);
          prev = i.start;
          expect(i.end).toBeGreaterThanOrEqual(i.start);
          const inRange = i.end > i.start ? i.start < range.end && i.end > range.start : i.start >= range.start && i.start < range.end;
          expect(inRange).toBe(true);
          const k = `${i.uid ?? ''}|${i.recurrenceId}`;
          expect(keys.has(k)).toBe(false);
          keys.add(k);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('matches the naive sequence: skipping ahead to the range never loses or invents an instance', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('1995-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z'), noInvalidDate: true }),
        rruleArb,
        fc.integer({ min: -30 * 86_400_000, max: 2 * 365 * 86_400_000 }),
        fc.integer({ min: 0, max: 400 * 86_400_000 }),
        (d, rrule, offset, length) => {
        // The range sits near DTSTART, so most rules have instances in it.
        const range = { start: d.getTime() + offset, end: d.getTime() + offset + length };
        const t = localStamp(d);
        const cal = parseICalendar(eventCalendar(`DTSTART:${t}Z`, rrule));
        const fast = tolerant(() => expandCalendar(cal, { ...range, maxInstances: 20_000, maxIterations: 40_000 }));
        // The naive run walks from DTSTART with no skipping, and stops at the range end.
        const endParts = partsOf(new Date(range.end + 3_600_000));
        const slow = tolerant(() =>
          occurrences({ type: 'date-time', ...partsOf(d), utc: true, tzid: null }, rrule, {
            maxInstances: 20_000,
            maxIterations: 40_000,
            before: { type: 'date-time', ...endParts, utc: true, tzid: null },
          }),
        );
        if (fast === undefined || slow === undefined || fast.truncated || slow.stoppedBy === 'cap' || slow.stoppedBy === 'max') return;
        const hour = 3_600_000;
        const expected = slow.values
          .map((v) => Date.UTC(v.year, v.month - 1, v.day, v.type === 'date-time' ? v.hour : 0, v.type === 'date-time' ? v.minute : 0, v.type === 'date-time' ? v.second : 0))
          .filter((s) => s < range.end && s + hour > range.start);
        expect(fast.instances.map((i) => i.start)).toEqual(expected);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('honours COUNT exactly: a productive rule yields exactly COUNT instances, DTSTART first', () => {
    const productive = fc
      .record({
        freq: freqArb,
        interval: fc.integer({ min: 1, max: 4 }),
        count: fc.integer({ min: 1, max: 30 }),
        byDay: fc.uniqueArray(fc.constantFrom(...WEEKDAYS), { maxLength: 3 }),
      })
      .map((r) => ({
        count: r.count,
        rule: `FREQ=${r.freq};INTERVAL=${String(r.interval)};COUNT=${String(r.count)}${r.byDay.length > 0 && (r.freq === 'WEEKLY' || r.freq === 'DAILY') ? `;BYDAY=${r.byDay.join(',')}` : ''}`,
      }));
    fc.assert(
      fc.property(dtstartArb, productive, (dtstart, { count, rule }) => {
        const cal = parseICalendar(eventCalendar(dtstart, rule));
        // The range covers every instance (YEARLY;INTERVAL=4;COUNT=30 from 2030 ends in 2146).
        const r = expandCalendar(cal, { start: Date.UTC(1990, 0, 1), end: Date.UTC(2300, 0, 1), maxInstances: 1000, maxIterations: 2_000_000 });
        expect(r.truncated).toBe(false);
        expect(r.instances).toHaveLength(count);
        const first = r.instances[0];
        const master = cal.components[0];
        expect(first?.component).toBe(master);
        expect(first?.recurrenceId).toBe(dtstart.slice(dtstart.lastIndexOf(':') + 1));
      }),
      { numRuns: RUNS },
    );
  });

  it('occurrences() never exceeds COUNT, and reports "count" exactly when it produced COUNT', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('1995-01-01T00:00:00Z'), max: new Date('2030-12-31T00:00:00Z'), noInvalidDate: true }), rruleArb, fc.integer({ min: 1, max: 25 }), (d, rrule, n) => {
        const rule = `${rrule.replace(/;(COUNT|UNTIL)=[^;]*/g, '')};COUNT=${String(n)}`;
        const dt: ICalDateValue = { type: 'date-time', ...partsOf(d), utc: true, tzid: null };
        const got = tolerant(() => occurrences(dt, rule, { maxIterations: 50_000 }));
        if (got === undefined) return;
        expect(got.values.length).toBeLessThanOrEqual(n);
        expect(got.stoppedBy === 'count').toBe(got.values.length === n);
        const s = got.values.map(formatDateValue);
        expect([...s].sort()).toEqual(s);
        expect(new Set(s).size).toBe(s.length);
      }),
      { numRuns: RUNS },
    );
  });
});

function partsOf(d: Date): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
}

describe('never throws anything but ICalError', () => {
  it('parsing arbitrary text and bytes, then expanding whatever parsed', () => {
    fc.assert(
      fc.property(fc.oneof(icsLikeArb, fc.string({ maxLength: 300 }), fc.uint8Array({ maxLength: 300 })), rangeArb, (input, range) => {
        const roots = tolerant(() => parseICalendarAll(input));
        for (const root of roots ?? []) tolerant(() => expandCalendar(root, { ...range, maxInstances: 50, maxIterations: 5000 }));
      }),
      { numRuns: RUNS * 3 },
    );
  });

  it('the value parsers on arbitrary strings', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 60 }), rruleArb, fc.constantFrom('P1W', 'PT0S', '-0500', '19970101T000000Z/PT1H')), (s) => {
        tolerant(() => parseRecur(s));
        tolerant(() => parseDuration(s));
        tolerant(() => parsePeriod(s));
        tolerant(() => parseUtcOffset(s));
      }),
      { numRuns: RUNS * 2 },
    );
  });
});
