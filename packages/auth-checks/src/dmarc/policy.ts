// DMARC policy discovery (RFC 7489 §6.6.3).
//
// 1. Query _dmarc.<From domain>; discard TXT records that do not start with v=DMARC1.
// 2. If none remain, query _dmarc.<organizational domain> (when it differs) and discard likewise.
// 3. Zero or several records left: no policy, DMARC is not applied.
// 4. A record with no valid p= (or an invalid sp=) counts as p=none if it has a valid rua=,
//    otherwise DMARC is not applied.
// A temporary DNS failure at either step is a temperror — never silently "no policy".

import type { ResolverResult } from '@postroom/dns';
import { RCode } from '@postroom/dns';
import { normalizeDomain, organizationalDomain, type PslOptions } from '../psl/index.js';
import { parseDmarcRecord, type DmarcRecord } from './record.js';

/** The DNS DMARC needs. A DkimDns (or @postroom/dns resolver wrapper) satisfies `txt`. */
export interface DmarcDns {
  /**
   * TXT records at `name`, each joined from its character-strings; [] for NXDOMAIN/NODATA; throw
   * on a temporary failure. A @postroom/dns `ResolverResult` is also accepted and interpreted.
   */
  txt(name: string): Promise<readonly string[] | ResolverResult>;
  /**
   * Optional, for np= (RFC 9091 §2.1): false when the domain does not exist (NXDOMAIN for A, AAAA
   * and MX). Throw on a temporary failure. Without it, np= is never applied (and a note says so).
   */
  exists?(domain: string): Promise<boolean>;
}

export type DmarcPolicyLookup =
  | {
      readonly kind: 'record';
      readonly fromDomain: string;
      readonly orgDomain: string;
      /** Where the record was found: the From domain or its organizational domain. */
      readonly recordDomain: string;
      readonly record: DmarcRecord;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: 'none' | 'temperror';
      readonly fromDomain: string;
      readonly orgDomain: string;
      readonly reasons: readonly string[];
    };

type TxtAnswer = { readonly ok: true; readonly records: readonly string[] } | { readonly ok: false; readonly reason: string };

async function queryTxt(dns: DmarcDns, name: string): Promise<TxtAnswer> {
  try {
    const answer = await dns.txt(name);
    if (Array.isArray(answer)) return { ok: true, records: answer as readonly string[] };
    const r = answer as ResolverResult;
    if (r.rcode !== RCode.NOERROR && r.rcode !== RCode.NXDOMAIN) {
      return { ok: false, reason: `DNS temporary failure looking up ${name} (rcode ${r.rcode})` };
    }
    return { ok: true, records: r.answers.flatMap((a) => (a.kind === 'TXT' ? [a.strings.join('')] : [])) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `DNS temporary failure looking up ${name}: ${message}` };
  }
}

/** The DMARC records among `records`: those starting with v=DMARC1, parsed or rejected. */
function dmarcOnly(records: readonly string[]): ReturnType<typeof parseDmarcRecord>[] {
  return records.map(parseDmarcRecord).filter((p) => p.ok || p.isDmarc);
}

/** Discover the DMARC policy for `fromDomain` (the RFC5322.From domain). Never throws. */
export async function fetchDmarcPolicy(dns: DmarcDns, fromDomain: string, psl: PslOptions = {}): Promise<DmarcPolicyLookup> {
  const from = normalizeDomain(fromDomain) ?? fromDomain.toLowerCase();
  const org = organizationalDomain(from, psl) ?? from;
  const base = { fromDomain: from, orgDomain: org };

  const candidates = [from, ...(org === from ? [] : [org])];
  for (const domain of candidates) {
    const name = `_dmarc.${domain}`;
    const answer = await queryTxt(dns, name);
    if (!answer.ok) return { ...base, kind: 'temperror', reasons: [answer.reason] };
    const found = dmarcOnly(answer.records);
    if (found.length === 0) continue;
    if (found.length > 1) {
      return { ...base, kind: 'none', reasons: [`${found.length} DMARC records at ${name}; DMARC is not applied (RFC 7489 §6.6.3)`] };
    }
    const only = found[0];
    if (only === undefined) continue; // unreachable: length checked
    if (!only.ok) return { ...base, kind: 'none', reasons: [only.reason] };
    return { ...base, kind: 'record', recordDomain: domain, record: only.record, reasons: [...only.record.notes] };
  }
  const where = candidates.map((d) => `_dmarc.${d}`).join(' or ');
  return { ...base, kind: 'none', reasons: [`no DMARC record at ${where}`] };
}
