// RECUR values (RFC 5545 §3.3.10) and the RRULE iterator.
//
// The iterator works in *local wall-clock seconds* ("as if UTC") of DTSTART's time zone, as §3.3.10
// requires, and walks one FREQ period at a time: build the period's candidate days (every BYxxx day
// rule is applied as a filter over the period's days — which is exactly "expand" for rules coarser
// than FREQ and "limit" for rules finer than it), cross them with the candidate times, apply BYSETPOS
// by index, and emit in order. Every period and every candidate is charged to a shared iteration
// budget, so no rule — however pathological — can loop without bound.
import { civilFromDays, daysFromCivil, daysInMonth, daysInYear, mod, SECONDS_PER_DAY, weekdayOfDays } from './civil.js';
import { ICalParseError } from './errors.js';
import { formatDateValue, parseDateOrDateTime, type ICalDateValue } from './values.js';

export type Frequency = 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

const FREQUENCIES: readonly Frequency[] = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/** Weekday codes in index order: 0 = MO … 6 = SU (the same index {@link weekdayOfDays} returns). */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

export interface WeekdayNum {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** Ordinal (`1MO`, `-1FR`); 0 means every such weekday. */
  n: number;
}

export interface Recur {
  freq: Frequency;
  interval: number;
  count: number | null;
  until: ICalDateValue | null;
  bySecond: number[];
  byMinute: number[];
  byHour: number[];
  byDay: WeekdayNum[];
  byMonthDay: number[];
  byYearDay: number[];
  byWeekNo: number[];
  byMonth: number[];
  bySetPos: number[];
  /** Week start, 0 = MO (the default) … 6 = SU. */
  wkst: number;
  /** Rule parts this implementation does not interpret (X- names, RSCALE, SKIP), in order. */
  extra: [string, string][];
}

/** Hard ceilings on the RRULE grammar's numbers, so nothing downstream sees a 1e308 INTERVAL. */
const MAX_COUNT = 1_000_000_000;
const MAX_INTERVAL = 1_000_000;

function intList(raw: string, part: string, min: number, max: number, allowZero = false): number[] {
  return raw.split(',').map((t) => {
    if (!/^[+-]?\d{1,3}$/.test(t)) throw new ICalParseError(`invalid ${part} value "${t.slice(0, 20)}"`);
    const n = Number(t);
    if (n < min || n > max || (!allowZero && n === 0)) throw new ICalParseError(`${part} value ${t} out of range`);
    return n;
  });
}

function positiveInt(raw: string, part: string, max: number): number {
  if (!/^\d{1,10}$/.test(raw)) throw new ICalParseError(`invalid ${part} "${raw.slice(0, 20)}"`);
  const n = Number(raw);
  if (n < 1 || n > max) throw new ICalParseError(`${part} ${raw} out of range`);
  return n;
}

function weekday(code: string, part: string): number {
  const i = (WEEKDAYS as readonly string[]).indexOf(code.toUpperCase());
  if (i < 0) throw new ICalParseError(`invalid weekday "${code.slice(0, 10)}" in ${part}`);
  return i;
}

