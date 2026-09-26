// DNSBL query-name construction: reverse the client IP's octets/nibbles and prepend the zone.
// Reuses @postroom/dns's proven reverse-DNS labels (IPv4 octet reversal, IPv6 nibble expansion)
// rather than duplicating that logic — we only need the reversed labels, not the arpa suffix.
import { reverseDnsName } from '@postroom/dns';

/** The reversed-address labels for `ip`, with the trailing in-addr.arpa/ip6.arpa suffix and dot
 * stripped — e.g. "2.0.0.127" for an IPv4 address, or the nibble form for IPv6. */
export function reversedAddressLabels(ip: string): string {
  const arpa = reverseDnsName(ip);
  return arpa.replace(/\.(in-addr|ip6)\.arpa\.$/, '');
}

/** The DNSBL query name for `ip` against `zone`, e.g. "2.0.0.127.zen.spamhaus.org." */
export function dnsblQueryName(ip: string, zone: string): string {
  const trimmedZone = zone.replace(/\.$/, '');
  return `${reversedAddressLabels(ip)}.${trimmedZone}.`;
}
