// PST-REQ-031 / RFC 5321 §5.1: resolve MX records in preference order, fall back to A/AAAA only
// when no MX exists (implicit MX), and honour RFC 7505 null MX.
import { DnsServfailError } from './errors.js';
import { normalizeName } from './name.js';
import { RCode } from './types.js';
import type { DnsAnswer, Resolver } from './types.js';

export interface MxTarget {
  host: string;
  preference: number;
  addresses: string[];
}

/**
 * What our validating resolver vouched for (the AD bit, trusted only from our own resolver —
 * trust.ts). DANE (RFC 7672 §2.2) applies to an MX host only when both the MX RRset (or, for an
 * implicit MX, its denial) and that host's address records were validated.
 */
export interface MxDnssec {
  /** The MX answer (or the NODATA that led to the implicit MX) carried AD. */
  mx: boolean;
  /** Per target host (as in MxTarget.host): every address lookup made for it carried AD. */
  hosts: Record<string, boolean>;
}

export type MxResolution =
  | { kind: 'mx'; targets: MxTarget[]; dnssec: MxDnssec }
  | { kind: 'implicit'; targets: MxTarget[]; dnssec: MxDnssec }
  /** RFC 7505: a single "0 ." MX record means "do not deliver here" — 556 5.1.10. */
  | { kind: 'null-mx' }
  | { kind: 'permanent'; reason: string };

export interface ResolveMxOptions {
  /** Skip AAAA lookups for target addresses when true. */
  ipv4Only?: boolean;
  /** Injectable RNG for deterministic tie-break tests; defaults to Math.random. */
  rng?: () => number;
}

type MxAnswer = Extract<DnsAnswer, { kind: 'MX' }>;
type CnameAnswer = Extract<DnsAnswer, { kind: 'CNAME' }>;

function isMxAnswer(rr: DnsAnswer): rr is MxAnswer {
  return rr.kind === 'MX';
}

function isCnameAnswer(rr: DnsAnswer): rr is CnameAnswer {
  return rr.kind === 'CNAME';
}

function shuffleInPlace(items: MxAnswer[], rng: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a === undefined || b === undefined) continue;
    items[i] = b;
    items[j] = a;
  }
}

/** Sort ascending by preference; records that tie on preference are shuffled among themselves. */
function orderByPreference(records: MxAnswer[], rng: () => number): MxAnswer[] {
  const sorted = [...records].sort((a, b) => a.preference - b.preference);
  const result: MxAnswer[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i + 1;
    while (j < sorted.length && sorted[j]?.preference === sorted[i]?.preference) j += 1;
    const group = sorted.slice(i, j);
    shuffleInPlace(group, rng);
    result.push(...group);
    i = j;
  }
  return result;
}

async function resolveAddresses(resolver: Resolver, name: string, ipv4Only: boolean): Promise<{ addresses: string[]; secure: boolean }> {
  const addresses: string[] = [];
  const aResult = await resolver.a(name);
  let secure = aResult.ad;
  for (const rr of aResult.answers) {
    if (rr.kind === 'A') addresses.push(rr.address);
  }
  if (!ipv4Only) {
    const aaaaResult = await resolver.aaaa(name);
    secure = secure && aaaaResult.ad;
    for (const rr of aaaaResult.answers) {
      if (rr.kind === 'AAAA') addresses.push(rr.address);
    }
  }
  return { addresses, secure };
}

export async function resolveMxTargets(resolver: Resolver, domain: string, opts: ResolveMxOptions = {}): Promise<MxResolution> {
  const ipv4Only = opts.ipv4Only ?? false;
  const rng = opts.rng ?? Math.random;

  // A SERVFAIL (DNSSEC-bogus or otherwise) is temporary/bogus, never "no record" — let it propagate.
  let result;
  try {
    result = await resolver.mx(domain);
  } catch (err) {
    if (err instanceof DnsServfailError) throw err;
    throw err;
  }

  if (result.rcode === RCode.NXDOMAIN) {
    return { kind: 'permanent', reason: 'nxdomain' };
  }
  if (result.rcode !== RCode.NOERROR) {
    return { kind: 'permanent', reason: `unexpected rcode ${String(result.rcode)}` };
  }

  // Follow a CNAME chain at the queried domain (some authoritative servers return the CNAME plus
  // the target's MX records together in the answer section).
  const cnameByOwner = new Map<string, string>();
  for (const rr of result.answers.filter(isCnameAnswer)) {
    cnameByOwner.set(normalizeName(rr.name), normalizeName(rr.target));
  }
  let effectiveName = normalizeName(domain);
  const visited = new Set<string>();
  while (cnameByOwner.has(effectiveName) && !visited.has(effectiveName)) {
    visited.add(effectiveName);
    const next = cnameByOwner.get(effectiveName);
    if (next === undefined) break;
    effectiveName = next;
  }

  const mxRecords = result.answers.filter(isMxAnswer).filter((rr) => normalizeName(rr.name) === effectiveName);

  if (mxRecords.length === 1) {
    const only = mxRecords[0];
    if (only !== undefined && only.preference === 0 && only.exchange === '.') {
      return { kind: 'null-mx' };
    }
  }

  if (mxRecords.length > 0) {
    const ordered = orderByPreference(mxRecords, rng);
    const targets: MxTarget[] = [];
    const hosts: Record<string, boolean> = {};
    for (const rr of ordered) {
      const { addresses, secure } = await resolveAddresses(resolver, rr.exchange, ipv4Only);
      targets.push({ host: rr.exchange, preference: rr.preference, addresses });
      hosts[rr.exchange] = (hosts[rr.exchange] ?? true) && secure;
    }
    return { kind: 'mx', targets, dnssec: { mx: result.ad, hosts } };
  }

  // No MX at all: implicit MX per RFC 5321 §5.1, only if the domain itself has an address.
  const { addresses, secure } = await resolveAddresses(resolver, domain, ipv4Only);
  if (addresses.length === 0) {
    return { kind: 'permanent', reason: 'no-mx-no-address' };
  }
  return { kind: 'implicit', targets: [{ host: domain, preference: 0, addresses }], dnssec: { mx: result.ad, hosts: { [domain]: secure } } };
}
