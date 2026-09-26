// Recurrence-set expansion into a time range (RFC 5545 §3.8.5, RFC 4791 §9.9 time-range semantics).
//
// Recurrence set = {DTSTART} ∪ RRULE ∪ RDATE − EXDATE, then RECURRENCE-ID overrides replace (and may
// move) individual instances. Every expansion is bounded twice: by `maxInstances` (the result is
// truncated, sorted, to the earliest ones) and by `maxIterations` (a shared budget every RRULE
// period and candidate is charged to). Hitting either sets `truncated: true`; nothing loops forever.
//
// Documented choices:
// - DTSTART is always the first instance and counts toward COUNT, even if the rule would not
//   produce it (§3.8.5.3).
// - A TZID nobody can resolve (no VTIMEZONE, unknown to Intl) is treated as UTC.
// - Floating times are resolved in `floatingTzid` (default: UTC).
// - RECURRENCE-ID;RANGE=THISANDFUTURE is treated as an override of that one instance.
// - A component without DTSTART (e.g. a VTODO with only DUE) has no instances.
import { daysFromCivil, localSeconds, partsFromLocalSeconds, SECONDS_PER_DAY } from './civil.js';
import { getProperties, getProperty, type Component, type Property } from './component.js';
import { ICalError } from './errors.js';
import { createBudget, iterateRecur, parseRecur, type Budget, type StopReason } from './recur.js';
import { createTimeZoneResolver, dateTimeToUtc, type TimeZoneResolver } from './timezone.js';
import {
  durationParts,
  formatDate,
  formatDateTime,
  parseDuration,
  propertyDate,
  propertyDateList,
  type ICalDateTime,
  type ICalDateValue,
  type ICalPeriod,
} from './values.js';

export const DEFAULT_MAX_INSTANCES = 1000;
export const DEFAULT_MAX_ITERATIONS = 200_000;

export interface ExpandOptions {
  /** Range start (inclusive), as a Date or UTC milliseconds. */
  start: Date | number;
  /** Range end (exclusive), as a Date or UTC milliseconds. */
  end: Date | number;
  /** Cap on instances returned. Default 1000. */
  maxInstances?: number;
  /** Cap on work: RRULE periods + candidates examined, across the whole call. Default 200 000. */
  maxIterations?: number;
  /** Time zone resolver; defaults to one built from the calendar's VTIMEZONEs plus Intl. */
  timezones?: TimeZoneResolver;
  /** Zone for floating times; null (the default) means UTC. */
  floatingTzid?: string | null;
}

export interface Instance {
  /** UID of the master (or override), or null. */
  uid: string | null;
  /** Start and end in UTC milliseconds. `end >= start`. */
  start: number;
  end: number;
  /**
   * This instance's RECURRENCE-ID in the master DTSTART's form: `YYYYMMDD` for all-day,
   * `YYYYMMDDTHHMMSSZ` for UTC, local `YYYYMMDDTHHMMSS` for TZID and floating times.
   */
  recurrenceId: string;
  /** All-day (DATE) instance. */
  allDay: boolean;
  /** The component supplying this instance's properties: the master, or an override. */
  component: Component;
  override: boolean;
}

export interface ExpandResult {
  instances: Instance[];
  /** True if `maxInstances` or `maxIterations` cut the expansion short. */
  truncated: boolean;
}

interface Ctx {
  resolver: TimeZoneResolver;
  floatingTzid: string | null;
  budget: Budget;
  /** The range in UTC milliseconds, exactly as given. */
  rangeStartMs: number;
  rangeEndMs: number;
  /** The range widened to whole seconds, for iterator hints. */
  rangeStart: number;
  rangeEnd: number;
  maxInstances: number;
  truncated: boolean;
}

const ms = (d: Date | number): number => (typeof d === 'number' ? d : d.getTime());

