// calendar-query (RFC 4791 §9.7) and addressbook-query (RFC 6352 §10.5) evaluated against one
// stored object.
//
// Time ranges use @postroom/ical's expandCalendar, so a recurring event matches a range any of its
// instances overlaps — overrides (RECURRENCE-ID) and EXDATEs included. Documented choices:
//   - A VTODO with no DTSTART falls back to RFC 4791 §9.9's table on DUE; with neither, it matches.
//   - A time-range on VALARM or VFREEBUSY matches (a superset; no client this server targets sends one).
//   - An expansion cut short by its caps counts the instances it produced.
//   - Floating times are read as UTC (as expandCalendar does).
import type { CardFilter, CompFilter, ParamFilter, PropFilter, TimeRange } from '@postroom/dav-proto';
import { textMatches } from '@postroom/dav-proto';
import {
  createTimeZoneResolver,
  dateTimeToUtc,
  expandCalendar,
  getProperties,
  getProperty,
  ICalError,
  propertyDate,
  unescapeText,
  type Component,
  type ICalDateValue,
  type Instance,
  type Property,
  type TimeZoneResolver,
} from '@postroom/ical';
import { unescapeText as unescapeCardText, type VCard, type VCardProperty } from '@postroom/vcard';

// Open ends of a time-range: year 1 and year 9999.
const MIN_MS = -62_135_596_800_000;
const MAX_MS = 253_402_300_799_000;

interface Ctx {
  readonly root: Component;
  resolver: TimeZoneResolver | null;
  readonly expansions: Map<string, Instance[]>;
}

function resolverOf(ctx: Ctx): TimeZoneResolver {
  ctx.resolver ??= createTimeZoneResolver(ctx.root);
  return ctx.resolver;
}

function instancesIn(ctx: Ctx, range: TimeRange): Instance[] {
  const start = range.start ?? MIN_MS;
  const end = range.end ?? MAX_MS;
  const key = `${String(start)}/${String(end)}`;
  let hit = ctx.expansions.get(key);
  if (hit === undefined) {
    try {
      hit = expandCalendar(ctx.root, { start, end, maxInstances: 1000, timezones: resolverOf(ctx) }).instances;
    } catch (err) {
      if (!(err instanceof ICalError)) throw err;
      hit = [];
    }
    ctx.expansions.set(key, hit);
  }
  return hit;
}

function toUtcMs(v: ICalDateValue, ctx: Ctx): number {
  if (v.type === 'date') return Date.UTC(v.year, v.month - 1, v.day);
  return dateTimeToUtc(v, resolverOf(ctx), null) * 1000;
}

function inRange(ms: number, range: TimeRange): boolean {
  return (range.start === null || ms >= range.start) && (range.end === null || ms < range.end);
}

function componentOverlaps(c: Component, range: TimeRange, ctx: Ctx): boolean {
  if (c.name === 'VEVENT' || c.name === 'VTODO' || c.name === 'VJOURNAL') {
    if (getProperty(c, 'DTSTART') !== undefined) return instancesIn(ctx, range).some((i) => i.component === c);
    if (c.name === 'VTODO') {
      const due = getProperty(c, 'DUE');
      if (due === undefined) return true;
      try {
        const d = toUtcMs(propertyDate(due), ctx);
        // (start <= DUE) AND (end > DUE), RFC 4791 §9.9.
        return (range.start === null || range.start <= d) && (range.end === null || range.end > d);
      } catch (err) {
        if (err instanceof ICalError) return false;
        throw err;
      }
    }
    return false;
  }
  return true;
}

function paramMatches(params: Record<string, string[]>, pf: ParamFilter): boolean {
  const values = params[pf.name];
  if (pf.isNotDefined) return values === undefined;
  if (values === undefined) return false;
  const tm = pf.textMatch;
  return tm === null || values.some((v) => textMatches(v, tm));
}

function icalPropMatches(p: Property, pf: PropFilter, ctx: Ctx): boolean {
  if (pf.timeRange !== null) {
    const range = pf.timeRange;
    try {
      if (!inRange(toUtcMs(propertyDate(p), ctx), range)) return false;
    } catch (err) {
      if (err instanceof ICalError) return false;
      throw err;
    }
  }
  const value = unescapeText(p.value);
  return pf.textMatches.every((tm) => textMatches(value, tm)) && pf.paramFilters.every((f) => paramMatches(p.params, f));
}

function propFilterMatches(c: Component, pf: PropFilter, ctx: Ctx): boolean {
  const props = getProperties(c, pf.name);
  if (pf.isNotDefined) return props.length === 0;
  return props.some((p) => icalPropMatches(p, pf, ctx));
}

function compFilterMatches(parent: Component, f: CompFilter, ctx: Ctx): boolean {
  const children = parent.components.filter((c) => c.name === f.name);
  if (f.isNotDefined) return children.length === 0;
  return children.some((c) => componentMatches(c, f, ctx));
}

function componentMatches(c: Component, f: CompFilter, ctx: Ctx): boolean {
  if (f.timeRange !== null && !componentOverlaps(c, f.timeRange, ctx)) return false;
  return f.propFilters.every((pf) => propFilterMatches(c, pf, ctx)) && f.compFilters.every((cf) => compFilterMatches(c, cf, ctx));
}

/** Does a stored calendar object satisfy a calendar-query filter (whose top level is VCALENDAR)? */
export function calendarMatches(root: Component, filter: CompFilter): boolean {
  if (root.name !== filter.name) return filter.isNotDefined;
  if (filter.isNotDefined) return false;
  const ctx: Ctx = { root, resolver: null, expansions: new Map() };
  return componentMatches(root, { ...filter, timeRange: null }, ctx);
}

function cardPropMatches(p: VCardProperty, pf: PropFilter): boolean {
  const value = unescapeCardText(p.value);
  const tests: boolean[] = [...pf.textMatches.map((tm) => textMatches(value, tm)), ...pf.paramFilters.map((f) => paramMatches(p.params, f))];
  if (tests.length === 0) return true;
  return pf.test === 'allof' ? tests.every(Boolean) : tests.some(Boolean);
}

/** Does a vCard satisfy an addressbook-query filter? An empty filter matches every card. */
export function cardMatches(card: VCard, filter: CardFilter): boolean {
  if (filter.propFilters.length === 0) return true;
  const results = filter.propFilters.map((pf) => {
    const props = card.properties.filter((p) => p.name === pf.name);
    if (pf.isNotDefined) return props.length === 0;
    return props.some((p) => cardPropMatches(p, pf));
  });
  return filter.test === 'allof' ? results.every(Boolean) : results.some(Boolean);
}
