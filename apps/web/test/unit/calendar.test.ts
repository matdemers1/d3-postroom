// PST-T-8.5 (PST-REQ-136): the event form's recurrence controls ↔ RRULE, and the calendar's layout
// math. The browser behaviour is e2e/tests/calendar-contacts.spec.ts.
import { describe, expect, it } from 'vitest';
import type { EventDetail, EventInstance } from '../../src/api';
import {
  addDays,
  instancesOnDay,
  layoutTimed,
  monthGrid,
  rangeOf,
  startOfWeek,
  step,
  viewHeading,
  visibleDays,
  zonedDay,
  zonedMidnight,
  zonedMinutes,
} from '../../src/calendar/layout';
import { defaultRecurrenceForm, describeRecurrence, detailToForm, formToRecurrence, formToRrule, rruleToForm, weekdayOf, type RecurrenceForm } from '../../src/calendar/recurrence';

const NY = 'America/New_York';

describe('recurrence form ↔ RRULE', () => {
  const weekly: RecurrenceForm = { repeat: 'WEEKLY', interval: 1, byDay: ['WE', 'MO'], end: 'count', count: 6, until: '2026-10-05' };

  it('a weekly Mon/Wed ×6 form is FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE, and back', () => {
    expect(formToRrule(weekly)).toBe('FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE');
    expect(formToRecurrence(weekly)).toEqual({ freq: 'WEEKLY', interval: 1, byDay: ['MO', 'WE'], count: 6, until: null });
    expect(rruleToForm('FREQ=WEEKLY;COUNT=6;BYDAY=MO,WE', '2026-10-05')).toEqual({ ...weekly, byDay: ['MO', 'WE'] });
  });

  it('round-trips every frequency, interval and ending the form offers', () => {
    const forms: RecurrenceForm[] = [
      { ...defaultRecurrenceForm('2026-10-05'), repeat: 'DAILY', interval: 2 },
      { ...defaultRecurrenceForm('2026-10-05'), repeat: 'WEEKLY', interval: 3, byDay: ['TU', 'TH', 'SA'], end: 'until', until: '2026-12-31' },
      { ...defaultRecurrenceForm('2026-10-05'), repeat: 'MONTHLY', end: 'count', count: 12 },
      { ...defaultRecurrenceForm('2026-10-05'), repeat: 'YEARLY', end: 'never' },
    ];
    for (const f of forms) {
      const rule = formToRrule(f);
      expect(rule).not.toBeNull();
      const back = rruleToForm(rule ?? '', '2026-10-05');
      expect(back === null ? null : formToRrule(back)).toBe(rule);
    }
  });

  it('only a weekly rule carries BYDAY; a count is clamped; no repeat is null', () => {
    expect(formToRrule({ ...weekly, repeat: 'MONTHLY' })).toBe('FREQ=MONTHLY;COUNT=6');
    expect(formToRecurrence({ ...weekly, count: 99_999 })?.count).toBe(5000);
    expect(formToRecurrence({ ...weekly, repeat: 'none' })).toBeNull();
    expect(formToRrule({ ...weekly, repeat: 'none' })).toBeNull();
  });

  it('a rule the form cannot show is not turned into one it can', () => {
    expect(rruleToForm('FREQ=MONTHLY;BYDAY=-1FR', '2026-10-05')).toBeNull();
    expect(rruleToForm('FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-05')).toBeNull();
    expect(rruleToForm('FREQ=HOURLY', '2026-10-05')).toBeNull();
    expect(rruleToForm('FREQ=DAILY;BYDAY=MO', '2026-10-05')).toBeNull();
    const detail = { recurrence: { freq: 'MONTHLY', interval: 1, byDay: ['-1FR'], count: null, until: null, rule: 'FREQ=MONTHLY;BYDAY=-1FR', editable: false } } as unknown as EventDetail;
    expect(detailToForm(detail, '2026-10-05')).toBeNull();
  });

  it('reads the API’s recurrence back into the form', () => {
    const detail = { recurrence: { freq: 'WEEKLY', interval: 2, byDay: ['MO', 'WE'], count: null, until: '2026-12-01', rule: '', editable: true } } as unknown as EventDetail;
    expect(detailToForm(detail, '2026-10-05')).toEqual({ repeat: 'WEEKLY', interval: 2, byDay: ['MO', 'WE'], end: 'until', count: 10, until: '2026-12-01' });
    expect(detailToForm({ recurrence: null } as unknown as EventDetail, '2026-10-07')).toEqual(defaultRecurrenceForm('2026-10-07'));
  });

  it('describes itself', () => {
    expect(describeRecurrence(weekly)).toBe('Every week on Mon, Wed, 6 times');
    expect(describeRecurrence({ ...weekly, repeat: 'DAILY', interval: 3, end: 'until', until: '2026-11-01' })).toBe('Every 3 days, until 2026-11-01');
    expect(describeRecurrence(defaultRecurrenceForm('2026-10-05'))).toBe('Does not repeat');
    expect(weekdayOf('2026-10-05')).toBe('MO');
    expect(weekdayOf('2026-10-11')).toBe('SU');
    expect(defaultRecurrenceForm('2026-10-07').byDay).toEqual(['WE']);
  });
});

const inst = (over: Partial<EventInstance>): EventInstance => ({
  calendarId: 'c',
  name: 'n.ics',
  etag: 'e',
  uid: 'u',
  recurrenceId: 'r',
  start: '2026-10-05T13:00:00.000Z',
  end: '2026-10-05T13:30:00.000Z',
  allDay: false,
  startDay: null,
  endDay: null,
  summary: 'x',
  location: '',
  recurring: false,
  override: false,
  ...over,
});