function localOfValue(v: ICalDateValue): number {
  return v.type === 'date' ? daysFromCivil(v.year, v.month, v.day) * SECONDS_PER_DAY : localSeconds(v);
}

/** Resolves local wall-clock seconds in the zone of a DTSTART to UTC seconds. */
function zoneOf(v: ICalDateValue, ctx: Ctx): (local: number) => number {
  if (v.type === 'date-time' && v.utc) return (l) => l;
  const tzid = v.type === 'date-time' ? (v.tzid ?? ctx.floatingTzid) : ctx.floatingTzid;
  if (tzid === null) return (l) => l;
  return (l) => {
    const p = partsFromLocalSeconds(l);
    return dateTimeToUtc({ type: 'date-time', ...p, utc: false, tzid }, ctx.resolver, null);
  };
}

function toUtcSeconds(v: ICalDateValue, ctx: Ctx): number {
  if (v.type === 'date') return zoneOf(v, ctx)(localOfValue(v));
  return dateTimeToUtc(v, ctx.resolver, ctx.floatingTzid);
}

interface Span {
  /** Nominal days added in local time, then exact seconds added in UTC. */
  days: number;
  seconds: number;
}

function spanOf(comp: Component, dtstart: ICalDateValue, ctx: Ctx): Span {
  const endProp = getProperty(comp, comp.name === 'VTODO' ? 'DUE' : 'DTEND');
  if (endProp !== undefined) {
    const end = propertyDate(endProp);
    if (dtstart.type === 'date') {
      const days = Math.round((localOfValue(end) - localOfValue(dtstart)) / SECONDS_PER_DAY);
      return { days: Math.max(0, days), seconds: 0 };
    }
    // §3.8.5.3: a DTEND gives every instance the same *exact* duration. When DTSTART or DTEND is a
    // local time that does not exist (a spring-forward gap), §3.3.5 moves it by the gap's width, and
    // the exact difference no longer describes the event — 02:30–03:30 on the change day would
    // become 07:30Z–07:30Z. In that case, and only when both ends share a zone, use the
    // wall-clock difference as the exact duration instead.
    if (end.type === 'date-time' && sameZone(dtstart, end, ctx) && (inGap(dtstart, ctx) || inGap(end, ctx))) {
      return { days: 0, seconds: Math.max(0, localSeconds(end) - localSeconds(dtstart)) };
    }
    return { days: 0, seconds: Math.max(0, toUtcSeconds(end, ctx) - toUtcSeconds(dtstart, ctx)) };
  }
  const durProp = getProperty(comp, 'DURATION');
  if (durProp !== undefined) {
    const d = durationParts(parseDuration(durProp.value));
    return { days: d.days, seconds: d.seconds };
  }
  return dtstart.type === 'date' && comp.name === 'VEVENT' ? { days: 1, seconds: 0 } : { days: 0, seconds: 0 };
}

function effectiveTzid(v: ICalDateTime, ctx: Ctx): string | null {
  return v.utc ? null : (v.tzid ?? ctx.floatingTzid);
}

function sameZone(a: ICalDateTime, b: ICalDateTime, ctx: Ctx): boolean {
  return a.utc === b.utc && effectiveTzid(a, ctx) === effectiveTzid(b, ctx);
}

/** True when a zoned local time does not exist (it falls in a spring-forward gap). */
function inGap(v: ICalDateTime, ctx: Ctx): boolean {
  const tzid = effectiveTzid(v, ctx);
  if (tzid === null) return false;
  const utc = dateTimeToUtc(v, ctx.resolver, ctx.floatingTzid);
  const offset = ctx.resolver.offsetAt(tzid, utc);
  return offset !== null && utc + offset !== localSeconds(v);
}

function endOf(startLocal: number, startUtc: number, span: Span, zone: (l: number) => number): number {
  const base = span.days === 0 ? startUtc : zone(startLocal + span.days * SECONDS_PER_DAY);
  return Math.max(startUtc, base + span.seconds);
}