/** Parse a RECUR value such as `FREQ=MONTHLY;BYDAY=-1FR;COUNT=5`. */
export function parseRecur(raw: string): Recur {
  const r: Recur = {
    freq: 'DAILY',
    interval: 1,
    count: null,
    until: null,
    bySecond: [],
    byMinute: [],
    byHour: [],
    byDay: [],
    byMonthDay: [],
    byYearDay: [],
    byWeekNo: [],
    byMonth: [],
    bySetPos: [],
    wkst: 0,
    extra: [],
  };
  let sawFreq = false;
  const seen = new Set<string>();
  const trimmed = raw.trim().replace(/;$/, '');
  if (trimmed === '') throw new ICalParseError('empty RECUR value');
  for (const part of trimmed.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new ICalParseError(`invalid RECUR part "${part.slice(0, 30)}"`);
    const key = part.slice(0, eq).toUpperCase();
    const val = part.slice(eq + 1);
    if (seen.has(key)) throw new ICalParseError(`RECUR part ${key} given twice`);
    seen.add(key);
    if (val === '') throw new ICalParseError(`RECUR part ${key} has no value`);
    switch (key) {
      case 'FREQ': {
        const f = val.toUpperCase();
        if (!(FREQUENCIES as readonly string[]).includes(f)) throw new ICalParseError(`invalid FREQ "${val.slice(0, 20)}"`);
        r.freq = f as Frequency;
        sawFreq = true;
        break;
      }
      case 'INTERVAL':
        r.interval = positiveInt(val, 'INTERVAL', MAX_INTERVAL);
        break;
      case 'COUNT':
        r.count = positiveInt(val, 'COUNT', MAX_COUNT);
        break;
      case 'UNTIL':
        r.until = parseDateOrDateTime(val);
        break;
      case 'BYSECOND':
        r.bySecond = intList(val, key, 0, 60, true);
        break;
      case 'BYMINUTE':
        r.byMinute = intList(val, key, 0, 59, true);
        break;
      case 'BYHOUR':
        r.byHour = intList(val, key, 0, 23, true);
        break;
      case 'BYDAY':
        r.byDay = val.split(',').map((t) => {
          const m = /^([+-]?\d{1,2})?([A-Za-z]{2})$/.exec(t);
          if (m === null) throw new ICalParseError(`invalid BYDAY value "${t.slice(0, 20)}"`);
          const n = m[1] === undefined ? 0 : Number(m[1]);
          if (m[1] !== undefined && (n === 0 || n < -53 || n > 53)) throw new ICalParseError(`BYDAY ordinal ${t} out of range`);
          return { weekday: weekday(m[2] ?? '', key), n };
        });
        break;
      case 'BYMONTHDAY':
        r.byMonthDay = intList(val, key, -31, 31);
        break;
      case 'BYYEARDAY':
        r.byYearDay = intList(val, key, -366, 366);
        break;
      case 'BYWEEKNO':
        r.byWeekNo = intList(val, key, -53, 53);
        break;
      case 'BYMONTH':
        r.byMonth = intList(val, key, 1, 12);
        break;
      case 'BYSETPOS':
        r.bySetPos = intList(val, key, -366, 366);
        break;
      case 'WKST':
        r.wkst = weekday(val, key);
        break;
      default:
        if (!/^[A-Z0-9-]+$/.test(key)) throw new ICalParseError(`invalid RECUR part name "${key.slice(0, 20)}"`);
        r.extra.push([key, val]);
    }
  }
  if (!sawFreq) throw new ICalParseError('RECUR has no FREQ');
  if (r.count !== null && r.until !== null) throw new ICalParseError('RECUR has both COUNT and UNTIL');
  return r;
}

/** Serialise a Recur in the conventional part order. */
export function formatRecur(r: Recur): string {
  const parts: string[] = [`FREQ=${r.freq}`];
  if (r.until !== null) parts.push(`UNTIL=${formatDateValue(r.until)}`);
  if (r.count !== null) parts.push(`COUNT=${String(r.count)}`);
  if (r.interval !== 1) parts.push(`INTERVAL=${String(r.interval)}`);
  const list = (k: string, xs: number[]): void => {
    if (xs.length > 0) parts.push(`${k}=${xs.join(',')}`);
  };
  list('BYSECOND', r.bySecond);
  list('BYMINUTE', r.byMinute);
  list('BYHOUR', r.byHour);
  if (r.byDay.length > 0) {
    parts.push(`BYDAY=${r.byDay.map((d) => `${d.n === 0 ? '' : String(d.n)}${WEEKDAYS[d.weekday] ?? 'MO'}`).join(',')}`);
  }
  list('BYMONTHDAY', r.byMonthDay);
  list('BYYEARDAY', r.byYearDay);
  list('BYWEEKNO', r.byWeekNo);
  list('BYMONTH', r.byMonth);
  list('BYSETPOS', r.bySetPos);
  if (r.wkst !== 0) parts.push(`WKST=${WEEKDAYS[r.wkst] ?? 'MO'}`);
  for (const [k, v] of r.extra) parts.push(`${k}=${v}`);
  return parts.join(';');
}

/** A shared, decrementing iteration budget. `exhausted` latches once it runs out. */
export interface Budget {
  remaining: number;
  exhausted: boolean;
}

export function createBudget(max: number): Budget {
  return { remaining: max, exhausted: false };
}

function charge(b: Budget, n = 1): boolean {
  b.remaining -= n;
  if (b.remaining < 0) b.exhausted = true;
  return !b.exhausted;
}

/** Why an iteration stopped. */
export type StopReason = 'count' | 'until' | 'range' | 'cap' | 'exhausted';

