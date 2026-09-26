// Content lines, the component tree, typed values and the serializer (RFC 5545 §3.1–§3.6).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  calAddressEmail,
  durationToSeconds,
  fold,
  formatDuration,
  formatRecur,
  formatUtcOffset,
  getComponents,
  getParam,
  getProperties,
  getProperty,
  ICalError,
  ICalLimitError,
  ICalParseError,
  parseContentLine,
  parseDate,
  parseDateTime,
  parseDuration,
  parseICalendar,
  parseICalendarAll,
  parsePeriod,
  parseRecur,
  parseText,
  parseTextList,
  parseUtcOffset,
  propertyDate,
  propertyDateList,
  serializeICalendar,
  unfold,
  utf8Length,
} from '../../src/index.js';

const fixtures = join(import.meta.dirname, '..', 'fixtures');
const icsFiles = readdirSync(fixtures).filter((f) => f.endsWith('.ics'));
const read = (f: string): string => readFileSync(join(fixtures, f), 'utf8');

describe('content lines', () => {
  it('unfolds CRLF + space / tab continuations and accepts bare LF and CR', () => {
    expect(unfold('A:1\r\n 2\r\n\t3\nB:x\rC:y').map((l) => l.text)).toEqual(['A:123', 'B:x', 'C:y']);
  });
  it('folds at 75 octets without splitting a UTF-8 sequence', () => {
    const line = `SUMMARY:${'é🏃'.repeat(40)}`;
    const folded = fold(line);
    for (const physical of folded.split('\r\n')) expect(utf8Length(physical)).toBeLessThanOrEqual(75);
    expect(unfold(folded).map((l) => l.text)).toEqual([line]);
    expect(folded).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it('parses quoted parameters, multi-values and RFC 6868 caret escapes', () => {
    const cl = parseContentLine('ATTENDEE;CN="Doe, Jane";ROLE=REQ-PARTICIPANT;MEMBER="mailto:a@example.com","mailto:b@example.com";X-NOTE=say ^\'hi^\'^nbye:mailto:jane@example.com', 1);
    expect(cl.name).toBe('ATTENDEE');
    expect(cl.params).toEqual({
      CN: ['Doe, Jane'],
      ROLE: ['REQ-PARTICIPANT'],
      MEMBER: ['mailto:a@example.com', 'mailto:b@example.com'],
      'X-NOTE': ['say "hi"\nbye'],
    });
    expect(cl.value).toBe('mailto:jane@example.com');
  });
  it('lower-case names are normalised; the value keeps its colons', () => {
    const cl = parseContentLine('dtstart;tzid=Europe/Berlin:20260101T000000', 1);
    expect(cl.name).toBe('DTSTART');
    expect(cl.params).toEqual({ TZID: ['Europe/Berlin'] });
    expect(parseContentLine('URL:https://example.com:8443/x', 1).value).toBe('https://example.com:8443/x');
  });
  it('rejects malformed lines with ICalParseError', () => {
    for (const bad of ['NOCOLON', ':value', 'A;=x:v', 'A;B:v', 'A;B="x:v', 'A;B="x"y:v', 'A B:v']) {
      expect(() => parseContentLine(bad, 1), bad).toThrow(ICalParseError);
    }
  });
});

describe('component tree', () => {
  it.each(icsFiles)('parses %s', (f) => {
    const cal = parseICalendar(read(f));
    expect(cal.name).toBe('VCALENDAR');
    expect(cal.components.length).toBeGreaterThan(0);
  });

  it.each(icsFiles)('round-trips %s: parse(serialize(parse(x))) deep-equals parse(x)', (f) => {
    const once = parseICalendar(read(f));
    const text = serializeICalendar(once);
    expect(parseICalendar(text)).toEqual(once);
    // And the serializer is a fixed point after one pass.
    expect(serializeICalendar(parseICalendar(text))).toBe(text);
    for (const line of text.split('\r\n')) expect(utf8Length(line)).toBeLessThanOrEqual(75);
  });

  it('builds the VCALENDAR › VTODO › VALARM tree and keeps every component kind', () => {
    const cal = parseICalendar(read('rfc5545-components.ics'));
    expect(cal.components.map((c) => c.name)).toEqual(['VTODO', 'VTODO', 'VJOURNAL', 'VFREEBUSY']);
    const todo = cal.components[1];
    expect(todo && getComponents(todo, 'VALARM')).toHaveLength(1);
    const tz = parseICalendar(read('rfc5545-3.6.5-new-york.ics'));
    const vtz = getComponents(tz, 'VTIMEZONE')[0];
    expect(vtz?.components.map((c) => c.name)).toEqual(['DAYLIGHT', 'STANDARD', 'DAYLIGHT', 'DAYLIGHT', 'DAYLIGHT', 'DAYLIGHT', 'STANDARD']);
  });

  it('decodes TEXT, TEXT lists, CAL-ADDRESS and PERIOD lists from the fixtures', () => {
    const cal = parseICalendar(read('rfc5545-components.ics'));
    const journal = getComponents(cal, 'VJOURNAL')[0];
    const desc = journal && getProperty(journal, 'DESCRIPTION');
    expect(desc && parseText(desc.value)).toMatch(/^1\. Staff meeting: Participants include Joe, Lisa, and Bob\./);
    expect(desc && parseText(desc.value)).toContain('Next meeting on Tuesday.\n2. Telephone Conference');
    const todo = getComponents(cal, 'VTODO')[0];
    const cats = todo && getProperty(todo, 'CATEGORIES');
    expect(cats && parseTextList(cats.value)).toEqual(['FAMILY', 'FINANCE']);
    const fb = getComponents(cal, 'VFREEBUSY')[0];
    const busy = fb && getProperty(fb, 'FREEBUSY');
    const periods = busy ? propertyDateList(busy) : [];
    expect(periods).toHaveLength(3);
    const org = fb && getProperty(fb, 'ORGANIZER');
    expect(org && calAddressEmail(org.value)).toBe('jane_doe@example.com');

    const outlook = parseICalendar(read('outlook-export.ics'));
    const ev = getComponents(outlook, 'VEVENT')[0];
    const organizer = ev && getProperty(ev, 'ORGANIZER');
    expect(organizer && getParam(organizer, 'cn')).toBe('Example, Jordan');
    const uid = ev && getProperty(ev, 'UID');
    expect(uid?.value).toBe('040000008200E00074C5B7101A82E00800000000A0B1C2D3E4F5000000000000000010000000AABBCCDDEEFF00112233445566778899');
    const apple = parseICalendar(read('apple-calendar-export.ics'));
    const run = getComponents(apple, 'VEVENT')[0];
    expect(run && parseText(getProperty(run, 'DESCRIPTION')?.value ?? '')).toBe('Loop around the reservoir — bring water, a jacket; and the new shoes.\nMeet at the north gate.');
    expect(run && getProperties(run, 'EXDATE').map(propertyDateList)).toHaveLength(1);
  });

  it('accepts bytes with a BOM and LF line endings', () => {
    const text = '﻿BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Café\nEND:VEVENT\nEND:VCALENDAR\n';
    const cal = parseICalendar(new TextEncoder().encode(text));
    expect(cal.components[0]?.properties[0]?.value).toBe('Café');
  });

  it('parses several top-level components with parseICalendarAll', () => {
    const one = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
    expect(parseICalendarAll(one + one)).toHaveLength(2);
    expect(() => parseICalendar(one + one)).toThrow(ICalParseError);
    expect(() => parseICalendar('')).toThrow(ICalParseError);
  });

  it('rejects structural errors', () => {
    expect(() => parseICalendar('BEGIN:VCALENDAR\r\n')).toThrow(/never closed/);
    expect(() => parseICalendar('BEGIN:VCALENDAR\r\nEND:VEVENT\r\n')).toThrow(/closes BEGIN:VCALENDAR/);
    expect(() => parseICalendar('SUMMARY:x\r\n')).toThrow(/outside any component/);
    expect(() => parseICalendar('END:VCALENDAR\r\n')).toThrow(/no open component/);
    expect(() => parseICalendar('BEGIN:V CAL\r\nEND:V CAL\r\n')).toThrow(ICalParseError);
    expect(() => parseICalendar(' leading continuation\r\n')).toThrow(ICalParseError);
  });

  it('enforces size, depth and line limits with ICalLimitError', () => {
    const deep = `${'BEGIN:X\r\n'.repeat(9)}${'END:X\r\n'.repeat(9)}`;
    expect(() => parseICalendar(deep)).toThrow(ICalLimitError);
    expect(() => parseICalendar(deep, { maxDepth: 9 })).not.toThrow();
    expect(() => parseICalendar('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', { maxBytes: 10 })).toThrow(ICalLimitError);
    expect(() => parseICalendar(new Uint8Array(11), { maxBytes: 10 })).toThrow(ICalLimitError);
    expect(() => parseICalendar('BEGIN:VCALENDAR\r\nX:1\r\nX:2\r\nEND:VCALENDAR\r\n', { maxLines: 3 })).toThrow(ICalLimitError);
  });

  it('serializer refuses a raw line break in a value and invalid names', () => {
    expect(() => serializeICalendar({ name: 'VCALENDAR', properties: [{ name: 'X', params: {}, value: 'a\nb' }], components: [] })).toThrow(ICalError);
    expect(() => serializeICalendar({ name: 'VCALENDAR', properties: [{ name: 'BEGIN', params: {}, value: 'X' }], components: [] })).toThrow(ICalError);
    expect(() => serializeICalendar({ name: 'V CAL', properties: [], components: [] })).toThrow(ICalError);
  });
});

describe('typed values', () => {
  it('DATE and DATE-TIME in all three forms', () => {
    expect(parseDate('19970714')).toEqual({ type: 'date', year: 1997, month: 7, day: 14 });
    expect(parseDateTime('19980118T230000')).toMatchObject({ utc: false, tzid: null });
    expect(parseDateTime('19980119T070000Z')).toMatchObject({ utc: true, tzid: null, hour: 7 });
    expect(parseDateTime('19980119T020000', 'America/New_York')).toMatchObject({ utc: false, tzid: 'America/New_York' });
    expect(() => parseDate('19970230')).toThrow(ICalParseError);
    expect(() => parseDateTime('19970101T250000')).toThrow(ICalParseError);
    expect(propertyDate({ name: 'DTSTART', params: { VALUE: ['DATE'] }, value: '20260101' }).type).toBe('date');
  });
  it('DURATION', () => {
    expect(durationToSeconds(parseDuration('P15DT5H0M20S'))).toBe(15 * 86400 + 5 * 3600 + 20);
    expect(durationToSeconds(parseDuration('P7W'))).toBe(7 * 7 * 86400);
    expect(durationToSeconds(parseDuration('-PT15M'))).toBe(-900);
    expect(formatDuration(parseDuration('-P1DT2H'))).toBe('-P1DT2H');
    for (const bad of ['P', 'PT', 'P1DT', '15M', 'P1Y', 'PT1.5H']) expect(() => parseDuration(bad), bad).toThrow(ICalParseError);
  });
  it('PERIOD', () => {
    expect(parsePeriod('19970101T180000Z/19970102T070000Z').end?.hour).toBe(7);
    expect(parsePeriod('19970101T180000Z/PT5H30M').duration).toMatchObject({ hours: 5, minutes: 30 });
  });
  it('UTC-OFFSET', () => {
    expect(parseUtcOffset('-0500')).toBe(-18000);
    expect(parseUtcOffset('+013045')).toBe(5445);
    expect(formatUtcOffset(-18000)).toBe('-0500');
    expect(() => parseUtcOffset('0500')).toThrow(ICalParseError);
  });
  it('RECUR parses, validates and formats', () => {
    const r = parseRecur('FREQ=MONTHLY;BYDAY=1SU,-1SU;INTERVAL=2;COUNT=10;X-NAME=keep');
    expect(r.byDay).toEqual([{ weekday: 6, n: 1 }, { weekday: 6, n: -1 }]);
    expect(r.extra).toEqual([['X-NAME', 'keep']]);
    expect(parseRecur(formatRecur(r))).toEqual(r);
    for (const bad of ['', 'COUNT=1', 'FREQ=DAILY;COUNT=1;UNTIL=20260101', 'FREQ=HOURLY;BYHOUR=24', 'FREQ=DAILY;INTERVAL=0', 'FREQ=YEARLY;BYDAY=0MO', 'FREQ=DAILY;FREQ=DAILY', 'FREQ=FORTNIGHTLY']) {
      expect(() => parseRecur(bad), bad).toThrow(ICalParseError);
    }
  });
});