function spanUpperBound(span: Span): number {
  return Math.abs(span.days) * SECONDS_PER_DAY + Math.abs(span.seconds) + SECONDS_PER_DAY;
}

/** RFC 4791 §9.9: does [start, end) (UTC seconds) overlap the range? Zero-length: start in range. */
function overlaps(start: number, end: number, ctx: Ctx): boolean {
  const s = start * 1000;
  const e = end * 1000;
  if (e > s) return s < ctx.rangeEndMs && e > ctx.rangeStartMs;
  return s >= ctx.rangeStartMs && s < ctx.rangeEndMs;
}

function recurrenceIdString(local: number, dtstart: ICalDateValue, utc: number): string {
  const p = partsFromLocalSeconds(dtstart.type === 'date-time' && dtstart.utc ? utc : local);
  if (dtstart.type === 'date') return formatDate(p);
  return formatDateTime({ ...p, utc: dtstart.utc });
}

/**
 * How a master identifies its instances. RECURRENCE-ID is a wall-clock value for TZID and floating
 * masters, so those key by local time (two local times that fall into one DST gap stay two
 * instances); UTC masters key by UTC second; all-day masters by day.
 */
interface MasterKeying {
  isDate: boolean;
  byLocal: boolean;
  tzid: string | null;
  toLocal: (utc: number) => number;
}

function keyingOf(dtstart: ICalDateValue, ctx: Ctx): MasterKeying {
  const utcForm = dtstart.type === 'date-time' && dtstart.utc;
  const tzid = dtstart.type === 'date-time' ? (dtstart.utc ? null : (dtstart.tzid ?? ctx.floatingTzid)) : ctx.floatingTzid;
  return {
    isDate: dtstart.type === 'date',
    byLocal: !utcForm,
    tzid,
    toLocal: (u) => (tzid === null ? u : u + (ctx.resolver.offsetAt(tzid, u) ?? 0)),
  };
}

function keyOf(v: ICalDateValue, mk: MasterKeying, ctx: Ctx): string {
  if (mk.isDate) return `D${String(Math.floor(localOfValue(v) / SECONDS_PER_DAY))}`;
  if (!mk.byLocal) return `T${String(toUtcSeconds(v, ctx))}`;
  // A floating value, or one in the master's own zone, already is master-local wall-clock time.
  if (v.type === 'date' || (!v.utc && (v.tzid === null || v.tzid === mk.tzid))) return `L${String(localOfValue(v))}`;
  return `L${String(mk.toLocal(toUtcSeconds(v, ctx)))}`;
}

function candidateKey(local: number, utc: number, mk: MasterKeying): string {
  if (mk.isDate) return `D${String(Math.floor(local / SECONDS_PER_DAY))}`;
  return mk.byLocal ? `L${String(local)}` : `T${String(utc)}`;
}

const uidOf = (c: Component): string | null => getProperty(c, 'UID')?.value ?? null;

interface Candidate {
  key: string;
  local: number;
  utc: number;
  /** Explicit end (RDATE;VALUE=PERIOD), UTC seconds. */
  end: number | null;
}

function* rdateCandidates(props: Property[], mk: MasterKeying, ctx: Ctx): Generator<Candidate> {
  for (const p of props) {
    for (const v of propertyDateList(p)) {
      const start: ICalDateValue = 'start' in v ? v.start : v;
      const utc = toUtcSeconds(start, ctx);
      let end: number | null = null;
      if ('start' in v) {
        const period: ICalPeriod = v;
        if (period.end !== null) end = Math.max(utc, toUtcSeconds(period.end, ctx));
        else if (period.duration !== null) {
          const d = durationParts(period.duration);
          end = Math.max(utc, utc + d.days * SECONDS_PER_DAY + d.seconds);
        }
      }
      yield { key: keyOf(start, mk, ctx), local: localOfValue(start), utc, end };
    }
  }
}

