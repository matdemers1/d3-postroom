// A per-IP AUTH failure counter with a tarpit, in memory and per process. PST-T-3.4 replaces it
// with the shared throttle; until then this is enough to make guessing an app password slow.
//
// The first `freeFailures` failures in a window cost nothing extra; each one after that doubles the
// delay before the 535 goes out (capped). At `lockoutFailures` the IP is refused outright with a
// 454 until the window ends, without a password check.

export interface AuthThrottleOptions {
  readonly windowMs?: number;
  readonly freeFailures?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly lockoutFailures?: number;
  readonly now?: () => number;
}

interface Entry {
  failures: number;
  firstAt: number;
}

const MAX_TRACKED = 10_000;

export class AuthThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly windowMs: number;
  private readonly freeFailures: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly lockoutFailures: number;
  private readonly now: () => number;

  constructor(options: AuthThrottleOptions = {}) {
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.freeFailures = options.freeFailures ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.lockoutFailures = options.lockoutFailures ?? 20;
    this.now = options.now ?? Date.now;
  }

  private entry(ip: string): Entry | undefined {
    const e = this.entries.get(ip);
    if (e === undefined) return undefined;
    if (this.now() - e.firstAt >= this.windowMs) {
      this.entries.delete(ip);
      return undefined;
    }
    return e;
  }

  failures(ip: string): number {
    return this.entry(ip)?.failures ?? 0;
  }

  /** True when the IP has spent its failures for this window: refuse without checking. */
  isLocked(ip: string): boolean {
    return this.failures(ip) >= this.lockoutFailures;
  }

  /** Record a failure; returns how long to wait before answering it. */
  fail(ip: string): number {
    const e = this.entry(ip);
    if (e === undefined) {
      if (this.entries.size >= MAX_TRACKED) this.prune();
      this.entries.set(ip, { failures: 1, firstAt: this.now() });
    } else {
      e.failures += 1;
    }
    return this.delayFor(ip);
  }

  delayFor(ip: string): number {
    const over = this.failures(ip) - this.freeFailures;
    if (over <= 0) return 0;
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (over - 1));
  }

  succeed(ip: string): void {
    this.entries.delete(ip);
  }

  private prune(): void {
    const now = this.now();
    for (const [ip, e] of this.entries) if (now - e.firstAt >= this.windowMs) this.entries.delete(ip);
    // Still full of live entries: forget the oldest rather than grow without bound.
    while (this.entries.size >= MAX_TRACKED) {
      const first = this.entries.keys().next();
      if (first.done === true) break;
      this.entries.delete(first.value);
    }
  }
}
