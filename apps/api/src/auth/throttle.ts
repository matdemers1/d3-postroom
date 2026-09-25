// Failed-sign-in throttle, per (login, IP), decided BEFORE any hashing: Argon2id is deliberately
// expensive, so an unthrottled endpoint is a CPU amplifier. It delays with doubling and never
// locks out — Postroom has one operator, and a lockout an attacker can trigger is a free DoS.
// In memory: one api process, and a restart forgetting a few failures is harmless.

export const FREE_ATTEMPTS = 5;
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 5 * 60 * 1000;
/** A quiet period long enough that yesterday's typos do not slow today's sign-in. */
export const DECAY_MS = 15 * 60 * 1000;
const MAX_KEYS = 10_000;

interface Entry {
  failures: number;
  lastFailureAt: number;
  nextAllowedAt: number;
}

export function delayFor(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS), MAX_DELAY_MS);
}

export class SignInThrottle {
  private readonly entries = new Map<string, Entry>();

  private static key(login: string, ip: string): string {
    return `${login.trim().toLowerCase()}\u0000${ip}`;
  }

  /** Milliseconds until another attempt is allowed; zero when allowed now. */
  retryAfter(login: string, ip: string, now: number): number {
    const entry = this.entries.get(SignInThrottle.key(login, ip));
    if (entry === undefined) return 0;
    return Math.max(0, entry.nextAllowedAt - now);
  }

  recordFailure(login: string, ip: string, now: number): void {
    const key = SignInThrottle.key(login, ip);
    const existing = this.entries.get(key);
    const stale = existing !== undefined && now - existing.lastFailureAt > DECAY_MS;
    const failures = existing === undefined || stale ? 1 : existing.failures + 1;
    if (existing === undefined && this.entries.size >= MAX_KEYS) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { failures, lastFailureAt: now, nextAllowedAt: now + delayFor(failures) });
  }

  clear(login: string, ip: string): void {
    this.entries.delete(SignInThrottle.key(login, ip));
  }
}