/** Expand one master component (with its overrides) into `out`. */
function expandMaster(master: Component, overrides: Component[], ctx: Ctx, out: Instance[]): void {
  const dtProp = getProperty(master, 'DTSTART');
  if (dtProp === undefined) return;
  const dtstart = propertyDate(dtProp);
  const isDate = dtstart.type === 'date';
  const zone = zoneOf(dtstart, ctx);
  const mk = keyingOf(dtstart, ctx);
  const span = spanOf(master, dtstart, ctx);
  const uid = uidOf(master);

  const overrideKeys = new Map<string, Component>();
  for (const o of overrides) {
    const rid = getProperty(o, 'RECURRENCE-ID');
    if (rid === undefined) continue;
    overrideKeys.set(keyOf(propertyDate(rid), mk, ctx), o);
  }
  const exdates = new Set<string>();
  for (const p of getProperties(master, 'EXDATE')) {
    for (const v of propertyDateList(p)) exdates.add(keyOf('start' in v ? v.start : v, mk, ctx));
  }

  const seen = new Set<string>();
  let inRange = 0;
  const consider = (c: Candidate): void => {
    if (seen.has(c.key)) return;
    seen.add(c.key);
    if (exdates.has(c.key) || overrideKeys.has(c.key)) return;
    const end = c.end ?? endOf(c.local, c.utc, span, zone);
    if (!overlaps(c.utc, end, ctx)) return;
    inRange++;
    out.push({
      uid,
      start: c.utc * 1000,
      end: end * 1000,
      recurrenceId: recurrenceIdString(c.local, dtstart, c.utc),
      allDay: isDate,
      component: master,
      override: false,
    });
  };

  const dtLocal = localOfValue(dtstart);
  const rrules = getProperties(master, 'RRULE');
  if (rrules.length === 0) {
    const utc = toUtcSeconds(dtstart, ctx);
    consider({ key: keyOf(dtstart, mk, ctx), local: dtLocal, utc, end: null });
  }
  // Several RRULEs are deprecated (RFC 5545) but still legal to receive; union them.
  for (const rr of rrules) {
    const rule = parseRecur(rr.value);
    const until = rule.until;
    let isAfterUntil: (l: number) => boolean = () => false;
    if (until !== null) {
      if (until.type === 'date') {
        const lastDay = daysFromCivil(until.year, until.month, until.day);
        isAfterUntil = (l) => Math.floor(l / SECONDS_PER_DAY) > lastDay;
      } else if (until.utc) {
        const u = localSeconds(until);
        isAfterUntil = (l) => zone(l) > u;
      } else {
        const u = localSeconds(until);
        isAfterUntil = (l) => l > u;
      }
    }
    const slack = 2 * SECONDS_PER_DAY;
    const iter = iterateRecur(rule, {
      dtstart: dtLocal,
      dateOnly: isDate,
      isAfterUntil,
      budget: ctx.budget,
      from: ctx.rangeStart - spanUpperBound(span) - slack,
      to: ctx.rangeEnd + slack,
    });
    let stop: StopReason | undefined;
    for (;;) {
      const n = iter.next();
      if (n.done === true) {
        stop = n.value;
        break;
      }
      const local = n.value;
      const utc = zone(local);
      const key = candidateKey(local, utc, mk);
      consider({ key, local, utc, end: null });
      if (inRange > ctx.maxInstances) {
        ctx.truncated = true;
        break;
      }
    }
    if (stop === 'cap') ctx.truncated = true;
  }
  for (const c of rdateCandidates(getProperties(master, 'RDATE'), mk, ctx)) {
    if (!ctx.budget.exhausted) consider(c);
  }

  for (const o of overrides) emitOverride(o, dtstart, span, ctx, out);
}

