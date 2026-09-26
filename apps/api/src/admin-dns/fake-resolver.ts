// An in-memory Resolver for the checker's tests (unit and integration): a zone as a table of
// "name TYPE" → answers, with a way to make one lookup time out. Not used by the running server.
import { DnsTimeoutError, RCode, RRType, reverseDnsName, type DnsAnswer, type Resolver, type ResolverResult } from '@postroom/dns';
import { RRTYPE_SRV } from './check.js';

export type FakeRecord =
  | { type: 'A' | 'AAAA'; value: string }
  | { type: 'MX'; preference: number; exchange: string }
  | { type: 'TXT'; value: string }
  | { type: 'CNAME' | 'PTR'; value: string }
  | { type: 'SRV'; priority: number; weight: number; port: number; target: string };

export interface FakeZone {
  /** Records by owner name (no trailing dot). A PTR is keyed by the IP, e.g. "203.0.113.7". */
  records: Record<string, FakeRecord[]>;
  /** Owner names whose every lookup times out. */
  timeouts?: string[];
}

const TYPE: Record<FakeRecord['type'], number> = { A: RRType.A, AAAA: RRType.AAAA, MX: RRType.MX, TXT: RRType.TXT, CNAME: RRType.CNAME, PTR: RRType.PTR, SRV: RRTYPE_SRV };

export function encodeSrvRdata(r: { priority: number; weight: number; port: number; target: string }): Uint8Array {
  const labels = r.target.replace(/\.$/, '').split('.').filter((l) => l !== '');
  const bytes = [r.priority >> 8, r.priority & 0xff, r.weight >> 8, r.weight & 0xff, r.port >> 8, r.port & 0xff];
  for (const label of labels) bytes.push(label.length, ...Buffer.from(label, 'latin1'));
  bytes.push(0);
  return Uint8Array.from(bytes);
}

function toAnswer(name: string, r: FakeRecord): DnsAnswer {
  const base = { name, ttl: 300, type: TYPE[r.type], class: 1 };
  switch (r.type) {
    case 'A':
      return { ...base, kind: 'A', address: r.value };
    case 'AAAA':
      return { ...base, kind: 'AAAA', address: r.value };
    case 'MX':
      return { ...base, kind: 'MX', preference: r.preference, exchange: r.exchange };
    case 'TXT':
      return { ...base, kind: 'TXT', strings: [r.value], text: r.value };
    case 'CNAME':
      return { ...base, kind: 'CNAME', target: r.value };
    case 'PTR':
      return { ...base, kind: 'PTR', target: r.value };
    case 'SRV':
      return { ...base, kind: 'UNKNOWN', raw: encodeSrvRdata(r) };
  }
}

export function fakeResolver(zone: FakeZone): Resolver & { queries: string[] } {
  const queries: string[] = [];
  // Read on every query, so a test may change the zone between checks.
  const reverseOf = (name: string): string | undefined =>
    Object.keys(zone.records).find((key) => (/^[\d.]+$/.test(key) || key.includes(':')) && reverseDnsName(key).replace(/\.$/, '') === name);
  const query = (rawName: string, type: number): Promise<ResolverResult> => {
    const name = rawName.toLowerCase().replace(/\.$/, '');
    queries.push(`${name} ${String(type)}`);
    if (zone.timeouts?.includes(name)) return Promise.reject(new DnsTimeoutError(`timed out asking for ${name}`));
    const owner = reverseOf(name) ?? name;
    const all = zone.records[owner];
    if (all === undefined) return Promise.resolve({ rcode: RCode.NXDOMAIN, ad: false, answers: [], authority: [] });
    const answers = all.filter((r) => TYPE[r.type] === type).map((r) => toAnswer(name, r));
    return Promise.resolve({ rcode: RCode.NOERROR, ad: false, answers, authority: [] });
  };
  return {
    queries,
    query,
    a: (n) => query(n, RRType.A),
    aaaa: (n) => query(n, RRType.AAAA),
    mx: (n) => query(n, RRType.MX),
    txt: (n) => query(n, RRType.TXT),
    tlsa: (n) => query(n, RRType.TLSA),
    ptr: (ip) => query(reverseDnsName(ip), RRType.PTR),
  };
}
