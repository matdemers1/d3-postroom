// Is the edge's public IP on a major blocklist (PST-REQ-124)? Checks Spamhaus ZEN, Barracuda,
// SpamCop, UCEPROTECT level 1, PSBL and Mailspike — a documented, configurable set (env
// BLOCKLIST_ZONES overrides which of them run). Reuses `@postroom/dnsbl`'s pure query-name helper
// (the reversed-address DNSBL query name), but this app is not in the DNSBL-Resolver dependency
// graph (@postroom/dns is not one of its declared workspace deps, deliberately kept minimal — see
// needsOutside), so the actual A-record lookup here goes through Node's own `dns.Resolver` pointed
// at DNS_RESOLVER rather than the hand-rolled wire client smtp-in uses. This is a health check, not
// a rejection path.
//
// Each zone's return codes are interpreted per its own documented meanings (see ZONE_REGISTRY
// below) rather than through `@postroom/dnsbl`'s Spamhaus-only code table — that table also backs
// smtp-in's live rejection path and PST-T-7.3 must not change its behaviour, so the interpretation
// here is a separate, generalised copy for Spamhaus plus the five other zones.
//
// Cadence (PST-REQ-124, "every 6 hours"): DNSBL operators rate-limit, and some ban frequent
// queriers, so this monitor sets `minIntervalMs` (default BLOCKLIST_INTERVAL_MS, 6h) rather than
// running on every 60s tick — the runner (runner.ts) honours it against the persisted `checkedAt`.
// It also declares `inputKey()` (the IP plus the exact zone set), so a changed EDGE_PUBLIC_IP or
// BLOCKLIST_ZONES always forces an immediate re-check instead of reusing a cached result computed
// for the previous target (PST-T-7.3).
//
// Each zone is queried with its own timeout (BLOCKLIST_ZONE_TIMEOUT_MS, default 5s): a hung/dead
// zone is reported as an "unknown" result for that zone alone — it never blocks the other zones'
// results, and never masks a real listing found on a healthy zone.
//
// Set EDGE_PUBLIC_IP to '' to disable this monitor.
import dns from 'node:dns';
import { dnsblQueryName } from '@postroom/dnsbl';
import type { Monitor } from './types.js';

/** How to interpret one A-record answer from a zone. */
export interface BlocklistZoneCode {
  /** A short label for this code, used in the alert/detail text (e.g. "XBL", "listed"). */
  readonly label: string;
  /** True when this code is a genuine listing worth alerting on. */
  readonly listed: boolean;
  /** True when this code is the zone signalling a problem with the query itself (malformed query,
   * a public resolver, rate limiting) rather than a real listing — never treated as a listing, and
   * never treated as clean either: it is reported as a check error ("unknown"). */
  readonly isError?: boolean;
}

export interface BlocklistZoneDefinition {
  /** A short key identifying this zone for BLOCKLIST_ZONES filtering (e.g. "spamhaus"). */
  readonly key: string;
  /** Display name used in alert/detail text (e.g. "Spamhaus ZEN"). */
  readonly name: string;
  /** The DNS zone/host to query (may embed a secret, e.g. a Spamhaus DQS key — see publicBlocklistZone). */
  readonly host: string;
  /** Where an operator goes to request delisting. */
  readonly delistingUrl: string;
  /** Known A-record codes for this zone. A code not present here is treated as "not listed" —
   * every zone below documents at least its listing code(s). */
  readonly codes: Readonly<Record<string, BlocklistZoneCode>>;
}

// Spamhaus ZEN (https://www.spamhaus.org/zen/): 127.0.0.2/.3 SBL, .4-.7 XBL, .9 DROP, .10/.11 PBL
// (a policy signal, not itself a reason to alert). 127.255.255.x is Spamhaus signalling a problem
// with how we asked (typo, public resolver, rate limit) — never a listing.
const SPAMHAUS_CODES: Readonly<Record<string, BlocklistZoneCode>> = {
  '127.0.0.2': { label: 'SBL', listed: true },
  '127.0.0.3': { label: 'SBL CSS', listed: true },
  '127.0.0.4': { label: 'XBL', listed: true },
  '127.0.0.5': { label: 'XBL', listed: true },
  '127.0.0.6': { label: 'XBL', listed: true },
  '127.0.0.7': { label: 'XBL', listed: true },
  '127.0.0.9': { label: 'DROP', listed: true },
  '127.0.0.10': { label: 'PBL', listed: false },
  '127.0.0.11': { label: 'PBL', listed: false },
  '127.255.255.252': { label: 'malformed query', listed: false, isError: true },
  '127.255.255.254': { label: 'query via public resolver', listed: false, isError: true },
  '127.255.255.255': { label: 'rate limited', listed: false, isError: true },
};