export interface IterateOptions {
  /** DTSTART in local wall-clock seconds. Always yielded first (§3.8.5.3: it is the first instance). */
  dtstart: number;
  /** DTSTART is a DATE: times are ignored and a sub-daily FREQ is treated as DAILY. */
  dateOnly: boolean;
  /** True when a local time lies after UNTIL (the caller resolves time zones). */
  isAfterUntil: (local: number) => boolean;
  budget: Budget;
  /** Lower bound hint (local seconds): with no COUNT, periods wholly before it are skipped. */
  from?: number;
  /** Upper bound (local seconds): stop once a period starts after it. */
  to?: number;
}

const MAX_YEAR = 9999;

interface Plan {
  freq: Frequency;
  interval: number;
  byMonth: Set<number> | null;
  byWeekNo: number[];
  byYearDay: Set<number> | null;
  byMonthDay: Set<number> | null;
  plainDays: Set<number>;
  nthDays: WeekdayNum[];
  hasDayOfWeek: boolean;
  hours: number[];
  minutes: number[];
  seconds: number[];
  byHour: Set<number> | null;
  byMinute: Set<number> | null;
  bySecond: Set<number> | null;
  bySetPos: number[];
  wkst: number;
}

const sortedUnique = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);

function plan(rule: Recur, dtstart: number, dateOnly: boolean): Plan {
  const days = Math.floor(dtstart / SECONDS_PER_DAY);
  const dt = civilFromDays(days);
  const tod = dtstart - days * SECONDS_PER_DAY;
  const dtHour = Math.floor(tod / 3600);
  const dtMinute = Math.floor((tod % 3600) / 60);
  const dtSecond = tod % 60;

  let freq = rule.freq;
  if (dateOnly && (freq === 'HOURLY' || freq === 'MINUTELY' || freq === 'SECONDLY')) freq = 'DAILY';

  let byMonth = rule.byMonth;
  let byMonthDay = rule.byMonthDay;
  const plain = new Set<number>();
  const nth: WeekdayNum[] = [];
  const nthAllowed = freq === 'YEARLY' || freq === 'MONTHLY';
  for (const d of rule.byDay) {
    if (d.n !== 0 && nthAllowed) nth.push(d);
    else plain.add(d.weekday);
  }
  // §3.3.10: rule parts absent from the rule take their value from DTSTART.
  if (rule.byWeekNo.length === 0 && rule.byYearDay.length === 0 && rule.byMonthDay.length === 0 && rule.byDay.length === 0) {
    if (freq === 'YEARLY') {
      if (byMonth.length === 0) byMonth = [dt.month];
      byMonthDay = [dt.day];
    } else if (freq === 'MONTHLY') {
      byMonthDay = [dt.day];
    } else if (freq === 'WEEKLY') {
      plain.add(weekdayOfDays(days));
    }
  }
  // Leap seconds (BYSECOND=60) are not representable in wall-clock arithmetic and are dropped.
  const bySecond = rule.bySecond.filter((s) => s < 60);
  const secondsGiven = rule.bySecond.length > 0;
  return {
    freq,
    interval: rule.interval,
    byMonth: byMonth.length > 0 ? new Set(byMonth) : null,
    byWeekNo: rule.byWeekNo,
    byYearDay: rule.byYearDay.length > 0 ? new Set(rule.byYearDay) : null,
    byMonthDay: byMonthDay.length > 0 ? new Set(byMonthDay) : null,
    plainDays: plain,
    nthDays: nth,
    hasDayOfWeek: plain.size > 0 || nth.length > 0,
    hours: dateOnly ? [0] : rule.byHour.length > 0 ? sortedUnique(rule.byHour) : [dtHour],
    minutes: dateOnly ? [0] : rule.byMinute.length > 0 ? sortedUnique(rule.byMinute) : [dtMinute],
    seconds: dateOnly ? [0] : secondsGiven ? sortedUnique(bySecond) : [dtSecond],
    byHour: rule.byHour.length > 0 && !dateOnly ? new Set(rule.byHour) : null,
    byMinute: rule.byMinute.length > 0 && !dateOnly ? new Set(rule.byMinute) : null,
    bySecond: secondsGiven && !dateOnly ? new Set(bySecond) : null,
    bySetPos: rule.bySetPos,
    wkst: rule.wkst,
  };
}

