// UTC-offset resolution for TZID-qualified times (RFC 5545 §3.6.5). An embedded VTIMEZONE is
// authoritative: its STANDARD/DAYLIGHT observances are expanded (DTSTART + RRULE + RDATE, onset in
// the TZOFFSETFROM offset) and the latest onset at or before an instant gives TZOFFSETTO. A TZID
// with no VTIMEZONE falls back to the host's IANA database through Intl. An unknown TZID resolves
// to null, and callers treat it as UTC (documented on `expand`).
import { localSeconds, SECONDS_PER_DAY } from './civil.js';
import { getComponents, getProperties, getProperty, type Component } from './component.js';
import { ICalError } from './errors.js';
import { createBudget, iterateRecur, parseRecur, type Recur, type StopReason } from './recur.js';
import { parseUtcOffset, propertyDate, propertyDateList, type ICalDateTime, type ICalDateValue } from './values.js';

export interface TimeZoneResolver {
  /** Offset in seconds east of UTC in effect at a UTC instant (seconds), or null for an unknown TZID. */
  offsetAt(tzid: string, utcSeconds: number): number | null;
}

/** Onsets generated per observance before we stop believing the rule (pathological VTIMEZONEs). */
const MAX_ONSETS = 20_000;
const OBSERVANCE_BUDGET = 400_000;

function localOf(v: ICalDateValue): number {
  return v.type === 'date'
    ? localSeconds({ year: v.year, month: v.month, day: v.day, hour: 0, minute: 0, second: 0 })
    : localSeconds(v);
}

class Observance {
  private readonly onsets: number[] = [];
  private readonly iter: Generator<number, StopReason> | null;
  private done = false;
  readonly offsetFrom: number;
  readonly offsetTo: number;
  private readonly rdates: number[];

  constructor(comp: Component) {
    const dtstartProp = getProperty(comp, 'DTSTART');
    const fromProp = getProperty(comp, 'TZOFFSETFROM');
    const toProp = getProperty(comp, 'TZOFFSETTO');
    if (dtstartProp === undefined || fromProp === undefined || toProp === undefined) {
      throw new ICalError(`${comp.name} observance lacks DTSTART, TZOFFSETFROM or TZOFFSETTO`);
    }
    this.offsetFrom = parseUtcOffset(fromProp.value);
    this.offsetTo = parseUtcOffset(toProp.value);
    const dtstart = propertyDate(dtstartProp);
    const startLocal = localOf(dtstart);
    const rruleProp = getProperty(comp, 'RRULE');
    const rule: Recur | null = rruleProp === undefined ? null : parseRecur(rruleProp.value);
    const offsetFrom = this.offsetFrom;
    if (rule !== null) {
      const until = rule.until;
      const untilUtc = until === null ? null : until.type === 'date-time' && until.utc ? localOf(until) : localOf(until) - offsetFrom;
      this.iter = iterateRecur(rule, {
        dtstart: startLocal,
        dateOnly: dtstart.type === 'date',
        isAfterUntil: (l) => untilUtc !== null && l - offsetFrom > untilUtc,
        budget: createBudget(OBSERVANCE_BUDGET),
      });
    } else {
      this.iter = null;
      this.onsets.push(startLocal - offsetFrom);
      this.done = true;
    }
    this.rdates = [];
    for (const p of getProperties(comp, 'RDATE')) {
      for (const v of propertyDateList(p)) {
        const d: ICalDateValue = 'start' in v ? v.start : v;
        this.rdates.push(d.type === 'date-time' && d.utc ? localOf(d) : localOf(d) - offsetFrom);
      }
    }
    this.rdates.sort((a, b) => a - b);
  }

  private extendPast(utc: number): void {
    while (!this.done && this.iter !== null) {
      const last = this.onsets[this.onsets.length - 1];
      if (last !== undefined && last > utc) return;
      if (this.onsets.length >= MAX_ONSETS) {
        this.done = true;
        return;
      }
      const n = this.iter.next();
      if (n.done === true) {
        this.done = true;
        return;
      }
      this.onsets.push(n.value - this.offsetFrom);
    }
  }

  /** Latest onset (UTC seconds) at or before `utc`, or null. */
  latestAtOrBefore(utc: number): number | null {
    this.extendPast(utc);
    return Math.max(latestIn(this.onsets, utc) ?? Number.NEGATIVE_INFINITY, latestIn(this.rdates, utc) ?? Number.NEGATIVE_INFINITY);
  }

  firstOnset(): number {
    this.extendPast(Number.NEGATIVE_INFINITY);
    return Math.min(this.onsets[0] ?? Number.POSITIVE_INFINITY, this.rdates[0] ?? Number.POSITIVE_INFINITY);
  }
}

