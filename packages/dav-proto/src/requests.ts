// Request bodies, from a parsed tree to a typed request: PROPFIND (RFC 4918 §9.1), PROPPATCH
// (§9.2), MKCALENDAR (RFC 4791 §5.3.1), extended MKCOL (RFC 5689), and the REPORTs a CalDAV/CardDAV
// server answers — calendar-query and calendar-multiget (RFC 4791 §7.8–7.9), addressbook-query and
// addressbook-multiget (RFC 6352 §8.6–8.7), and sync-collection (RFC 6578 §3.2).
//
// A body that is well-formed XML but not the request it claims to be is a DavRequestError: 400, or
// 403 with the precondition the RFC names (CALDAV:valid-filter, CARDDAV:supported-filter,
// CALDAV:supported-collation, …).
import { DavRequestError } from './errors.js';
import { isCollation, parseUtcDateTime, type Collation, type MatchType, type TextMatch } from './match.js';
import { NS, clark } from './ns.js';
import { attribute, childElement, childElements, textContent, type XmlElement } from './xml.js';

export type PropRequest =
  | { readonly kind: 'allprop'; readonly include: XmlElement[] }
  | { readonly kind: 'propname' }
  | { readonly kind: 'prop'; readonly props: XmlElement[] };

function expectRoot(root: XmlElement, ns: string, local: string): void {
  if (root.ns !== ns || root.local !== local) {
    throw new DavRequestError(400, `expected ${clark(ns, local)}, got ${clark(root.ns, root.local)}`);
  }
}

/** The allprop / propname / prop choice inside a PROPFIND or a REPORT. `fallback` when absent. */
export function parsePropChoice(parent: XmlElement, fallback: PropRequest): PropRequest {
  const prop = childElement(parent, NS.DAV, 'prop');
  const allprop = childElement(parent, NS.DAV, 'allprop');
  const propname = childElement(parent, NS.DAV, 'propname');
  const count = [prop, allprop, propname].filter((x) => x !== undefined).length;
  if (count > 1) throw new DavRequestError(400, 'only one of prop, allprop and propname');
  if (prop !== undefined) return { kind: 'prop', props: childElements(prop) };
  if (propname !== undefined) return { kind: 'propname' };
  if (allprop !== undefined) {
    const include = childElement(parent, NS.DAV, 'include');
    return { kind: 'allprop', include: include === undefined ? [] : childElements(include) };
  }
  return fallback;
}

/** PROPFIND: an empty body means allprop (RFC 4918 §9.1). */
export function parsePropfind(root: XmlElement | null): PropRequest {
  if (root === null) return { kind: 'allprop', include: [] };
  expectRoot(root, NS.DAV, 'propfind');
  const req = parsePropChoice(root, { kind: 'allprop', include: [] });
  if (req.kind === 'prop' && req.props.length === 0) throw new DavRequestError(400, 'empty DAV:prop');
  return req;
}

export interface PropUpdate {
  readonly action: 'set' | 'remove';
  /** The property element: its value for `set`, just its name for `remove`. */
  readonly prop: XmlElement;
}

/** DAV:propertyupdate → the updates, in document order (they apply in order, atomically). */
export function parseProppatch(root: XmlElement): PropUpdate[] {
  expectRoot(root, NS.DAV, 'propertyupdate');
  const out: PropUpdate[] = [];
  for (const op of childElements(root, NS.DAV)) {
    if (op.local !== 'set' && op.local !== 'remove') continue;
    for (const prop of childElements(op, NS.DAV, 'prop')) {
      for (const p of childElements(prop)) out.push({ action: op.local, prop: p });
    }
  }
  if (out.length === 0) throw new DavRequestError(400, 'propertyupdate without a property');
  return out;
}

/**
 * The properties to set on a new collection: MKCALENDAR's `CALDAV:mkcalendar` or extended MKCOL's
 * `DAV:mkcol` (both `set/prop/*`). A null body sets nothing.
 */
export function parseMkcol(root: XmlElement | null, method: 'MKCALENDAR' | 'MKCOL'): XmlElement[] {
  if (root === null) return [];
  if (method === 'MKCALENDAR') expectRoot(root, NS.CALDAV, 'mkcalendar');
  else expectRoot(root, NS.DAV, 'mkcol');
  const props: XmlElement[] = [];
  for (const set of childElements(root, NS.DAV, 'set')) {
    for (const prop of childElements(set, NS.DAV, 'prop')) props.push(...childElements(prop));
  }
  return props;
}

// ---- Filters ----

export interface TimeRange {
  /** UTC milliseconds; null for an open start. */
  readonly start: number | null;
  /** UTC milliseconds; null for an open end. */
  readonly end: number | null;
}

export interface ParamFilter {
  readonly name: string;
  readonly isNotDefined: boolean;
  readonly textMatch: TextMatch | null;
}