function emitOverride(o: Component, masterStart: ICalDateValue | null, masterSpan: Span | null, ctx: Ctx, out: Instance[]): void {
  const ridProp = getProperty(o, 'RECURRENCE-ID');
  const dtProp = getProperty(o, 'DTSTART') ?? ridProp;
  if (dtProp === undefined || ridProp === undefined) return;
  const dtstart = propertyDate(dtProp);
  const rid = propertyDate(ridProp);
  const hasOwnEnd = getProperty(o, o.name === 'VTODO' ? 'DUE' : 'DTEND') !== undefined || getProperty(o, 'DURATION') !== undefined;
  const span = hasOwnEnd || masterSpan === null ? spanOf(o, dtstart, ctx) : masterSpan;
  const utc = toUtcSeconds(dtstart, ctx);
  const end = endOf(localOfValue(dtstart), utc, span, zoneOf(dtstart, ctx));
  if (!overlaps(utc, end, ctx)) return;
  // Report the RECURRENCE-ID in the master's form, so it names the same instance the master would.
  const form = masterStart ?? rid;
  const ridUtc = toUtcSeconds(rid, ctx);
  const ridLocal = localOfValue(rid);
  const sameZone =
    form.type === 'date' || rid.type === 'date' || (form.utc === rid.utc && form.tzid === rid.tzid);
  const recurrenceId =
    form.type === 'date-time' && form.utc
      ? recurrenceIdString(ridUtc, form, ridUtc)
      : recurrenceIdString(sameZone ? ridLocal : ridUtc, form, ridUtc);
  out.push({
    uid: uidOf(o),
    start: utc * 1000,
    end: end * 1000,
    recurrenceId,
    allDay: dtstart.type === 'date',
    component: o,
    override: true,
  });
}

function finish(out: Instance[], ctx: Ctx): ExpandResult {
  out.sort((a, b) => a.start - b.start || (a.uid ?? '').localeCompare(b.uid ?? '') || a.recurrenceId.localeCompare(b.recurrenceId));
  // Two sources can name the same instance (an override whose master also produced it is
  // suppressed above; this guards overrides duplicated in the input).
  const unique: Instance[] = [];
  const seen = new Set<string>();
  for (const i of out) {
    const k = `${i.uid ?? ''}\u0000${i.recurrenceId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(i);
  }
  if (unique.length > ctx.maxInstances) {
    ctx.truncated = true;
    unique.length = ctx.maxInstances;
  }
  if (ctx.budget.exhausted) ctx.truncated = true;
  return { instances: unique, truncated: ctx.truncated };
}

function makeCtx(calendar: Component | null, options: ExpandOptions): Ctx {
  const maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!(maxInstances >= 0) || !(maxIterations >= 0)) throw new ICalError('maxInstances and maxIterations must be non-negative');
  const s = ms(options.start);
  const e = ms(options.end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) throw new ICalError('expansion range must be finite');
  return {
    resolver: options.timezones ?? createTimeZoneResolver(calendar),
    floatingTzid: options.floatingTzid ?? null,
    budget: createBudget(maxIterations),
    rangeStartMs: s,
    rangeEndMs: e,
    rangeStart: Math.floor(s / 1000),
    rangeEnd: Math.ceil(e / 1000),
    maxInstances,
    truncated: false,
  };
}

const RECURRING = new Set(['VEVENT', 'VTODO', 'VJOURNAL']);

/**
 * Expand every VEVENT/VTODO/VJOURNAL in a VCALENDAR into the instances overlapping
 * [start, end), sorted by start. Overrides are matched to their master by UID and RECURRENCE-ID.
 */
export function expandCalendar(calendar: Component, options: ExpandOptions): ExpandResult {
  const ctx = makeCtx(calendar, options);
  const out: Instance[] = [];
  const kids = calendar.name === 'VCALENDAR' ? calendar.components : [calendar];
  const groups = new Map<string, { masters: Component[]; overrides: Component[] }>();
  let anon = 0;
  for (const c of kids) {
    if (!RECURRING.has(c.name)) continue;
    const uid = uidOf(c);
    const key = `${c.name}\u0000${uid ?? `\u0001${String(anon++)}`}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { masters: [], overrides: [] };
      groups.set(key, g);
    }
    if (getProperty(c, 'RECURRENCE-ID') === undefined) g.masters.push(c);
    else g.overrides.push(c);
  }
  for (const g of groups.values()) {
    if (ctx.budget.exhausted) {
      ctx.truncated = true;
      break;
    }
    const [master, ...extraMasters] = g.masters;
    if (master === undefined) {
      for (const o of g.overrides) emitOverride(o, null, null, ctx, out);
      continue;
    }
    expandMaster(master, g.overrides, ctx, out);
    // Duplicate masters for one UID are invalid; expand them independently rather than drop data.
    for (const m of extraMasters) expandMaster(m, [], ctx, out);
  }
  return finish(out, ctx);
}

