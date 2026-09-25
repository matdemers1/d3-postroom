// Translates the openspf.org rfc7208-tests.upstream.json zonedata format into the evaluator's
// SpfDns interface. This file is Postroom's own (not upstream content) - see
// rfc7208-tests.upstream.NOTICE.txt for what is and isn't upstream in this directory.
//
// zonedata maps a domain name to either the literal string "TIMEOUT" (every query for that name
// is a temporary DNS failure) or a list of RR objects: {A}, {AAAA}, {TXT}, {SPF} (RFC 7208
// obsoleted type 99 - see below), {MX: [preference, exchange]}, {PTR}, {CNAME}. TXT and SPF
// values are either one character-string or a list of them to be concatenated WITHOUT a
// separator (RFC 7208 SS3.3, RFC 1035 SS3.3.14) before being treated as record text.
//
// Per the suite's own header comment: "the 'Selecting records' [section] is the only one
// concerned with weeding out (incorrect) queries for type SPF of any kind... Other sections
// rely on auto-magic duplication of SPF to TXT records (by test suite drivers)." So this
// zone answers a TXT query with {TXT} entries only, PLUS {SPF} entries treated as TXT-equivalent
// UNLESS `duplicateSpfAsTxt` is passed as false (used only for "Selecting records", where an
// RFC-7208-compliant, TXT-only implementation must see {SPF}-only domains as having no record).

import { SpfTempError } from '../../../../src/spf/errors.js';
import { parseIPv4, parseIPv6 } from '../../../../src/spf/ip.js';
import type { SpfDns, SpfLookupResult, SpfMxRecord } from '../../../../src/spf/types.js';

export type UpstreamStrings = string | UpstreamStrings[];

export interface UpstreamRR {
  A?: string;
  AAAA?: string;
  TXT?: UpstreamStrings;
  SPF?: UpstreamStrings;
  MX?: [number, string];
  PTR?: string;
  CNAME?: string;
}

// A per-domain entry can be "TIMEOUT" outright, or a list of RRs that itself contains a bare
// "TIMEOUT" element alongside real RR entries (the suite uses this to say "this name's records
// look like X, but every query for it times out anyway" - e.g. Record lookup's txttimeout.
// example.net). Either way, any query to that name is a temporary DNS failure - real DNS answers
// or it doesn't, it never partially answers depending on the RRset a static fixture happens to
// also list.
export type UpstreamZoneEntry = (UpstreamRR | 'TIMEOUT')[] | 'TIMEOUT';
export type UpstreamZone = Record<string, UpstreamZoneEntry>;

function normalizeName(name: string): string {
  return name.replace(/\.$/, '').toLowerCase();
}

/** RFC 1035 SS3.3.14 / RFC 7208 SS3.3: a TXT (or, here, SPF) RDATA is one or more
 * <character-string>s, concatenated with NO separator once read as text. */
function joinPieces(value: UpstreamStrings): string {
  if (Array.isArray(value)) return value.map(joinPieces).join('');
  return value;
}

const MAX_CNAME_CHASE = 10;

// "TIMEOUT" as the whole entry means every query to that name times out. "TIMEOUT" as one
// element *within* an RR list is scoped to whichever type doesn't already have real data: the
// suite pairs it with a real {TXT} entry when it means "the (irrelevant, ignored) type-SPF query
// times out" (e.g. Record lookup's spftimeout), and with a {TXT: "NONE"} placeholder when it
// means the TXT query itself times out (e.g. Record lookup's txttimeout) - so txt() alone needs
// to know whether a *real* TXT entry existed before deciding whether the marker applies to it.
type Resolved = { entries: UpstreamRR[]; hadTimeoutMarker: boolean } | 'timeout' | 'missing';

function resolveChain(map: Map<string, UpstreamZoneEntry>, name: string): Resolved {
  const visited = new Set<string>();
  let current = normalizeName(name);
  for (let i = 0; i < MAX_CNAME_CHASE; i++) {
    if (visited.has(current)) return 'missing'; // CNAME loop: skip this name, don't error (SS5.5/7)
    visited.add(current);
    const entry = map.get(current);
    if (entry === undefined) return 'missing';
    if (entry === 'TIMEOUT') return 'timeout';
    const hadTimeoutMarker = entry.includes('TIMEOUT');
    const rrs = entry.filter((r): r is UpstreamRR => r !== 'TIMEOUT');
    const cname = rrs.find((r) => r.CNAME !== undefined);
    if (cname?.CNAME !== undefined) {
      current = normalizeName(cname.CNAME);
      continue;
    }
    return { entries: rrs, hadTimeoutMarker };
  }
  return 'missing'; // chased too deep: treat as skip, not an error
}

