// The DNSBL client (PST-REQ-058, PST-REQ-063): query the client IP against Spamhaus ZEN through
// our own validating resolver (or the Spamhaus DQS key), never a public resolver — Spamhaus
// refuses public resolvers outright, and PST-REQ-063 forbids it regardless.
//
// Boot-time: refuseIfPublicResolver always runs, DQS key or not — a DQS key changes which zone we
// query, never whether the resolver is trusted.
//
// A DQS key is a secret. It never leaves this module: the zone we actually query may embed it
// (`<key>.zen.dq.spamhaus.net`), but every reported/returned zone name is the public
// "zen.spamhaus.org" — nothing derived from a lookup here is safe to put in an SMTP reply
// otherwise, since decide.ts puts `DnsblVerdict.zone` straight into the 554 text sent to the client.
import { RCode, refuseIfPublicResolver, type Resolver } from '@postroom/dns';
import { TtlLru } from './cache.js';
import { DNSBL_ERROR_CODES, isErrorCode, listForCode, shouldReject, type SpamhausList } from './codes.js';
import { dnsblQueryName } from './name.js';

export interface DnsblLookupResult {
  /** Reject-worthy per policy: true only when an SBL/SBL CSS/XBL/DROP code matched. */
  readonly listed: boolean;
  /** The public zone name — never embeds a DQS key. */
  readonly zone: string;
  /** The raw 127.x.x.x answers, if any. */
  readonly codes: readonly string[];
  /** Every matched sub-list, including PBL, which is a signal but never a reason to reject. */
  readonly lists: readonly SpamhausList[];
  readonly reason?: string;
}

export type DnsblLog = (event: string, fields?: Record<string, unknown>) => void;

export interface CreateDnsblCheckerOptions {
  readonly resolver: Resolver;
  /** The resolver address, exactly as configured (e.g. `unbound:53`) — checked at boot. */
  readonly server: string;
  /** The zone(s) to query, in order; the first match wins. Defaults to Spamhaus ZEN, via DQS when
   * `dqsKey` is set. A caller-supplied zone with a key embedded is still reported as the public
   * name. */
  readonly zones?: readonly string[] | undefined;
  readonly dqsKey?: string | undefined;
  /** Wall-clock budget for a single lookup, independent of the resolver's own retry timeout. */
  readonly timeoutMs?: number | undefined;
  readonly cacheTtlMs?: number | undefined;
  readonly cacheMaxEntries?: number | undefined;
  readonly log?: DnsblLog | undefined;
}

export interface DnsblHealth {
  readonly ok: boolean;
  readonly lastError?: string;
  readonly lastErrorAt?: string;
}

export interface DnsblChecker {
  lookup: (ip: string) => Promise<DnsblLookupResult>;
  health: () => DnsblHealth;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

function defaultZone(dqsKey: string | undefined): string {
  return dqsKey === undefined || dqsKey === '' ? 'zen.spamhaus.org' : `${dqsKey}.zen.dq.spamhaus.net`;
}

/** The zone name that is safe to report — a DQS key is a secret and must never appear in a log,
 * a stored verdict, or (worst of all) an SMTP reply text. */
export function publicZoneName(zone: string): string {
  return /^[^.]+\.zen\.dq\.spamhaus\.net$/.test(zone) ? 'zen.spamhaus.org' : zone;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dnsbl lookup exceeded ${String(timeoutMs)}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build the DNSBL client. Throws synchronously (so a daemon's boot fails before it binds a port)
 * when `server` is a known public resolver — PST-REQ-063, unconditionally, DQS key or not. */
export function createDnsblChecker(opts: CreateDnsblCheckerOptions): DnsblChecker {
  try {
    refuseIfPublicResolver(opts.server);
  } catch (err) {
    throw new Error(
      `DNSBL requires our own validating resolver, never a public one: ${errorMessage(err)}. ` +
        'Set DNS_RESOLVER to a resolver we control (e.g. the compose "unbound" service) — Spamhaus refuses queries from public resolvers, and PST-REQ-063 forbids using one regardless.',
      { cause: err },
    );
  }

  const zones = opts.zones !== undefined && opts.zones.length > 0 ? opts.zones : [defaultZone(opts.dqsKey)];
  const cache = new TtlLru<DnsblLookupResult>(opts.cacheMaxEntries ?? DEFAULT_MAX_ENTRIES, opts.cacheTtlMs ?? DEFAULT_TTL_MS);
  const log = opts.log ?? ((): void => undefined);
  let health: DnsblHealth = { ok: true };

  function notListed(zone: string, reason: string): DnsblLookupResult {
    return { listed: false, zone: publicZoneName(zone), codes: [], lists: [], reason };
  }

  async function lookupZone(ip: string, zone: string): Promise<DnsblLookupResult> {
    const name = dnsblQueryName(ip, zone);
    let result: Awaited<ReturnType<Resolver['a']>>;
    try {
      result = await withTimeout(opts.resolver.a(name), opts.timeoutMs);
    } catch (err) {
      const message = errorMessage(err);
      health = { ok: false, lastError: message, lastErrorAt: new Date().toISOString() };
      log('dnsbl-unavailable', { zone: publicZoneName(zone), error: message });
      return notListed(zone, 'dnsbl temporarily unavailable');
    }
    if (result.rcode === RCode.NXDOMAIN) return notListed(zone, 'not listed');
    const codes = result.answers.filter((a) => a.kind === 'A').map((a) => a.address);
    const errorCode = codes.find(isErrorCode);
    if (errorCode !== undefined) {
      const explanation = DNSBL_ERROR_CODES[errorCode] ?? 'Spamhaus reports a query problem';
      health = { ok: false, lastError: explanation, lastErrorAt: new Date().toISOString() };
      log('dnsbl-error-code', { zone: publicZoneName(zone), code: errorCode, explanation });
      return notListed(zone, 'dnsbl temporarily unavailable');
    }
    const lists = codes.map(listForCode).filter((l): l is SpamhausList => l !== undefined);
    const listed = shouldReject(lists);
    health = { ok: true };
    return {
      listed,
      zone: publicZoneName(zone),
      codes,
      lists,
      ...(lists.length > 0 ? { reason: lists.join(', ') } : {}),
    };
  }

  return {
    lookup: async (ip: string): Promise<DnsblLookupResult> => {
      const cached = cache.get(ip);
      if (cached !== undefined) return cached;
      // Zones are tried in priority order; in practice there is exactly one (Spamhaus ZEN, direct
      // or via DQS), so this is a single lookup with no unbounded fan-out.
      const result = await zones.reduce<Promise<DnsblLookupResult>>(async (prevPromise, zone) => {
        const prev = await prevPromise;
        if (prev.listed || prev.lists.length > 0) return prev;
        return lookupZone(ip, zone);
      }, Promise.resolve(notListed(zones[0] ?? defaultZone(opts.dqsKey), 'not listed')));
      cache.set(ip, result);
      return result;
    },
    health: () => health,
  };
}
