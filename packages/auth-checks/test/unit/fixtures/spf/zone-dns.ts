// A tiny in-memory SpfDns for tests: no network, deterministic, and able to simulate SERVFAIL
// (temporary error) and NXDOMAIN/empty-answer (void lookup) per zone entry.

import { SpfTempError } from '../../../../src/spf/errors.js';
import type { SpfDns, SpfLookupResult, SpfMxRecord } from '../../../../src/spf/types.js';

export interface SpfZoneRecord {
  txt?: string[] | undefined;
  a?: string[] | undefined;
  aaaa?: string[] | undefined;
  mx?: SpfMxRecord[] | undefined;
  /** PTR answers for a reverse-DNS lookup keyed by the *forward* zone name used as the ip key. */
  ptr?: string[] | undefined;
}

export type SpfZone = Record<string, SpfZoneRecord | 'SERVFAIL'>;

function normalize(name: string): string {
  return name.replace(/\.$/, '').toLowerCase();
}

function lookup<T>(zone: SpfZone, name: string, pick: (rec: SpfZoneRecord) => T[] | undefined): SpfLookupResult<T> {
  const entry = zone[normalize(name)];
  if (entry === undefined) return { records: [], void: true };
  if (entry === 'SERVFAIL') throw new SpfTempError(`SERVFAIL: ${name}`);
  const records = pick(entry) ?? [];
  return { records, void: records.length === 0 };
}

export function createZoneDns(zone: SpfZone, ptrZone: Record<string, string[]> = {}): SpfDns {
  return {
    txt: (name) => Promise.resolve(lookup(zone, name, (r) => r.txt)),
    a: (name) => Promise.resolve(lookup(zone, name, (r) => r.a)),
    aaaa: (name) => Promise.resolve(lookup(zone, name, (r) => r.aaaa)),
    mx: (name) => Promise.resolve(lookup(zone, name, (r) => r.mx)),
    ptr: (ip) => {
      const names = ptrZone[ip];
      if (names === undefined) return Promise.resolve({ records: [], void: true });
      return Promise.resolve({ records: names, void: names.length === 0 });
    },
  };
}