export interface PropFilter {
  readonly name: string;
  readonly isNotDefined: boolean;
  readonly timeRange: TimeRange | null;
  /** CalDAV allows one; CardDAV any number, combined by `test`. */
  readonly textMatches: TextMatch[];
  readonly paramFilters: ParamFilter[];
  /** CardDAV's test attribute; CalDAV is always allof. */
  readonly test: 'anyof' | 'allof';
}

export interface CompFilter {
  readonly name: string;
  readonly isNotDefined: boolean;
  readonly timeRange: TimeRange | null;
  readonly propFilters: PropFilter[];
  readonly compFilters: CompFilter[];
}

export interface CardFilter {
  readonly test: 'anyof' | 'allof';
  readonly propFilters: PropFilter[];
}

const MAX_FILTER_DEPTH = 8;
const VALID_FILTER = clark(NS.CALDAV, 'valid-filter');

function nameAttr(e: XmlElement, condition: string): string {
  const name = attribute(e, 'name');
  if (name === undefined || name.trim() === '') throw new DavRequestError(403, `${e.local} without a name`, condition);
  return name.trim().toUpperCase();
}

function parseTextMatch(e: XmlElement, ns: string, defaultCollation: Collation, allowMatchType: boolean): TextMatch {
  const collation = attribute(e, 'collation') ?? defaultCollation;
  if (!isCollation(collation)) throw new DavRequestError(403, `unsupported collation ${collation.slice(0, 40)}`, clark(ns, 'supported-collation'));
  const negateRaw = attribute(e, 'negate-condition') ?? 'no';
  if (negateRaw !== 'yes' && negateRaw !== 'no') throw new DavRequestError(400, 'negate-condition must be yes or no');
  let matchType: MatchType = 'contains';
  if (allowMatchType) {
    const mt = attribute(e, 'match-type') ?? 'contains';
    if (mt !== 'equals' && mt !== 'contains' && mt !== 'starts-with' && mt !== 'ends-with') {
      throw new DavRequestError(403, `unsupported match-type ${mt.slice(0, 20)}`, clark(NS.CARDDAV, 'supported-filter'));
    }
    matchType = mt;
  }
  return { value: textContent(e), collation, negate: negateRaw === 'yes', matchType };
}

function parseTimeRange(e: XmlElement | undefined): TimeRange | null {
  if (e === undefined) return null;
  const s = attribute(e, 'start');
  const en = attribute(e, 'end');
  if (s === undefined && en === undefined) throw new DavRequestError(403, 'time-range without start or end', VALID_FILTER);
  const start = s === undefined ? null : parseUtcDateTime(s, VALID_FILTER);
  const end = en === undefined ? null : parseUtcDateTime(en, VALID_FILTER);
  if (start !== null && end !== null && end <= start) throw new DavRequestError(403, 'time-range end is not after its start', VALID_FILTER);
  return { start, end };
}

function parseParamFilter(e: XmlElement, ns: string, collation: Collation, card: boolean): ParamFilter {
  const condition = card ? clark(NS.CARDDAV, 'supported-filter') : VALID_FILTER;
  const tm = childElement(e, ns, 'text-match');
  return {
    name: nameAttr(e, condition),
    isNotDefined: childElement(e, ns, 'is-not-defined') !== undefined,
    textMatch: tm === undefined ? null : parseTextMatch(tm, ns, collation, card),
  };
}

function parsePropFilter(e: XmlElement, ns: string, collation: Collation, card: boolean): PropFilter {
  const condition = card ? clark(NS.CARDDAV, 'supported-filter') : VALID_FILTER;
  const test = attribute(e, 'test') ?? 'anyof';
  if (test !== 'anyof' && test !== 'allof') throw new DavRequestError(400, 'test must be anyof or allof');
  const textMatches = childElements(e, ns, 'text-match').map((t) => parseTextMatch(t, ns, collation, card));
  if (!card && textMatches.length > 1) throw new DavRequestError(403, 'a CalDAV prop-filter has at most one text-match', VALID_FILTER);
  return {
    name: nameAttr(e, condition),
    isNotDefined: childElement(e, ns, 'is-not-defined') !== undefined,
    timeRange: card ? null : parseTimeRange(childElement(e, ns, 'time-range')),
    textMatches,
    paramFilters: childElements(e, ns, 'param-filter').map((p) => parseParamFilter(p, ns, collation, card)),
    test: card ? test : 'allof',
  };
}

function parseCompFilter(e: XmlElement, depth: number): CompFilter {
  if (depth > MAX_FILTER_DEPTH) throw new DavRequestError(403, 'comp-filter nested too deeply', VALID_FILTER);
  return {
    name: nameAttr(e, VALID_FILTER),
    isNotDefined: childElement(e, NS.CALDAV, 'is-not-defined') !== undefined,
    timeRange: parseTimeRange(childElement(e, NS.CALDAV, 'time-range')),
    propFilters: childElements(e, NS.CALDAV, 'prop-filter').map((p) => parsePropFilter(p, NS.CALDAV, 'i;ascii-casemap', false)),
    compFilters: childElements(e, NS.CALDAV, 'comp-filter').map((c) => parseCompFilter(c, depth + 1)),
  };
}

