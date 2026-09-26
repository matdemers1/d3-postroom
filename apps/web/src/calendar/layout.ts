// Calendar layout math (PST-REQ-136): which days a view shows, which instances fall on a day, and
// where a timed instance sits in the day's time grid — overlapping events side by side in columns.
// Pure and zone-explicit (every function that reads an instant takes the viewer's IANA zone), so it
// is unit-tested without a browser.
import type { EventInstance } from '../api';

export type View = 'month' | 'week' | 'day';
export const VIEWS: readonly View[] = ['month', 'week', 'day'];

/** 0 = Sunday. */
export const WEEK_STARTS_ON = 0;
export const MINUTES_PER_DAY = 1440;
/** The shortest an event is drawn, so a zero-length one is still something to click. */
export const MIN_EVENT_MINUTES = 20;

const pad = (n: number): string => String(n).padStart(2, '0');

function parts(day: string): [number, number, number] {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return [y, m, d];
}

const fromUtc = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  return fromUtc(Date.UTC(y, m - 1, d + n));
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(day: string): number {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function startOfWeek(day: string, weekStartsOn = WEEK_STARTS_ON): string {
  return addDays(day, -((dayOfWeek(day) - weekStartsOn + 7) % 7));
}

export function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** The month view: whole weeks from the one holding the 1st to the one holding the last day. */
export function monthGrid(anchor: string, weekStartsOn = WEEK_STARTS_ON): string[][] {
  const [y, m] = parts(anchor);
  const first = fromUtc(Date.UTC(y, m - 1, 1));
  const last = fromUtc(Date.UTC(y, m, 0));
  const weeks: string[][] = [];
  for (let start = startOfWeek(first, weekStartsOn); start <= last; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
  }
  return weeks;
}

export function visibleDays(view: View, anchor: string, weekStartsOn = WEEK_STARTS_ON): string[] {
  if (view === 'day') return [anchor];
  if (view === 'week') {
    const start = startOfWeek(anchor, weekStartsOn);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }
  return monthGrid(anchor, weekStartsOn).flat();
}

/** The anchor one period earlier (-1) or later (+1). A month step keeps the day, clamped (Jan 31 → Feb 28). */
export function step(view: View, anchor: string, dir: -1 | 1): string {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  const [y, m, d] = parts(anchor);
  const lastOfTarget = new Date(Date.UTC(y, m - 1 + dir + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(y, m - 1 + dir, Math.min(d, lastOfTarget)));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in `tz`. */
function zoned(ms: number, tz: string): { day: string; minutes: number; asUtc: number } {
  const get = (t: string): number => Number(formatter(tz).formatToParts(new Date(ms)).find((p) => p.type === t)?.value ?? 0);
  const y = get('year');
  const mo = get('month');
  const d = get('day');
  const h = get('hour') % 24;
  const mi = get('minute');
  const s = get('second');
  return { day: `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}`, minutes: h * 60 + mi, asUtc: Date.UTC(y, mo - 1, d, h, mi, s) };
}

/** The day (in `tz`) an instant falls on. */
export function zonedDay(iso: string, tz: string): string {
  return zoned(Date.parse(iso), tz).day;
}

/** Minutes since local midnight (in `tz`) of an instant. */
export function zonedMinutes(iso: string, tz: string): number {
  return zoned(Date.parse(iso), tz).minutes;
}

/** The instant (ms) local midnight of `day` is in `tz`. */
export function zonedMidnight(day: string, tz: string): number {
  const [y, m, d] = parts(day);
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall;
  for (let i = 0; i < 3; i++) guess = wall - (zoned(guess, tz).asUtc - guess);
  return guess;
}

/** The API range for a run of days: local midnight of the first to local midnight after the last. */
export function rangeOf(days: readonly string[], tz: string): { start: string; end: string } {
  const first = days[0] ?? '1970-01-01';
  const last = days[days.length - 1] ?? first;
  return { start: new Date(zonedMidnight(first, tz)).toISOString(), end: new Date(zonedMidnight(addDays(last, 1), tz)).toISOString() };
}

/** Instances on one day: all-day ones spanning it, and timed ones overlapping its 24 hours. */
export function instancesOnDay(instances: readonly EventInstance[], day: string, tz: string): { allDay: EventInstance[]; timed: EventInstance[] } {
  const from = zonedMidnight(day, tz);
  const to = zonedMidnight(addDays(day, 1), tz);
  const allDay: EventInstance[] = [];
  const timed: EventInstance[] = [];
  for (const i of instances) {
    if (i.allDay) {
      const s = i.startDay ?? zonedDay(i.start, tz);
      const e = i.endDay ?? addDays(s, 1);
      if (s <= day && day < (e > s ? e : addDays(s, 1))) allDay.push(i);
    } else {
      const s = Date.parse(i.start);
      const e = Date.parse(i.end);
      if (s < to && (e > from || (e === s && s >= from))) timed.push(i);
    }
  }
  return { allDay, timed };
}

export interface Placed {
  readonly instance: EventInstance;
  /** Minutes from the day's midnight, clipped to the day. */
  readonly top: number;
  readonly bottom: number;
  /** 0-based column within its cluster of overlapping events, and how many columns it has. */
  readonly column: number;
  readonly columns: number;
}

/** Timed instances placed in a day's grid: overlapping events share the width in columns. */
export function layoutTimed(instances: readonly EventInstance[], day: string, tz: string): Placed[] {
  const from = zonedMidnight(day, tz);
  const items = instances
    .map((instance) => {
      const top = Math.max(0, Math.round((Date.parse(instance.start) - from) / 60_000));
      const end = Math.min(MINUTES_PER_DAY, Math.round((Date.parse(instance.end) - from) / 60_000));
      const bottom = Math.min(MINUTES_PER_DAY, Math.max(end, top + MIN_EVENT_MINUTES));
      return { instance, top: Math.min(top, MINUTES_PER_DAY - MIN_EVENT_MINUTES), bottom };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.instance.summary.localeCompare(b.instance.summary));

  const out: Placed[] = [];
  let cluster: { item: (typeof items)[number]; column: number }[] = [];
  let clusterEnd = -1;
  const flush = (): void => {
    const columns = Math.max(1, ...cluster.map((c) => c.column + 1));
    for (const c of cluster) out.push({ instance: c.item.instance, top: c.item.top, bottom: c.item.bottom, column: c.column, columns });
    cluster = [];
  };
  for (const item of items) {
    if (cluster.length > 0 && item.top >= clusterEnd) flush();
    // The first column whose last event has ended.
    let column = 0;
    while (cluster.some((c) => c.column === column && c.item.bottom > item.top)) column++;
    cluster.push({ item, column });
    clusterEnd = Math.max(clusterEnd, item.bottom);
  }
  if (cluster.length > 0) flush();
  return out;
}

/** The toolbar's heading for a view. */
export function viewHeading(view: View, anchor: string, locale?: string): string {
  const [y, m, d] = parts(anchor);
  const at = (yy: number, mm: number, dd: number): Date => new Date(Date.UTC(yy, mm - 1, dd, 12));
  if (view === 'month') return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(at(y, m, d));
  if (view === 'day') return new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(at(y, m, d));
  const days = visibleDays('week', anchor);
  const [fy, fm, fd] = parts(days[0] ?? anchor);
  const [ly, lm, ld] = parts(days[6] ?? anchor);
  const fmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return fmt.formatRange(at(fy, fm, fd), at(ly, lm, ld));
}

/** A day as a screen reader reads it: "Monday, October 5, 2026". */
export function dayLabel(day: string, locale?: string): string {
  const [y, m, d] = parts(day);
  return new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** "9:00 AM" for an instant in `tz`. */
export function timeLabel(iso: string, tz: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
}

/** Today in `tz`. */
export function today(tz: string, now: Date = new Date()): string {
  return zoned(now.getTime(), tz).day;
}
