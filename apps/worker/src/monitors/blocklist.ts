// Is the edge's public IP blocklisted (PST-REQ-097)? Reuses `@postroom/dnsbl`'s pure query-name and
// code-interpretation helpers (the same Spamhaus ZEN zone and codes smtp-in rejects on), but this
// app is not in the DNSBL-Resolver dependency graph (@postroom/dns is not one of its declared
// workspace deps, deliberately kept minimal for this task — see needsOutside), so the actual A-record
// lookup here goes through Node's own `dns.Resolver` pointed at DNS_RESOLVER rather than the
// hand-rolled wire client smtp-in uses. This is a health check, not a rejection path.
// Set EDGE_PUBLIC_IP to '' to disable this monitor.
import dns from 'node:dns';
import { DNSBL_ERROR_CODES, dnsblQueryName, isErrorCode, listForCode, shouldReject } from '@postroom/dnsbl';
import type { Monitor } from './types.js';

export interface BlocklistMonitorOptions {
  readonly ip: string;
  readonly resolverServer: string;
  readonly zone?: string | undefined;
  readonly dqsKey?: string | undefined;
  /** Injectable for tests: resolves `name`'s A records against `server`, or `[]` when there is none. */
  readonly lookupA?: ((name: string, server: string) => Promise<string[]>) | undefined;
}

function defaultZone(dqsKey: string | undefined): string {
  return dqsKey === undefined || dqsKey === '' ? 'zen.spamhaus.org' : `${dqsKey}.zen.dq.spamhaus.net`;
}

/** Never report a DQS key: it is a secret, and only the public zone name is safe to log or alert on. */
export function publicBlocklistZone(zone: string): string {
  return /^[^.]+\.zen\.dq\.spamhaus\.net$/.test(zone) ? 'zen.spamhaus.org' : zone;
}

async function resolveA(name: string, server: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const resolver = new dns.Resolver();
    resolver.setServers([server]);
    resolver.resolve4(name, (error, addresses) => {
      if (error) {
        if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
          resolve([]);
          return;
        }
        reject(error);
        return;
      }
      resolve(addresses);
    });
  });
}

export function createBlocklistMonitor(opts: BlocklistMonitorOptions): Monitor | null {
  if (opts.ip === '') return null;
  const zone = opts.zone ?? defaultZone(opts.dqsKey);
  const lookup = opts.lookupA ?? resolveA;

  return {
    name: 'blocklist',
    check: async () => {
      const name = dnsblQueryName(opts.ip, zone);
      const codes = await lookup(name, opts.resolverServer);
      const errorCode = codes.find(isErrorCode);
      if (errorCode !== undefined) {
        // A Spamhaus signalling code (rate limit, malformed query, public resolver) is never a
        // listing — treat it as "unknown" rather than firing a false blocklist alert.
        return { ok: true, detail: `dnsbl temporarily unavailable: ${DNSBL_ERROR_CODES[errorCode]}` };
      }
      const lists = codes.map(listForCode).filter((l): l is NonNullable<ReturnType<typeof listForCode>> => l !== undefined);
      const listed = shouldReject(lists);
      return {
        ok: !listed,
        detail: listed
          ? `${opts.ip} listed on ${publicBlocklistZone(zone)}: ${lists.join(', ')}`
          : `${opts.ip} not listed on ${publicBlocklistZone(zone)}`,
        value: { listed, lists },
      };
    },
  };
}