// ---- Reports ----

export interface CalendarQuery {
  readonly kind: 'calendar-query';
  readonly props: PropRequest;
  /** The top-level comp-filter, always VCALENDAR. */
  readonly filter: CompFilter;
}

export interface Multiget {
  readonly kind: 'calendar-multiget' | 'addressbook-multiget';
  readonly props: PropRequest;
  readonly hrefs: string[];
}

export interface AddressbookQuery {
  readonly kind: 'addressbook-query';
  readonly props: PropRequest;
  readonly filter: CardFilter;
  readonly limit: number | null;
}

export interface SyncCollection {
  readonly kind: 'sync-collection';
  /** '' for an initial sync. */
  readonly syncToken: string;
  readonly level: '1' | 'infinite';
  readonly limit: number | null;
  readonly props: PropRequest;
}

export interface UnsupportedReport {
  readonly kind: 'unsupported';
  /** Clark name of the report's root element. */
  readonly name: string;
}

export type Report = CalendarQuery | Multiget | AddressbookQuery | SyncCollection | UnsupportedReport;

export const MAX_MULTIGET_HREFS = 5000;

function parseLimit(parent: XmlElement, ns: string): number | null {
  const limit = childElement(parent, ns, 'limit');
  if (limit === undefined) return null;
  const n = childElement(limit, ns, 'nresults');
  const v = n === undefined ? '' : textContent(n).trim();
  if (!/^[0-9]{1,9}$/.test(v)) throw new DavRequestError(400, 'limit/nresults must be a non-negative integer');
  return Number(v);
}

function parseHrefs(root: XmlElement): string[] {
  const hrefs = childElements(root, NS.DAV, 'href').map((h) => textContent(h).trim());
  if (hrefs.length > MAX_MULTIGET_HREFS) throw new DavRequestError(403, `more than ${String(MAX_MULTIGET_HREFS)} hrefs in one multiget`);
  return hrefs;
}

/** A REPORT body. An unknown report comes back as `unsupported` for the caller to 403. */
export function parseReport(root: XmlElement): Report {
  const noProps: PropRequest = { kind: 'prop', props: [] };
  if (root.ns === NS.CALDAV && root.local === 'calendar-query') {
    const filter = childElement(root, NS.CALDAV, 'filter');
    if (filter === undefined) throw new DavRequestError(403, 'calendar-query without a filter', VALID_FILTER);
    const top = childElements(filter, NS.CALDAV, 'comp-filter');
    const first = top[0];
    if (first === undefined || top.length !== 1) throw new DavRequestError(403, 'filter must hold exactly one comp-filter', VALID_FILTER);
    const parsed = parseCompFilter(first, 1);
    if (parsed.name !== 'VCALENDAR') throw new DavRequestError(403, 'the top-level comp-filter must be VCALENDAR', VALID_FILTER);
    return { kind: 'calendar-query', props: parsePropChoice(root, noProps), filter: parsed };
  }
  if (root.ns === NS.CALDAV && root.local === 'calendar-multiget') {
    return { kind: 'calendar-multiget', props: parsePropChoice(root, noProps), hrefs: parseHrefs(root) };
  }
  if (root.ns === NS.CARDDAV && root.local === 'addressbook-multiget') {
    return { kind: 'addressbook-multiget', props: parsePropChoice(root, noProps), hrefs: parseHrefs(root) };
  }
  if (root.ns === NS.CARDDAV && root.local === 'addressbook-query') {
    const filter = childElement(root, NS.CARDDAV, 'filter');
    const test = filter === undefined ? 'anyof' : (attribute(filter, 'test') ?? 'anyof');
    if (test !== 'anyof' && test !== 'allof') throw new DavRequestError(400, 'test must be anyof or allof');
    const propFilters =
      filter === undefined ? [] : childElements(filter, NS.CARDDAV, 'prop-filter').map((p) => parsePropFilter(p, NS.CARDDAV, 'i;unicode-casemap', true));
    return { kind: 'addressbook-query', props: parsePropChoice(root, noProps), filter: { test, propFilters }, limit: parseLimit(root, NS.CARDDAV) };
  }
  if (root.ns === NS.DAV && root.local === 'sync-collection') {
    const tokenEl = childElement(root, NS.DAV, 'sync-token');
    const levelEl = childElement(root, NS.DAV, 'sync-level');
    const level = levelEl === undefined ? '1' : textContent(levelEl).trim().toLowerCase();
    if (level !== '1' && level !== 'infinite') throw new DavRequestError(400, 'sync-level must be 1 or infinite');
    return {
      kind: 'sync-collection',
      syncToken: tokenEl === undefined ? '' : textContent(tokenEl).trim(),
      level,
      limit: parseLimit(root, NS.DAV),
      props: parsePropChoice(root, noProps),
    };
  }
  return { kind: 'unsupported', name: clark(root.ns, root.local) };
}