/**
 * BYWEEKNO membership for every day of a year, by day-of-year index (0-based). Week 1 is the first
 * week (starting on WKST) with at least four days in the year (§3.3.10). Days at the end of the
 * year that belong to next year's week 1, and days at the start that belong to last year's final
 * week, are handled too. Adapted from python-dateutil's rrule.
 */
function weekNoMask(year: number, byWeekNo: number[], wkst: number): Uint8Array {
  const yearLen = daysInYear(year);
  const mask = new Uint8Array(yearLen);
  const jan1 = daysFromCivil(year, 1, 1);
  const yearWeekday = weekdayOfDays(jan1);
  const wdayAt = (i: number): number => mod(yearWeekday + i, 7);
  const firstWkst = mod(7 - yearWeekday + wkst, 7);
  let no1wkst = firstWkst;
  let wyearLen: number;
  if (no1wkst >= 4) {
    no1wkst = 0;
    wyearLen = yearLen + mod(yearWeekday - wkst, 7);
  } else {
    wyearLen = yearLen - no1wkst;
  }
  const numWeeks = Math.floor(wyearLen / 7) + Math.floor((wyearLen % 7) / 4);
  const markWeek = (start: number): void => {
    let i = start;
    for (let j = 0; j < 7; j++) {
      if (i >= 0 && i < yearLen) mask[i] = 1;
      i++;
      if (wdayAt(i) === wkst) break;
    }
  };
  for (const raw of byWeekNo) {
    const n = raw < 0 ? raw + numWeeks + 1 : raw;
    if (n < 1 || n > numWeeks) continue;
    let i: number;
    if (n > 1) {
      i = no1wkst + (n - 1) * 7;
      if (no1wkst !== firstWkst) i -= 7 - firstWkst;
    } else {
      i = no1wkst;
    }
    markWeek(i);
  }
  if (byWeekNo.includes(1)) {
    // Week 1 of next year may start in the last days of this one.
    let i = no1wkst + numWeeks * 7;
    if (no1wkst !== firstWkst) i -= 7 - firstWkst;
    if (i < yearLen) markWeek(i);
  }
  if (no1wkst > 0) {
    // The first days of this year may belong to last year's final week.
    let lastYearWeeks: number;
    if (byWeekNo.includes(-1)) {
      lastYearWeeks = -1;
    } else {
      const lYearWeekday = weekdayOfDays(daysFromCivil(year - 1, 1, 1));
      const lno1wkst = mod(7 - lYearWeekday + wkst, 7);
      const lYearLen = daysInYear(year - 1);
      if (lno1wkst >= 4) {
        lastYearWeeks = 52 + Math.floor(mod(lYearLen + mod(lYearWeekday - wkst, 7), 7) / 4);
      } else {
        lastYearWeeks = 52 + Math.floor(mod(lYearLen - lno1wkst, 7) / 4);
      }
    }
    if (byWeekNo.includes(lastYearWeeks)) for (let i = 0; i < no1wkst; i++) mask[i] = 1;
  }
  return mask;
}

class DayFilter {
  private readonly weekNoCache = new Map<number, Uint8Array>();
  constructor(private readonly p: Plan) {}

  matches(day: number): boolean {
    const p = this.p;
    const c = civilFromDays(day);
    if (p.byMonth !== null && !p.byMonth.has(c.month)) return false;
    if (p.byWeekNo.length > 0) {
      let mask = this.weekNoCache.get(c.year);
      if (mask === undefined) {
        mask = weekNoMask(c.year, p.byWeekNo, p.wkst);
        if (this.weekNoCache.size > 64) this.weekNoCache.clear();
        this.weekNoCache.set(c.year, mask);
      }
      if (mask[day - daysFromCivil(c.year, 1, 1)] !== 1) return false;
    }
    if (p.byYearDay !== null) {
      const doy = day - daysFromCivil(c.year, 1, 1) + 1;
      if (!p.byYearDay.has(doy) && !p.byYearDay.has(doy - daysInYear(c.year) - 1)) return false;
    }
    if (p.byMonthDay !== null) {
      if (!p.byMonthDay.has(c.day) && !p.byMonthDay.has(c.day - daysInMonth(c.year, c.month) - 1)) return false;
    }
    if (p.hasDayOfWeek) {
      const wd = weekdayOfDays(day);
      let ok = p.plainDays.has(wd);
      if (!ok && p.nthDays.length > 0) {
        // Ordinals count within the year for YEARLY without BYMONTH, otherwise within the month.
        let first: number;
        let last: number;
        if (p.freq === 'YEARLY' && p.byMonth === null) {
          first = daysFromCivil(c.year, 1, 1);
          last = first + daysInYear(c.year) - 1;
        } else {
          first = daysFromCivil(c.year, c.month, 1);
          last = first + daysInMonth(c.year, c.month) - 1;
        }
        for (const d of p.nthDays) {
          if (d.weekday !== wd) continue;
          if (d.n > 0 && Math.floor((day - first) / 7) + 1 === d.n) ok = true;
          if (d.n < 0 && Math.floor((last - day) / 7) + 1 === -d.n) ok = true;
          if (ok) break;
        }
      }
      if (!ok) return false;
    }
    return true;
  }
}

