// The DNS side of a dns-01 challenge through a delegated zone (PST-T-0.15, PST-ADR-010).
//
// _acme-challenge.<domain> is a permanent CNAME into the challenge zone (for mx.d3cloud.io:
// mx.d3cloud.io.bigfluffymurderbuffalo.com), so the TXT is written at the CNAME's TARGET, and
// Let's Encrypt follows the CNAME to find it. Before telling the CA to look, the job asks the
// challenge zone's own authoritative nameservers directly — not a caching resolver, which could
// hold a negative answer for the name — and waits until every one of them serves the value.
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { Resolver } from 'node:dns/promises';

export interface ChallengeDns {
  /** The CNAME target of `name` (lower case, no trailing dot), or null when it has none. */
  cname(name: string): Promise<string | null>;
  /** IP addresses of the zone's authoritative nameservers. */
  authoritativeServers(zone: string): Promise<string[]>;
  /** The TXT strings at `name` as served by `server` (an IP); [] when there are none. */
  txtAt(server: string, name: string): Promise<string[]>;
}

const NO_DATA = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

export const normalizeName = (name: string): string => name.trim().toLowerCase().replace(/\.$/, '');

/** Whether `name` is strictly below `zone` (the apex itself is not a place for challenge records). */
export function isInZone(name: string, zone: string): boolean {
  const n = normalizeName(name);
  const z = normalizeName(zone);
  return z !== '' && n.endsWith(`.${z}`) && n.length > z.length + 1;
}

export class ChallengeTargetError extends Error {
  override readonly name = 'ChallengeTargetError';
}

/**
 * Where the TXT for `domain` goes: follow _acme-challenge.<domain>'s CNAME chain and refuse unless
 * it ends inside the challenge zone. With no CNAME at all the record would have to be written in
 * the domain's own zone, which is exactly what this design exists never to do.
 */
export async function resolveChallengeTarget(dns: ChallengeDns, domain: string, zone: string): Promise<string> {
  const start = `_acme-challenge.${normalizeName(domain)}`;
  let current = start;
  const seen = new Set<string>([current]);
  for (let hops = 0; hops < 8; hops++) {
    const next = await dns.cname(current);
    if (next === null) break;
    const target = normalizeName(next);
    if (seen.has(target)) throw new ChallengeTargetError(`${start}: CNAME loop at ${target}`);
    seen.add(target);
    current = target;
  }
  if (current === start) {
    throw new ChallengeTargetError(`${start} has no CNAME; it must point into the challenge zone ${zone} (see docs/runbooks/acme.md)`);
  }
  if (!isInZone(current, zone)) {
    throw new ChallengeTargetError(`${start} points at ${current}, outside the challenge zone ${zone}: refusing to write there`);
  }
  return current;
}

function code(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
}

export interface NodeChallengeDnsOptions {
  /** The recursive resolver for CNAME/NS/A lookups, `host[:port]`; unset → the system's. */
  readonly resolver?: string | undefined;
  readonly timeoutMs?: number;
}

/** The ChallengeDns on node:dns: a recursive resolver for the chain, direct queries for the zone. */
export function nodeChallengeDns(opts: NodeChallengeDnsOptions = {}): ChallengeDns {
  const timeout = opts.timeoutMs ?? 3_000;
  let recursive: Promise<Resolver> | undefined;

  // setServers takes addresses only; a compose service name (unbound:53) is looked up first.
  const serverSpec = async (spec: string): Promise<string> => {
    const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(spec.trim());
    const host = m?.[1] ?? spec;
    const port = m?.[2] ?? '53';
    const ip = isIP(host) !== 0 ? host : (await lookup(host)).address;
    return isIP(ip) === 6 ? `[${ip}]:${port}` : `${ip}:${port}`;
  };

  const getRecursive = (): Promise<Resolver> =>
    (recursive ??= (async () => {
      const r = new Resolver({ timeout, tries: 2 });
      if (opts.resolver !== undefined && opts.resolver.trim() !== '') r.setServers([await serverSpec(opts.resolver)]);
      return r;
    })());

  return {
    async cname(name) {
      try {
        const [target] = await (await getRecursive()).resolveCname(name);
        return target === undefined ? null : normalizeName(target);
      } catch (err) {
        if (NO_DATA.has(code(err))) return null;
        throw err;
      }
    },
    async authoritativeServers(zone) {
      const r = await getRecursive();
      const names = await r.resolveNs(zone);
      const ips = new Set<string>();
      for (const ns of names) {
        try {
          for (const ip of await r.resolve4(ns)) ips.add(ip);
        } catch (err) {
          if (!NO_DATA.has(code(err))) throw err;
        }
      }
      return [...ips];
    },
    async txtAt(server, name) {
      const r = new Resolver({ timeout, tries: 2 });
      r.setServers([await serverSpec(server)]);
      try {
        return (await r.resolveTxt(name)).map((chunks) => chunks.join(''));
      } catch (err) {
        if (NO_DATA.has(code(err))) return [];
        throw err;
      }
    },
  };
}

/** Wait until every authoritative server of `zone` serves `value` at `name`. */
export async function waitForTxt(
  dns: ChallengeDns,
  opts: { zone: string; name: string; value: string; timeoutMs: number; intervalMs: number; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<{ servers: number; checks: number }> {
  const servers = await dns.authoritativeServers(opts.zone);
  if (servers.length === 0) throw new Error(`no authoritative nameservers found for ${opts.zone}`);
  const deadline = opts.now() + opts.timeoutMs;
  for (let checks = 1; ; checks++) {
    const seen = await Promise.all(servers.map((s) => dns.txtAt(s, opts.name).catch((): string[] => [])));
    if (seen.every((values) => values.includes(opts.value))) return { servers: servers.length, checks };
    if (opts.now() >= deadline) {
      const missing = servers.filter((_, i) => !(seen[i] ?? []).includes(opts.value));
      throw new Error(`the challenge TXT at ${opts.name} did not appear on ${missing.join(', ')} within ${String(Math.round(opts.timeoutMs / 1000))} s`);
    }
    await opts.sleep(opts.intervalMs);
  }
}