function lookup<T>(
  map: Map<string, UpstreamZoneEntry>,
  name: string,
  extract: (entries: UpstreamRR[]) => T[],
  label: string,
): Promise<SpfLookupResult<T>> {
  const resolved = resolveChain(map, name);
  if (resolved === 'timeout') return Promise.reject(new SpfTempError(`TIMEOUT resolving ${label}`));
  if (resolved === 'missing') return Promise.resolve({ records: [], void: true });
  const records = extract(resolved.entries);
  // A lone "TIMEOUT" written as a one-element RR array (e.g. EXISTS's err.example.com) rather
  // than the bare top-level sentinel, with nothing of the requested type to fall back on, is a
  // timeout for this query too - there's no TXT/SPF-type ambiguity for A/AAAA/MX/PTR to resolve.
  if (resolved.hadTimeoutMarker && records.length === 0) {
    return Promise.reject(new SpfTempError(`TIMEOUT resolving ${label}`));
  }
  return Promise.resolve({ records, void: records.length === 0 });
}

function lookupTxt(
  map: Map<string, UpstreamZoneEntry>,
  name: string,
  duplicateSpfAsTxt: boolean,
  label: string,
): Promise<SpfLookupResult<string>> {
  const resolved = resolveChain(map, name);
  if (resolved === 'timeout') return Promise.reject(new SpfTempError(`TIMEOUT resolving ${label}`));
  if (resolved === 'missing') return Promise.resolve({ records: [], void: true });
  const hasRealTxt = resolved.entries.some((r) => r.TXT !== undefined && joinPieces(r.TXT) !== 'NONE');
  if (resolved.hadTimeoutMarker && !hasRealTxt) {
    return Promise.reject(new SpfTempError(`TIMEOUT resolving ${label}`));
  }
  const records = extractTxt(resolved.entries, duplicateSpfAsTxt);
  return Promise.resolve({ records, void: records.length === 0 });
}

function extractTxt(entries: UpstreamRR[], duplicateSpfAsTxt: boolean): string[] {
  const out: string[] = [];
  for (const r of entries) {
    if (r.TXT !== undefined) out.push(joinPieces(r.TXT));
    else if (duplicateSpfAsTxt && r.SPF !== undefined) out.push(joinPieces(r.SPF));
  }
  return out;
}
function extractA(entries: UpstreamRR[]): string[] {
  return entries.filter((r) => r.A !== undefined).map((r) => r.A as string);
}
function extractAAAA(entries: UpstreamRR[]): string[] {
  return entries.filter((r) => r.AAAA !== undefined).map((r) => r.AAAA as string);
}
function extractMx(entries: UpstreamRR[]): SpfMxRecord[] {
  return entries
    .filter((r) => r.MX !== undefined)
    .map((r) => ({ preference: (r.MX as [number, string])[0], exchange: (r.MX as [number, string])[1] }));
}
function extractPtr(entries: UpstreamRR[]): string[] {
  return entries.filter((r) => r.PTR !== undefined).map((r) => r.PTR as string);
}

function arpaNameFor(ip: string): string {
  if (ip.includes(':')) {
    const v6 = parseIPv6(ip);
    if (v6 === undefined) throw new RangeError(`not a valid test IPv6 address: ${ip}`);
    const hex = v6.toString(16).padStart(32, '0');
    return `${hex.split('').reverse().join('.')}.ip6.arpa`;
  }
  const v4 = parseIPv4(ip);
  if (v4 === undefined) throw new RangeError(`not a valid test IPv4 address: ${ip}`);
  const a = (v4 >>> 24) & 255;
  const b = (v4 >>> 16) & 255;
  const c = (v4 >>> 8) & 255;
  const d = v4 & 255;
  return `${String(d)}.${String(c)}.${String(b)}.${String(a)}.in-addr.arpa`;
}

export interface UpstreamDnsOptions {
  /** false only for the "Selecting records" section, which is deliberately about the {SPF} vs
   * {TXT} distinction (RFC 7208 removed type-99 SPF as a discovery mechanism). */
  duplicateSpfAsTxt?: boolean;
}

export function createUpstreamDns(zone: UpstreamZone, options: UpstreamDnsOptions = {}): SpfDns {
  const duplicateSpfAsTxt = options.duplicateSpfAsTxt ?? true;
  const map = new Map<string, UpstreamZoneEntry>();
  for (const [name, entry] of Object.entries(zone)) map.set(normalizeName(name), entry);

  return {
    txt: (name) => lookupTxt(map, name, duplicateSpfAsTxt, `txt:${name}`),
    a: (name) => lookup(map, name, extractA, `a:${name}`),
    aaaa: (name) => lookup(map, name, extractAAAA, `aaaa:${name}`),
    mx: (name) => lookup(map, name, extractMx, `mx:${name}`),
    ptr: (ip) => lookup(map, arpaNameFor(ip), extractPtr, `ptr:${ip}`),
  };
}
