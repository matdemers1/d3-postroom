// The FCrDNS guard (PST-T-4.16, PST-REQ-187): direct delivery on :25 must never run while the
// egress IP's forward-confirmed reverse DNS does not hold — PTR(EDGE_PUBLIC_IP) equal to the EHLO
// name, and that name's A record equal to EDGE_PUBLIC_IP, in both directions. A mismatch (a cloud
// provider's default PTR, a stale A record, the IP not known at all) is exactly what a recipient's
// own spam filter checks for, so the daemon checks it first and never dials :25 on the strength of
// hope: while it does not hold, an eligible recipient goes through SES if configured, else waits.
import type { Resolver } from '@postroom/dns';

export type FcrdnsVerdict = { valid: true } | { valid: false; reason: string };

export type FcrdnsLog = (event: string, fields?: Record<string, unknown>) => void;

export interface FcrdnsGuardOptions {
  /** The egress IP direct delivery would connect from. Unset = FCrDNS can never hold. */
  edgeIp: string | undefined;
  /** Our EHLO name (MX_HOSTNAME): PTR(edgeIp) and A(heloName) must both name/resolve to edgeIp. */
  heloName: string;
  resolver: Resolver;
  now?: () => Date;
  /** Reuse a cached verdict for this long before looking again. Default 15 minutes. */
  ttlMs?: number;
  /** A lookup error keeps a still-valid cached verdict younger than this; older, fails closed. Default 1 hour. */
  staleValidMs?: number;
  log?: FcrdnsLog;
}

export interface FcrdnsGuard {
  /** The current verdict, from cache when fresh enough, otherwise a new lookup. */
  check: (at?: Date) => Promise<FcrdnsVerdict>;
}

export const DEFAULT_TTL_MS = 15 * 60_000;
export const DEFAULT_STALE_VALID_MS = 60 * 60_000;

function normalizeHost(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, '');
}

/** PTR(edgeIp) === heloName and A(heloName) === edgeIp, both through the configured resolver. */
async function lookup(edgeIp: string, heloName: string, resolver: Resolver): Promise<FcrdnsVerdict> {
  const want = normalizeHost(heloName);

  const ptr = await resolver.ptr(edgeIp);
  const ptrNames: string[] = [];
  for (const a of ptr.answers) if (a.kind === 'PTR') ptrNames.push(normalizeHost(a.target));
  if (!ptrNames.includes(want)) {
    const got = ptrNames[0] ?? '(no PTR record)';
    return { valid: false, reason: `FCrDNS not yet valid: PTR is ${got}, expected ${want}` };
  }

  const a = await resolver.a(want);
  const aAddresses: string[] = [];
  for (const rr of a.answers) if (rr.kind === 'A') aAddresses.push(rr.address);
  if (!aAddresses.includes(edgeIp)) {
    const got = aAddresses[0] ?? '(no A record)';
    return { valid: false, reason: `FCrDNS not yet valid: A record for ${want} is ${got}, expected ${edgeIp}` };
  }

  return { valid: true };
}

/**
 * A cached FCrDNS verdict, refreshed at most every `ttlMs`. Logs one line (`fcrdns-verdict-changed`)
 * the moment the verdict flips valid ↔ invalid, never per lookup or per message.
 */
export function createFcrdnsGuard(options: FcrdnsGuardOptions): FcrdnsGuard {
  const clock = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const staleValidMs = options.staleValidMs ?? DEFAULT_STALE_VALID_MS;
  const log = options.log ?? ((): void => undefined);

  let cached: FcrdnsVerdict | undefined;
  let checkedAt: number | undefined;
  let lastValidAt: number | undefined;

  const record = (verdict: FcrdnsVerdict, at: number): FcrdnsVerdict => {
    if (cached !== undefined && cached.valid !== verdict.valid) {
      log('fcrdns-verdict-changed', { from: cached.valid, to: verdict.valid, ...(verdict.valid ? {} : { reason: verdict.reason }) });
    }
    cached = verdict;
    checkedAt = at;
    if (verdict.valid) lastValidAt = at;
    return verdict;
  };

  return {
    check: async (at?: Date): Promise<FcrdnsVerdict> => {
      const now = (at ?? clock()).getTime();
      if (cached !== undefined && checkedAt !== undefined && now - checkedAt < ttlMs) return cached;

      if (options.edgeIp === undefined || options.edgeIp === '') {
        return record({ valid: false, reason: 'FCrDNS not yet valid: EDGE_PUBLIC_IP is not set' }, now);
      }

      try {
        const verdict = await lookup(options.edgeIp, options.heloName, options.resolver);
        return record(verdict, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (cached?.valid === true && lastValidAt !== undefined && now - lastValidAt < staleValidMs) {
          // Still within the grace window: a transient resolver blip does not flip a good verdict.
          checkedAt = now;
          return cached;
        }
        return record({ valid: false, reason: `FCrDNS not yet valid: lookup failed (${message})` }, now);
      }
    },
  };
}