/** Zones (Barracuda, SpamCop, UCEPROTECT, PSBL) that document exactly one "listed" answer,
 * 127.0.0.2, with nothing else defined. */
function singleListedCode(): Readonly<Record<string, BlocklistZoneCode>> {
  return { '127.0.0.2': { label: 'listed', listed: true } };
}

// Mailspike (https://mailspike.org/bl.html): 127.0.0.2-.9 are degrees of "bad" (spam source); .10-.19
// are reputation scores on otherwise-clean space, never a reason to alert.
const MAILSPIKE_CODES: Readonly<Record<string, BlocklistZoneCode>> = {
  '127.0.0.2': { label: 'spam source', listed: true },
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`127.0.0.${String(i + 10)}`, { label: 'reputation', listed: false }] as const),
  ),
};

function defaultZoneRegistry(dqsKey: string | undefined): Readonly<Record<string, BlocklistZoneDefinition>> {
  const spamhausHost = dqsKey === undefined || dqsKey === '' ? 'zen.spamhaus.org' : `${dqsKey}.zen.dq.spamhaus.net`;
  return {
    spamhaus: {
      key: 'spamhaus',
      name: 'Spamhaus ZEN',
      host: spamhausHost,
      delistingUrl: 'https://check.spamhaus.org/',
      codes: SPAMHAUS_CODES,
    },
    barracuda: {
      key: 'barracuda',
      name: 'Barracuda',
      host: 'b.barracudacentral.org',
      delistingUrl: 'https://www.barracudacentral.org/rbl/removal-request',
      codes: singleListedCode(),
    },
    spamcop: {
      key: 'spamcop',
      name: 'SpamCop',
      host: 'bl.spamcop.net',
      delistingUrl: 'https://www.spamcop.net/bl.shtml',
      codes: singleListedCode(),
    },
    uceprotect1: {
      key: 'uceprotect1',
      name: 'UCEPROTECT Level 1',
      host: 'dnsbl-1.uceprotect.net',
      delistingUrl: 'https://www.uceprotect.net/en/rblcheck.php',
      codes: singleListedCode(),
    },
    psbl: {
      key: 'psbl',
      name: 'PSBL',
      host: 'psbl.surriel.com',
      delistingUrl: 'https://psbl.org/remove',
      codes: singleListedCode(),
    },
    mailspike: {
      key: 'mailspike',
      name: 'Mailspike',
      host: 'bl.mailspike.net',
      delistingUrl: 'https://mailspike.org/appeal',
      codes: MAILSPIKE_CODES,
    },
  };
}

/** Never report a DQS key: it is a secret, and only the public zone name is safe to log or alert on. */
export function publicBlocklistZone(zone: string): string {
  return /^[^.]+\.zen\.dq\.spamhaus\.net$/.test(zone) ? 'zen.spamhaus.org' : zone;
}

