import { isIP } from 'node:net';
// PST-REQ-064: the AD bit is only meaningful because our resolver is the only DNSSEC-validating
// recursive resolver we ever ask. `trustAd` is derived from the configured server address, never
// from anything the wire told us — a hostile resolver could set AD on a bogus answer too.
import { DnsPublicResolverRefusedError } from './errors.js';

export interface ParsedServer {
  host: string;
  port: number;
}

const DEFAULT_DNS_PORT = 53;

export function parseServer(rawServer: string): ParsedServer {
  // A value pasted from an .env file may carry stray whitespace; ' 1.1.1.1' must not slip past the
  // public-resolver check below by failing an exact-string match.
  const server = rawServer.trim();
  const bracketMatch = /^\[(?<host>[^\]]+)]:(?<port>\d+)$/.exec(server);
  if (bracketMatch?.groups) {
    return { host: bracketMatch.groups.host ?? '', port: Number(bracketMatch.groups.port) };
  }
  const lastColon = server.lastIndexOf(':');
  if (lastColon === -1 || server.includes('::')) {
    // Bare IPv6 literal (contains "::") with no port, or a bare host/IPv4 with no port.
    return { host: server, port: DEFAULT_DNS_PORT };
  }
  const host = server.slice(0, lastColon);
  const portPart = server.slice(lastColon + 1);
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0) {
    return { host: server, port: DEFAULT_DNS_PORT };
  }
  return { host, port };
}

/** True only for loopback, RFC 1918 private ranges, and the compose service name `unbound` —
 * the shapes our own resolver is reachable under. Everything else is untrusted for the AD bit. */
export function isTrustedResolverAddress(host: string): boolean {
  if (host === 'localhost' || host === 'unbound') return true;
  if (host === '127.0.0.1' || host === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const rfc1918Match = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (rfc1918Match?.[1] !== undefined) {
    const second = Number(rfc1918Match[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

const PUBLIC_RESOLVERS = new Set([
  '8.8.8.8',
  '8.8.4.4',
  '2001:4860:4860::8888',
  '2001:4860:4860::8844',
  '1.1.1.1',
  '1.0.0.1',
  '2606:4700:4700::1111',
  '2606:4700:4700::1001',
  '9.9.9.9',
  '149.112.112.112',
  '2620:fe::fe',
  '208.67.222.222',
  '208.67.220.220',
]);

/** Refuses (throws) when `server` is a known public resolver. Spamhaus and other DNSBL zones
 * refuse queries from public resolvers, so DNSBL lookups must call this before querying. */
export function refuseIfPublicResolver(server: string): void {
  const { host } = parseServer(server);
  const bare = host.toLowerCase().replace(/\.$/, '');
  if (PUBLIC_RESOLVERS.has(bare)) {
    throw new DnsPublicResolverRefusedError(
      `refusing to query public resolver ${bare}: DNSBL zones (Spamhaus and similar) refuse queries from public resolvers`,
    );
  }
  // By name, only our own resolver: a single-label compose service name (`unbound`) or localhost.
  // A dotted hostname (`dns.google`, `one.one.one.one`) is somebody else's resolver, and resolving
  // it to check its address would itself go through a resolver we have not vetted.
  if (isIP(bare) === 0 && bare.includes('.')) {
    throw new DnsPublicResolverRefusedError(
      `refusing resolver hostname ${bare}: configure our own resolver by IP address or compose service name (e.g. unbound:53)`,
    );
  }
}