function latestIn(sorted: number[], x: number): number | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid] ?? 0;
    if (v <= x) {
      best = v;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Offset rules compiled from one VTIMEZONE component. */
export class VTimezone {
  readonly tzid: string;
  private readonly observances: Observance[];

  constructor(comp: Component) {
    const tzid = getProperty(comp, 'TZID')?.value;
    if (tzid === undefined || tzid === '') throw new ICalError('VTIMEZONE has no TZID');
    this.tzid = tzid;
    this.observances = [...getComponents(comp, 'STANDARD'), ...getComponents(comp, 'DAYLIGHT')].map((c) => new Observance(c));
    if (this.observances.length === 0) throw new ICalError(`VTIMEZONE ${tzid} has no STANDARD or DAYLIGHT`);
  }

  offsetAt(utc: number): number {
    let best: Observance | null = null;
    let bestOnset = Number.NEGATIVE_INFINITY;
    for (const o of this.observances) {
      const onset = o.latestAtOrBefore(utc);
      if (onset !== null && onset > bestOnset) {
        bestOnset = onset;
        best = o;
      }
    }
    if (best !== null && bestOnset !== Number.NEGATIVE_INFINITY) return best.offsetTo;
    // Before the first transition: the offset in force before the earliest onset.
    let earliest: Observance | null = null;
    let earliestOnset = Number.POSITIVE_INFINITY;
    for (const o of this.observances) {
      const f = o.firstOnset();
      if (f < earliestOnset) {
        earliestOnset = f;
        earliest = o;
      }
    }
    return (earliest ?? this.observances[0])?.offsetFrom ?? 0;
  }
}

const intlCache = new Map<string, Intl.DateTimeFormat | null>();

function intlFormatter(tzid: string): Intl.DateTimeFormat | null {
  if (intlCache.has(tzid)) return intlCache.get(tzid) ?? null;
  let fmt: Intl.DateTimeFormat | null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      era: 'short',
    });
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    fmt = null;
  }
  if (intlCache.size > 512) intlCache.clear();
  intlCache.set(tzid, fmt);
  return fmt;
}

// Keep Intl inside the years it formats sensibly (and inside Date's range).
const INTL_MIN = localSeconds({ year: 1, month: 1, day: 2, hour: 0, minute: 0, second: 0 });
const INTL_MAX = localSeconds({ year: 9999, month: 12, day: 30, hour: 0, minute: 0, second: 0 });

/** Offset of an IANA zone via Intl, or null when the host does not know the zone. */
export function intlOffsetAt(tzid: string, utcSeconds: number): number | null {
  const fmt = intlFormatter(tzid);
  if (fmt === null) return null;
  const u = Math.min(Math.max(utcSeconds, INTL_MIN), INTL_MAX);
  const parts = fmt.formatToParts(new Date(u * 1000));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  let year = get('year');
  if (parts.find((p) => p.type === 'era')?.value.startsWith('B') === true) year = 1 - year;
  const local = localSeconds({ year, month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute'), second: get('second') });
  if (!Number.isFinite(local)) return null;
  return local - u;
}

export interface TimeZoneResolverOptions {
  /** Fall back to the host's IANA database for a TZID without a VTIMEZONE. Default true. */
  intl?: boolean;
}

/**
 * A resolver over the VTIMEZONEs of a calendar (or several), falling back to Intl. A malformed
 * VTIMEZONE is skipped rather than fatal, so one bad block cannot hide every other event.
 */
export function createTimeZoneResolver(
  calendars: Component | Component[] | null = null,
  options: TimeZoneResolverOptions = {},
): TimeZoneResolver {
  const zones = new Map<string, VTimezone>();
  const list = calendars === null ? [] : Array.isArray(calendars) ? calendars : [calendars];
  const collect = (c: Component): void => {
    for (const vtz of c.name === 'VTIMEZONE' ? [c] : getComponents(c, 'VTIMEZONE')) {
      try {
        const z = new VTimezone(vtz);
        if (!zones.has(z.tzid)) zones.set(z.tzid, z);
      } catch (err) {
        if (!(err instanceof ICalError)) throw err;
        // Malformed VTIMEZONE: fall through to Intl (or UTC) for its TZID.
      }
    }
  };
  for (const c of list) collect(c);
  const intl = options.intl ?? true;
  return {
    offsetAt(tzid, utc) {
      const z = zones.get(tzid);
      if (z !== undefined) return z.offsetAt(utc);
      return intl ? intlOffsetAt(tzid, utc) : null;
    },
  };
}

/**
 * Local wall-clock seconds → UTC seconds under an offset function. For a local time in a DST gap
 * the offset before the transition is used; in an overlap, the first (earlier) instant wins
 * (RFC 5545 §3.3.5).
 */
export function localToUtc(offsetAt: (utc: number) => number, local: number): number {
  const before = offsetAt(local - SECONDS_PER_DAY);
  const after = offsetAt(local + SECONDS_PER_DAY);
  const here = offsetAt(local);
  let best: number | null = null;
  for (const o of [before, after, here]) {
    if (offsetAt(local - o) === o && (best === null || o > best)) best = o;
  }
  return local - (best ?? before);
}

/** Resolve a DATE-TIME to UTC seconds; floating times use `floatingTzid` (null: UTC). */
export function dateTimeToUtc(v: ICalDateTime, resolver: TimeZoneResolver, floatingTzid: string | null = null): number {
  const local = localSeconds(v);
  if (v.utc) return local;
  const tzid = v.tzid ?? floatingTzid;
  if (tzid === null) return local;
  if (resolver.offsetAt(tzid, local) === null) return local;
  return localToUtc((u) => resolver.offsetAt(tzid, u) ?? 0, local);
}