/** Expand a single component (plus any overrides you pass) into [start, end). */
export function expandComponent(master: Component, options: ExpandOptions & { overrides?: Component[]; calendar?: Component }): ExpandResult {
  const ctx = makeCtx(options.calendar ?? null, options);
  const out: Instance[] = [];
  expandMaster(master, options.overrides ?? [], ctx, out);
  return finish(out, ctx);
}

export interface OccurrencesOptions {
  /** Stop after this many values (default 1000). */
  maxInstances?: number;
  maxIterations?: number;
  /** Only values strictly before this local date-time / date. */
  before?: ICalDateValue;
  timezones?: TimeZoneResolver;
}

export interface OccurrencesResult {
  /** Occurrences in DTSTART's form (DATE or DATE-TIME with DTSTART's zone), ascending, DTSTART first. */
  values: ICalDateValue[];
  stoppedBy: StopReason | 'max';
}

/**
 * The raw occurrence sequence of DTSTART + one RRULE, in local time, with no range or RDATE/EXDATE:
 * what §3.8.5.3's examples list. UNTIL in UTC is resolved through DTSTART's zone.
 */
export function occurrences(dtstart: ICalDateValue, rrule: string, options: OccurrencesOptions = {}): OccurrencesResult {
  const rule = parseRecur(rrule);
  const max = options.maxInstances ?? DEFAULT_MAX_INSTANCES;
  const ctx = makeCtx(null, { start: 0, end: 0, maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS, ...(options.timezones ? { timezones: options.timezones } : {}) });
  const zone = zoneOf(dtstart, ctx);
  const until = rule.until;
  const isDate = dtstart.type === 'date';
  let isAfterUntil: (l: number) => boolean = () => false;
  if (until !== null) {
    if (until.type === 'date') {
      const lastDay = daysFromCivil(until.year, until.month, until.day);
      isAfterUntil = (l) => Math.floor(l / SECONDS_PER_DAY) > lastDay;
    } else {
      const u = localSeconds(until);
      isAfterUntil = until.utc ? (l) => zone(l) > u : (l) => l > u;
    }
  }
  const beforeLocal = options.before === undefined ? Number.POSITIVE_INFINITY : localOfValue(options.before);
  const iter = iterateRecur(rule, { dtstart: localOfValue(dtstart), dateOnly: isDate, isAfterUntil, budget: ctx.budget });
  const values: ICalDateValue[] = [];
  for (;;) {
    if (values.length >= max) return { values, stoppedBy: 'max' };
    const n = iter.next();
    if (n.done === true) return { values, stoppedBy: n.value };
    if (n.value >= beforeLocal) return { values, stoppedBy: 'range' };
    const p = partsFromLocalSeconds(n.value);
    values.push(
      isDate
        ? { type: 'date', year: p.year, month: p.month, day: p.day }
        : ({ type: 'date-time', ...p, utc: dtstart.utc, tzid: dtstart.tzid } satisfies ICalDateTime),
    );
  }
}