export interface BlocklistMonitorOptions {
  readonly ip: string;
  readonly resolverServer: string;
  /** Zone registry keys to check (see defaultZoneRegistry); defaults to all six. */
  readonly zoneKeys?: readonly string[] | undefined;
  readonly dqsKey?: string | undefined;
  /** Minimum spacing between real DNSBL queries, honoured by the runner (PST-REQ-124: every 6h). */
  readonly minIntervalMs?: number | undefined;
  /** Wall-clock budget for a single zone's lookup; a zone that does not answer within this is
   * reported as that zone's own "unknown" result, never blocking or masking the others. */
  readonly zoneTimeoutMs?: number | undefined;
  /** Injectable for tests: resolves `name`'s A records against `server`, or `[]` when there is none. */
  readonly lookupA?: ((name: string, server: string) => Promise<string[]>) | undefined;
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

const DEFAULT_MIN_INTERVAL_MS = 6 * 3_600_000;
const DEFAULT_ZONE_TIMEOUT_MS = 5_000;

interface ZoneOutcome {
  readonly zone: BlocklistZoneDefinition;
  readonly listed: boolean;
  readonly codeLabel?: string;
  readonly errorLabel?: string;
}

/** A per-zone timeout: a zone that never answers must not hang the whole check, or masquerade as
 * "not listed" — it is reported as that zone's own error, distinct from the others. */
function withZoneTimeout<T>(promise: Promise<T>, timeoutMs: number, zoneName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${zoneName} lookup timed out after ${String(timeoutMs)}ms`));
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

async function checkZone(
  zone: BlocklistZoneDefinition,
  ip: string,
  lookup: (name: string, server: string) => Promise<string[]>,
  resolverServer: string,
  zoneTimeoutMs: number,
): Promise<ZoneOutcome> {
  const name = dnsblQueryName(ip, zone.host);
  let codes: string[];
  try {
    codes = await withZoneTimeout(lookup(name, resolverServer), zoneTimeoutMs, zone.name);
  } catch (err) {
    return { zone, listed: false, errorLabel: err instanceof Error ? err.message : String(err) };
  }
  for (const code of codes) {
    const entry = zone.codes[code];
    if (entry?.isError === true) return { zone, listed: false, errorLabel: entry.label };
    if (entry?.listed === true) return { zone, listed: true, codeLabel: entry.label };
  }
  return { zone, listed: false };
}

export function createBlocklistMonitor(opts: BlocklistMonitorOptions): Monitor | null {
  if (opts.ip === '') return null;
  const registry = defaultZoneRegistry(opts.dqsKey);
  const keys = opts.zoneKeys ?? Object.keys(registry);
  const zones = keys.map((k) => registry[k]).filter((z): z is BlocklistZoneDefinition => z !== undefined);
  const lookup = opts.lookupA ?? resolveA;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const zoneTimeoutMs = opts.zoneTimeoutMs ?? DEFAULT_ZONE_TIMEOUT_MS;
  // What this monitor actually checks — the IP and the exact zone hosts — so the runner can force
  // an immediate re-check the moment either one changes, instead of trusting a stale cached result
  // computed for a different target (PST-T-7.3).
  const inputKey = (): string => JSON.stringify({ ip: opts.ip, zones: zones.map((z) => z.host) });

  return {
    name: 'blocklist',
    minIntervalMs,
    inputKey,
    check: async () => {
      const outcomes = await Promise.all(zones.map((zone) => checkZone(zone, opts.ip, lookup, opts.resolverServer, zoneTimeoutMs)));
      const listedOn = outcomes.filter((o) => o.listed);
      const erroredOn = outcomes.filter((o) => o.errorLabel !== undefined);
      const cleanZoneNames = outcomes.filter((o) => !o.listed && o.errorLabel === undefined).map((o) => o.zone.name);

      if (listedOn.length > 0) {
        const names = listedOn.map((o) => o.zone.name).join(', ');
        const detailParts = listedOn.map(
          (o) => `${o.zone.name} (${o.codeLabel ?? 'listed'}; delist at ${o.zone.delistingUrl})`,
        );
        const errorNote = erroredOn.length > 0 ? `; unknown: ${erroredOn.map((o) => o.zone.name).join(', ')}` : '';
        return {
          ok: false,
          detail: `${opts.ip} listed on ${names}: ${detailParts.join('; ')}${errorNote}`,
          value: { listed: true, zones: listedOn.map((o) => publicBlocklistZone(o.zone.host)) },
        };
      }

      // Every zone we asked came back as a query problem (rate limit, malformed query, public
      // resolver, a timeout): never treat that as a listing, but never call it clean either.
      if (erroredOn.length > 0 && erroredOn.length === outcomes.length) {
        const parts = erroredOn.map((o) => `${o.zone.name}: ${o.errorLabel ?? 'unknown'}`).join('; ');
        return { ok: true, detail: `dnsbl check unknown (query error): ${parts}` };
      }

      // Some (but not all) zones errored: the healthy zones' clean results still stand, reported
      // alongside — not masked by — the erroring zone(s)' own "unknown".
      if (erroredOn.length > 0) {
        const parts = erroredOn.map((o) => `${o.zone.name}: unknown (${o.errorLabel ?? 'query error'})`).join('; ');
        return { ok: true, detail: `${opts.ip} not listed on ${cleanZoneNames.join(', ')}; ${parts}` };
      }

      return { ok: true, detail: `${opts.ip} not listed on ${zones.map((z) => z.name).join(', ')}` };
    },
  };
}