describe('calendar layout', () => {
  it('a month grid is whole Sunday-first weeks covering the month', () => {
    const grid = monthGrid('2026-10-15');
    expect(grid).toHaveLength(5);
    expect(grid[0]?.[0]).toBe('2026-09-27');
    expect(grid[0]?.[4]).toBe('2026-10-01');
    expect(grid[4]?.[6]).toBe('2026-10-31');
    // February 2026 starts on a Sunday and has 28 days: exactly four rows.
    expect(monthGrid('2026-02-01')).toHaveLength(4);
  });

  it('weeks, days and steps', () => {
    expect(startOfWeek('2026-10-07')).toBe('2026-10-04');
    expect(visibleDays('week', '2026-10-07')).toEqual(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
    expect(visibleDays('day', '2026-10-07')).toEqual(['2026-10-07']);
    expect(step('month', '2026-01-31', 1)).toBe('2026-02-28');
    expect(step('month', '2026-03-31', -1)).toBe('2026-02-28');
    expect(step('week', '2026-10-07', -1)).toBe('2026-09-30');
    expect(step('day', '2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
  });

  it('reads instants in the viewer’s zone, across a DST change', () => {
    expect(zonedDay('2026-10-06T03:30:00Z', NY)).toBe('2026-10-05');
    expect(zonedMinutes('2026-10-05T13:00:00Z', NY)).toBe(9 * 60);
    expect(new Date(zonedMidnight('2026-10-05', NY)).toISOString()).toBe('2026-10-05T04:00:00.000Z');
    expect(new Date(zonedMidnight('2026-11-02', NY)).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(rangeOf(visibleDays('week', '2026-10-07'), NY)).toEqual({ start: '2026-10-04T04:00:00.000Z', end: '2026-10-11T04:00:00.000Z' });
    expect(rangeOf(['2026-10-31', '2026-11-01'], NY)).toEqual({ start: '2026-10-31T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z' });
  });

  it('puts a weekly Mon/Wed series on the right days of its week', () => {
    const series = ['2026-10-05T13:00:00.000Z', '2026-10-07T13:00:00.000Z', '2026-10-12T13:00:00.000Z'].map((start) =>
      inst({ start, end: new Date(Date.parse(start) + 30 * 60_000).toISOString(), summary: 'Standup' }),
    );
    const onDays = visibleDays('week', '2026-10-05').map((d) => [d, instancesOnDay(series, d, NY).timed.length]);
    expect(onDays).toEqual([
      ['2026-10-04', 0],
      ['2026-10-05', 1],
      ['2026-10-06', 0],
      ['2026-10-07', 1],
      ['2026-10-08', 0],
      ['2026-10-09', 0],
      ['2026-10-10', 0],
    ]);
  });

  it('spans all-day events over their days, end exclusive', () => {
    const trip = inst({ allDay: true, startDay: '2026-10-09', endDay: '2026-10-12', start: '2026-10-09T04:00:00.000Z', end: '2026-10-12T04:00:00.000Z' });
    expect(['2026-10-08', '2026-10-09', '2026-10-11', '2026-10-12'].map((d) => instancesOnDay([trip], d, NY).allDay.length)).toEqual([0, 1, 1, 0]);
  });

  it('a timed event crossing midnight shows on both days, clipped to each', () => {
    const late = inst({ start: '2026-10-06T03:00:00.000Z', end: '2026-10-06T06:00:00.000Z' }); // 23:00–02:00 NY
    expect(instancesOnDay([late], '2026-10-05', NY).timed).toHaveLength(1);
    expect(instancesOnDay([late], '2026-10-06', NY).timed).toHaveLength(1);
    expect(layoutTimed([late], '2026-10-05', NY)[0]).toMatchObject({ top: 23 * 60, bottom: 1440 });
    expect(layoutTimed([late], '2026-10-06', NY)[0]).toMatchObject({ top: 0, bottom: 120 });
  });

  it('overlapping events share the width; the next free column is reused', () => {
    const a = inst({ summary: 'a', start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T15:00:00.000Z' }); // 9–11
    const b = inst({ summary: 'b', start: '2026-10-05T13:30:00.000Z', end: '2026-10-05T14:00:00.000Z' }); // 9:30–10
    const c = inst({ summary: 'c', start: '2026-10-05T14:00:00.000Z', end: '2026-10-05T14:30:00.000Z' }); // 10–10:30
    const d = inst({ summary: 'd', start: '2026-10-05T16:00:00.000Z', end: '2026-10-05T16:00:00.000Z' }); // 12:00, zero length
    const placed = layoutTimed([d, c, b, a], '2026-10-05', NY);
    const by = (s: string) => placed.find((p) => p.instance.summary === s);
    expect(by('a')).toMatchObject({ top: 540, bottom: 660, column: 0, columns: 2 });
    expect(by('b')).toMatchObject({ top: 570, bottom: 600, column: 1, columns: 2 });
    expect(by('c')).toMatchObject({ top: 600, bottom: 630, column: 1, columns: 2 });
    expect(by('d')).toMatchObject({ top: 720, bottom: 740, column: 0, columns: 1 });
  });

  it('headings', () => {
    expect(viewHeading('month', '2026-10-15', 'en-US')).toBe('October 2026');
    expect(viewHeading('day', '2026-10-05', 'en-US')).toBe('Monday, October 5, 2026');
    expect(viewHeading('week', '2026-10-07', 'en-US')).toMatch(/^Oct 4\s?–\s?10, 2026$/);
  });
});
