// PST-REQ-075: repeated authentication failures for an account and client address slow every
// further attempt down, and each failure is an audit row. Shared by IMAP, submission, DAV and
// ManageSieve.
//
// How a daemon uses it, around every credential check:
//
//   const gate = await throttle.before({ protocol, username, ip }, signal);  // may sleep
//   if (gate.outcome === 'aborted') return;                                   // client went away
//   if (gate.outcome === 'refuse') reply temporary failure (454 4.7.0 / * BYE / 503)
//   ok ? await throttle.success(ctx) : await throttle.failure(ctx, reason)
//
// The tarpit runs BEFORE the credentials are evaluated, so a guesser cannot learn anything faster
// by dropping the connection early, and the reply to a failure is the same whatever the reason.
//
// Decisions (PST-T-3.4):
// - Failures are counted from audit_event (see ledger.ts), not memory: the count survives restarts
//   and is shared across daemon containers, and no new table is needed.
// - A success is NOT an audit row — IMAP clients reconnect constantly and would flood the log. It
//   is an in-memory "last success" per (username, network), bounded, per process: a success ends
//   the streak in that daemon; another daemon still sees the earlier failures until they age out of
//   the window. Failures are never deleted.
import { setTimeout as delay } from 'node:timers/promises';
import type { Db } from '@postroom/db';
import { auditLedger, type FailureLedger } from './ledger.js';
import { networkOf, normalizeIp, sourceOf } from './network.js';

export interface AuthAttempt {
  /** `imap`, `submission`, `dav`, `managesieve`. */
  readonly protocol: string;
  /** As the client sent it; lowercased here. Empty when the exchange never yielded one. */
  readonly username: string;
  readonly ip: string;
}

export type GateOutcome = 'proceed' | 'refuse' | 'aborted';

export interface Gate {
  /** `refuse`: answer a temporary failure without checking the credentials. */
  readonly outcome: GateOutcome;
  /** The tarpit applied (or begun, when aborted). */
  readonly delayMs: number;
  /** Failures in the current (username, network) streak, and from the source across usernames. */
  readonly streak: number;
  readonly sourceFailures: number;
}

export interface AuthThrottle {
  before(attempt: AuthAttempt, signal?: AbortSignal): Promise<Gate>;
  failure(attempt: AuthAttempt, reason: string): Promise<void>;
  success(attempt: AuthAttempt): Promise<void>;
  /** The delay `before` would apply for these counts; pure. */
  delayFor(streak: number, sourceFailures: number): number;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

interface CommonOptions {
  readonly now?: () => number;
  /** Must reject (any error) when `signal` aborts. Default: timers/promises setTimeout. */
  readonly sleep?: Sleep;
  readonly windowMs?: number;
  /** Failures in a streak before any delay. Default 3: the 4th attempt waits 1 s. */
  readonly freeFailures?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Failures from one source in the window, any usernames, at which it is refused. Default 20. */
  readonly sourceCeiling?: number;
  /** Bound on remembered successes. */
  readonly maxTracked?: number;
}

export type AuthThrottleOptions = CommonOptions & ({ readonly db: Db } | { readonly ledger: FailureLedger });

const defaultSleep: Sleep = (ms, signal) => (ms <= 0 ? Promise.resolve() : delay(ms, undefined, signal === undefined ? {} : { signal }));

export function createAuthThrottle(options: AuthThrottleOptions): AuthThrottle {
  const ledger = 'ledger' in options ? options.ledger : auditLedger(options.db);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const freeFailures = options.freeFailures ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sourceCeiling = options.sourceCeiling ?? 20;
  const maxTracked = options.maxTracked ?? 10_000;
  const lastSuccess = new Map<string, number>();

  const keys = (a: AuthAttempt): { username: string; ip: string; network: string; source: string; streakKey: string } => {
    const username = a.username.trim().toLowerCase();
    const ip = normalizeIp(a.ip);
    const network = networkOf(ip);
    return { username, ip, network, source: sourceOf(ip), streakKey: `${username}\u0000${network}` };
  };

  const delayFor = (streak: number, sourceFailures: number): number => {
    if (sourceFailures >= sourceCeiling) return maxDelayMs;
    const over = streak - freeFailures;
    if (over < 0) return 0;
    return Math.min(maxDelayMs, baseDelayMs * 2 ** over);
  };

  return {
    delayFor,

    async before(attempt, signal) {
      const k = keys(attempt);
      const t = now();
      const since = t - windowMs;
      const succeeded = lastSuccess.get(k.streakKey);
      const streakSince = succeeded !== undefined && succeeded > since ? succeeded : since;
      const counts = await ledger.count({
        username: k.username,
        network: k.network,
        source: k.source,
        since: new Date(since),
        streakSince: new Date(streakSince),
      });
      const delayMs = delayFor(counts.streak, counts.source);
      const gate = { delayMs, streak: counts.streak, sourceFailures: counts.source };
      // A function, not a narrowed property: the signal changes while we await.
      const aborted = (): boolean => signal?.aborted === true;
      if (aborted()) return { outcome: 'aborted', ...gate };
      if (delayMs > 0) {
        try {
          await sleep(delayMs, signal);
        } catch (err) {
          if (aborted()) return { outcome: 'aborted', ...gate };
          throw err;
        }
      }
      return { outcome: counts.source >= sourceCeiling ? 'refuse' : 'proceed', ...gate };
    },

    async failure(attempt, reason) {
      const k = keys(attempt);
      await ledger.record({ protocol: attempt.protocol, username: k.username, ip: k.ip, network: k.network, source: k.source, reason });
    },

    success(attempt) {
      const k = keys(attempt);
      lastSuccess.delete(k.streakKey);
      if (lastSuccess.size >= maxTracked) {
        // Oldest first (Map keeps insertion order, and a refresh re-inserts at the end).
        const oldest = lastSuccess.keys().next();
        if (oldest.done !== true) lastSuccess.delete(oldest.value);
      }
      lastSuccess.set(k.streakKey, now());
      return Promise.resolve();
    },
  };
}
