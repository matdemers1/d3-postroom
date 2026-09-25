// Forward-confirmed reverse DNS for the Received header: the PTR name is used only when it resolves
// back to the client's address; otherwise the header says "unknown".
import { isIPv4, isIPv6 } from 'node:net';
import type { Resolver } from '@postroom/dns';

export type ReverseLookup = (ip: string) => Promise<string | null>;

/** Canonical text for an IP, so `2001:DB8::1` and `2001:db8:0::1` compare equal. */
export function canonicalIp(ip: string): string {
  const bare = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv6(bare)) return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  return bare;
}

export function reverseLookupVia(resolver: Resolver): ReverseLookup {
  return async (ip) => {
    const addr = canonicalIp(ip);
    const ptr = await resolver.ptr(addr);
    const name = ptr.answers.find((a) => a.kind === 'PTR')?.target;
    if (name === undefined || name === '') return null;
    const forward = isIPv6(addr) ? await resolver.aaaa(name) : await resolver.a(name);
    const confirmed = forward.answers.some((a) => (a.kind === 'A' || a.kind === 'AAAA') && canonicalIp(a.address) === addr);
    return confirmed ? name.replace(/\.$/, '') : null;
  };
}
