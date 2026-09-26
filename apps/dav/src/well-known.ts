// DAV service discovery (RFC 6764) — PST-T-8.3, PST-REQ-132, PST-REQ-133.
//
// A client given only an address (matthew@d3cloud.io) finds the server in this order:
//   1. SRV _caldavs._tcp.<domain> / _carddavs._tcp.<domain>  → host and port (§3)
//   2. TXT on the same name, "path=/dav/"                     → the context path (§4)
//   3. https://<host>/.well-known/caldav | carddav             → 301 to the context path (§5)
// The plaintext _caldav._tcp / _carddav._tcp names are published with target "." — RFC 6782 §2's
// "this service is not offered" — so no client falls back to sending an app password in the clear.
import { CONTEXT_PATH } from './paths.js';

export type WellKnownService = 'caldav' | 'carddav';

/** The service a /.well-known path names, or null. Exact match: no trailing segments, no slash. */
export function wellKnownService(pathname: string): WellKnownService | null {
  if (pathname === '/.well-known/caldav') return 'caldav';
  if (pathname === '/.well-known/carddav') return 'carddav';
  return null;
}

/**
 * Where a well-known request is redirected. Relative on the DAV host itself; absolute when
 * another host (the webmail at mail.<domain>) forwards clients to the DAV host.
 */
export function wellKnownLocation(publicUrl?: string): string {
  if (publicUrl === undefined || publicUrl === '') return CONTEXT_PATH;
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:') throw new Error(`DAV public URL must be https: ${publicUrl}`);
  return new URL(CONTEXT_PATH, url.origin).toString();
}

export interface DiscoveryRecord {
  readonly type: 'SRV' | 'TXT';
  readonly name: string;
  /** Zone-file presentation of the record data. */
  readonly value: string;
  readonly why: string;
}

/** The DNS records one mail domain publishes so calendars and contacts configure from the address. */
export function discoveryRecords(domain: string, davHost: string, port = 443): DiscoveryRecord[] {
  const d = domain.replace(/\.$/, '').toLowerCase();
  const host = davHost.replace(/\.$/, '').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(d) || !/^[a-z0-9.-]+$/.test(host)) throw new Error('discoveryRecords: domain and host must be plain DNS names');
  const out: DiscoveryRecord[] = [];
  for (const svc of ['caldav', 'carddav'] as const) {
    out.push({ type: 'SRV', name: `_${svc}s._tcp.${d}`, value: `0 1 ${port} ${host}.`, why: `${svc} over TLS lives on ${host}` });
    out.push({ type: 'TXT', name: `_${svc}s._tcp.${d}`, value: `"path=${CONTEXT_PATH}"`, why: 'the context path, so no well-known round trip is needed' });
    out.push({ type: 'SRV', name: `_${svc}._tcp.${d}`, value: '0 0 0 .', why: `plaintext ${svc} is not offered (RFC 6764 §3, RFC 6782)` });
  }
  return out;
}