function product(p: Plan): number[] {
  const out: number[] = [];
  for (const h of p.hours) for (const m of p.minutes) for (const s of p.seconds) out.push(h * 3600 + m * 60 + s);
  return out;
}

/**
 * Iterate the recurrence set of one RRULE, in ascending local time, starting with DTSTART.
 * Returns why it stopped. The caller may stop pulling at any time.
 */
export function* iterateRecur(rule: Recur, opts: IterateOptions): Generator<number, StopReason> {
  const { dtstart, budget } = opts;
  const p = plan(rule, dtstart, opts.dateOnly);
  const filter = new DayFilter(p);
  const count = rule.count;
  const to = opts.to ?? Number.POSITIVE_INFINITY;
  const from = count === null && opts.from !== undefined ? opts.from : Number.NEGATIVE_INFINITY;
  let emitted = 0;

  if (!charge(budget)) return 'cap';
  yield dtstart;
  emitted++;
  if (count !== null && emitted >= count) return 'count';

  // Returns a stop reason, or null to continue.
  function* emit(candidates: Iterable<number>): Generator<number, StopReason | null> {
    for (const c of candidates) {
      if (!charge(budget)) return 'cap';
      if (c <= dtstart) continue;
      if (opts.isAfterUntil(c)) return 'until';
      if (c > to) return 'range';
      yield c;
      emitted++;
      if (count !== null && emitted >= count) return 'count';
    }
    return null;
  }

  // Candidates for a set of days with per-day time offsets, honouring BYSETPOS by index.
  function* dayCandidates(days: number[], times: number[]): Generator<number> {
    if (days.length === 0 || times.length === 0) return;
    if (p.bySetPos.length > 0) {
      const n = days.length * times.length;
      const picked = new Set<number>();
      for (const pos of p.bySetPos) {
        const idx = pos > 0 ? pos - 1 : n + pos;
        if (idx < 0 || idx >= n) continue;
        const d = days[Math.floor(idx / times.length)] ?? 0;
        const t = times[idx % times.length] ?? 0;
        picked.add(d * SECONDS_PER_DAY + t);
      }
      yield* [...picked].sort((a, b) => a - b);
      return;
    }
    const lastTime = times[times.length - 1] ?? 0;
    for (const d of days) {
      // Whole days wholly before `from` are skipped at the cost of one iteration.
      if (d * SECONDS_PER_DAY + lastTime < from) {
        if (!charge(budget)) return;
        continue;
      }
      for (const t of times) yield d * SECONDS_PER_DAY + t;
    }
  }

  const startDay = Math.floor(dtstart / SECONDS_PER_DAY);
  const start = civilFromDays(startDay);
  const interval = p.interval;

  if (p.freq === 'YEARLY' || p.freq === 'MONTHLY' || p.freq === 'WEEKLY' || p.freq === 'DAILY') {
    const times = product(p);
    // Period index k: the period's first day is periodStart(k).
    let periodStart: (k: number) => { first: number; len: number } | null;
    let skipTo = 0;
    if (p.freq === 'YEARLY') {
      periodStart = (k) => {
        const y = start.year + k * interval;
        if (y > MAX_YEAR) return null;
        return { first: daysFromCivil(y, 1, 1), len: daysInYear(y) };
      };
      if (Number.isFinite(from)) skipTo = Math.floor((civilFromDays(Math.floor(from / SECONDS_PER_DAY)).year - start.year) / interval);
    } else if (p.freq === 'MONTHLY') {
      const m0 = start.year * 12 + (start.month - 1);
      periodStart = (k) => {
        const mi = m0 + k * interval;
        const y = Math.floor(mi / 12);
        const m = (mi % 12) + 1;
        if (y > MAX_YEAR) return null;
        return { first: daysFromCivil(y, m, 1), len: daysInMonth(y, m) };
      };
      if (Number.isFinite(from)) {
        const f = civilFromDays(Math.floor(from / SECONDS_PER_DAY));
        skipTo = Math.floor((f.year * 12 + f.month - 1 - m0) / interval);
      }
    } else if (p.freq === 'WEEKLY') {
      const w0 = startDay - mod(weekdayOfDays(startDay) - p.wkst, 7);
      periodStart = (k) => {
        const first = w0 + k * 7 * interval;
        if (civilFromDays(first).year > MAX_YEAR) return null;
        return { first, len: 7 };
      };
      if (Number.isFinite(from)) skipTo = Math.floor((Math.floor(from / SECONDS_PER_DAY) - w0) / (7 * interval));
    } else {
      periodStart = (k) => {
        const first = startDay + k * interval;
        if (civilFromDays(first).year > MAX_YEAR) return null;
        return { first, len: 1 };
      };
      if (Number.isFinite(from)) skipTo = Math.floor((Math.floor(from / SECONDS_PER_DAY) - startDay) / interval);
    }
    for (let k = Math.max(0, skipTo); ; k++) {
      if (!charge(budget)) return 'cap';
      const period = periodStart(k);
      if (period === null) return 'exhausted';
      if (period.first * SECONDS_PER_DAY > to) return 'range';
      const days: number[] = [];
      // YEARLY with BYMONTH only needs to look at those months.
      const spans: [number, number][] = [];
      if (p.freq === 'YEARLY' && p.byMonth !== null) {
        const y = civilFromDays(period.first).year;
        for (const m of [...p.byMonth].sort((a, b) => a - b)) spans.push([daysFromCivil(y, m, 1), daysInMonth(y, m)]);
      } else {
        spans.push([period.first, period.len]);
      }
      for (const [first, len] of spans) {
        if (!charge(budget, len)) return 'cap';
        for (let i = 0; i < len; i++) if (filter.matches(first + i)) days.push(first + i);
      }
      const stop = yield* emit(dayCandidates(days, times));
      if (stop !== null) return stop;
      if (budget.exhausted) return 'cap';
    }
  }

  // Sub-daily: the period is one hour, minute or second.
  const unit = p.freq === 'HOURLY' ? 3600 : p.freq === 'MINUTELY' ? 60 : 1;
  const step = unit * interval;
  let t = Math.floor(dtstart / unit) * unit;
  if (Number.isFinite(from) && from > t) t += Math.floor((from - t) / step) * step;
  const minuteSeconds = product({ ...p, hours: [0] });
  const secondsOnly = p.seconds;
  // Jump forward by whole steps to the first period at or after `boundary`.
  const jumpTo = (boundary: number): void => {
    t += Math.max(1, Math.ceil((boundary - t) / step)) * step;
  };
  for (;;) {
    if (!charge(budget)) return 'cap';
    if (t > to) return 'range';
    const day = Math.floor(t / SECONDS_PER_DAY);
    if (civilFromDays(day).year > MAX_YEAR) return 'exhausted';
    if (!filter.matches(day)) {
      jumpTo((day + 1) * SECONDS_PER_DAY);
      continue;
    }
    const tod = t - day * SECONDS_PER_DAY;
    const hour = Math.floor(tod / 3600);
    if (p.byHour !== null && !p.byHour.has(hour)) {
      jumpTo(day * SECONDS_PER_DAY + (hour + 1) * 3600);
      continue;
    }
    let times: number[];
    if (p.freq === 'HOURLY') {
      times = minuteSeconds.map((x) => hour * 3600 + x);
    } else {
      const minute = Math.floor((tod % 3600) / 60);
      if (p.byMinute !== null && !p.byMinute.has(minute)) {
        jumpTo(day * SECONDS_PER_DAY + hour * 3600 + (minute + 1) * 60);
        continue;
      }
      if (p.freq === 'MINUTELY') {
        times = secondsOnly.map((s) => hour * 3600 + minute * 60 + s);
      } else {
        times = p.bySecond === null || p.bySecond.has(tod % 60) ? [tod] : [];
      }
    }
    const stop = yield* emit(dayCandidates([day], times));
    if (stop !== null) return stop;
    if (budget.exhausted) return 'cap';
    t += step;
  }
}
