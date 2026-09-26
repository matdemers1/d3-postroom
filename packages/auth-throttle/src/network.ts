// Client-address keys for throttling. A streak is kept per (username, network): the /24 of an IPv4
// address, the /64 of an IPv6 one — an attacker who owns a /64 can use every address in it, so the
// full IPv6 address would be no key at all. The per-source ceiling uses the IPv4 address itself and,
// for IPv6, the same /64.
import { isIPv4, isIPv6 } from 'node:net';

/** Strip an IPv6 zone and unwrap an IPv4-mapped IPv6 address (`::ffff:192.0.2.1`). */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  const zone = trimmed.indexOf('%');
  const bare = zone === -1 ? trimmed : trimmed.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped?.[1] !== undefined && isIPv4(mapped[1])) return mapped[1];
  return bare;
}

/** Eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let text = ip;
  // An embedded IPv4 tail (`::1.2.3.4`) becomes two hex groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  const head = halves[0] === undefined || halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length < 2 || halves[1] === undefined || halves[1] === '' ? [] : halves[1].split(':');
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array.from({ length: fill }, () => '0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** `192.0.2.0/24` or `2001:db8:1:2::/64`; anything unparseable is its own key. */
export function networkOf(ip: string): string {
  const addr = normalizeIp(ip);
  if (isIPv4(addr)) {
    const octets = addr.split('.');
    return `${octets.slice(0, 3).join('.')}.0/24`;
  }
  const groups = ipv6Groups(addr);
  if (groups === null) return addr;
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** The key the per-source ceiling counts by: the IPv4 address, or the IPv6 /64. */
export function sourceOf(ip: string): string {
  const addr = normalizeIp(ip);
  return isIPv4(addr) ? addr : networkOf(addr);
}
