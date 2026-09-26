// IPv4/IPv6 address parsing and CIDR matching for the ip4/ip6/a/mx mechanisms
// (RFC 7208 SS5.6, SS5.7) and for the IPv4-mapped-IPv6 handling in SS5.

export function parseIPv4(addr: string): number | undefined {
  const parts = addr.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

/** Expand an IPv6 literal (accepting `::` and an IPv4-mapped tail) to a 128-bit integer. */
export function parseIPv6(addr: string): bigint | undefined {
  let working = addr;
  const lastColon = working.lastIndexOf(':');
  const tail = working.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (v4 === undefined) return undefined;
    const hex = v4.toString(16).padStart(8, '0');
    working = `${working.slice(0, lastColon + 1)}${hex.slice(0, 4)}:${hex.slice(4)}`;
  }
  if ((working.match(/::/g) ?? []).length > 1) return undefined;
  const doubleColon = working.includes('::');
  const [head, tailPart] = working.split('::');
  const headGroups = head === undefined || head === '' ? [] : head.split(':');
  const tailGroups = tailPart === undefined || tailPart === '' ? [] : tailPart.split(':');
  let groups: string[];
  if (doubleColon) {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return undefined;
    groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  } else {
    groups = headGroups;
  }
  if (groups.length !== 8) return undefined;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

/** IPv4-mapped IPv6 (::ffff:0:0/96) is treated as IPv4 per RFC 7208 SS5. */
export function ipv4MappedToIPv4(v6: bigint): number | undefined {
  const prefix = v6 >> 32n;
  const low32 = v6 & 0xffffffffn;
  const rest = v6 >> 48n;
  if (prefix === 0xffffn && rest === 0n) {
    return Number(low32) >>> 0;
  }
  return undefined;
}

export function ipv4CidrMatch(a: number, b: number, prefix: number): boolean {
  if (prefix >= 32) return a === b;
  if (prefix <= 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function ipv6CidrMatch(a: bigint, b: bigint, prefix: number): boolean {
  if (prefix >= 128) return a === b;
  if (prefix <= 0) return true;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (a & mask) === (b & mask);
}

/** Full 32-nibble dot-separated hex form used by the `%{i}` macro for IPv6 (RFC 7208 SS7.3).
 * Uppercase to match the real conformance suite's expected explanation text. */
export function ipv6ToDottedNibbles(v6: bigint): string {
  const hex = v6.toString(16).padStart(32, '0').toUpperCase();
  return hex.split('').join('.');
}
