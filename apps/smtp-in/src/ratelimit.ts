// Per-network rate limits for smtp-in (PST-REQ-185): connections per minute, and unknown recipients
// per ten minutes, each counted per client /24 (IPv4) or /64 (IPv6) — the same network grouping
// greylisting uses, because a spammer's pool is a block of addresses, not one.
//
// A fixed window per network: the first event opens the window, events inside it are counted, and
// once it has passed the next event starts a fresh one. A network over the limit is refused (421)
// until its window passes; being refused does not extend the window, so a client that keeps
// hammering still gets back in when the window it tripped ends.
//
// State is in memory, per daemon. smtp-in runs as a single instance behind the edge, so there is no
// other process to share it with, and a restart forgetting the counters costs at most one window of
// leniency. The map is bounded: expired windows are swept when it reaches `maxKeys`, and if every
// entry is still live the oldest window is evicted — an attacker cycling through many networks can
// make us forget one, but can never make the map grow without limit.
import { isPrivateClient, networkOf } from './greylist.js';

export interface WindowCounterOptions {
  /** Events allowed per window; the (limit+1)th is over. */
  readonly limit: number;
  readonly windowMs: number;
  /** The most networks tracked at once. Default 50,000. */
  readonly maxKeys?: number;
  readonly now?: () => number;
}

interface Window {
  readonly start: number;
  count: number;
}

export interface CountResult {
  /** True when this event took the network over its limit (or it already was). */
  readonly over: boolean;
  readonly count: number;
  /** When the current window ends, ms since the epoch. */
  readonly resetAt: number;
}

export const DEFAULT_MAX_KEYS = 50_000;

/** Fixed-window counters keyed by a string, bounded to `maxKeys` entries. */
export class WindowCounter {
  private readonly windows = new Map<string, Window>();
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(private readonly opts: WindowCounterOptions) {
    this.maxKeys = Math.max(opts.maxKeys ?? DEFAULT_MAX_KEYS, 1);
    this.now = opts.now ?? Date.now;
  }

  /** The live window for `key`, or undefined when there is none (or it has passed). */
  private live(key: string, now: number): Window | undefined {
    const w = this.windows.get(key);
    if (w === undefined) return undefined;
    if (now - w.start >= this.opts.windowMs) {
      this.windows.delete(key);
      return undefined;
    }
    return w;
  }

  /** Count one event for `key`. */
  hit(key: string): CountResult {
    const now = this.now();
    let w = this.live(key, now);
    if (w === undefined) {
      this.makeRoom(now);
      w = { start: now, count: 0 };
      // Insertion order is window-start order, which is what eviction relies on.
      this.windows.set(key, w);
    }
    w.count++;
    return { over: w.count > this.opts.limit, count: w.count, resetAt: w.start + this.opts.windowMs };
  }

  /** Whether `key` is over its limit right now, without counting anything. */
  isOver(key: string): boolean {
    const w = this.live(key, this.now());
    return w !== undefined && w.count > this.opts.limit;
  }

  /** Networks currently tracked (for tests and /health). */
  size(): number {
    return this.windows.size;
  }

  private makeRoom(now: number): void {
    if (this.windows.size < this.maxKeys) return;
    for (const [key, w] of this.windows) {
      if (now - w.start >= this.opts.windowMs) this.windows.delete(key);
    }
    // Still full of live windows: drop the oldest. Map iteration is insertion order.
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done === true) break;
      this.windows.delete(oldest.value);
    }
  }
}

export interface RateLimitOptions {
  /** SMTP_IN_CONN_PER_MIN: connections allowed per network per window. */
  readonly connectionsPerWindow: number;
  readonly connectionWindowMs: number;
  /** SMTP_IN_UNKNOWN_RCPT_PER_10MIN: unknown recipients allowed per network per window. */
  readonly unknownRecipientsPerWindow: number;
  readonly unknownRecipientWindowMs: number;
  readonly maxKeys?: number;
  readonly now?: () => number;
}

export const RATE_LIMIT_DEFAULTS = {
  connectionsPerWindow: 30,
  connectionWindowMs: 60_000,
  unknownRecipientsPerWindow: 20,
  unknownRecipientWindowMs: 600_000,
} as const satisfies RateLimitOptions;

export type RateLimitRefusal = { readonly limit: 'connection-rate' | 'unknown-recipients'; readonly network: string; readonly resetAt?: number };

/**
 * Both limits for one daemon. Hosts on the LAN/tailnet and the loopback are exempt, as they are
 * from greylisting: the limits exist for strangers on the internet, and with PROXY v2 the address
 * here is the real client's, so an internet client never looks private.
 */
export class InboundRateLimits {
  private readonly connections: WindowCounter;
  private readonly unknownRcpts: WindowCounter;

  constructor(opts: RateLimitOptions) {
    const common = { ...(opts.maxKeys === undefined ? {} : { maxKeys: opts.maxKeys }), ...(opts.now === undefined ? {} : { now: opts.now }) };
    this.connections = new WindowCounter({ limit: opts.connectionsPerWindow, windowMs: opts.connectionWindowMs, ...common });
    this.unknownRcpts = new WindowCounter({ limit: opts.unknownRecipientsPerWindow, windowMs: opts.unknownRecipientWindowMs, ...common });
  }

  /** Count a new connection; a refusal when the network is over either limit. */
  onConnect(clientIp: string): RateLimitRefusal | null {
    if (isPrivateClient(clientIp)) return null;
    const network = networkOf(clientIp);
    // A network that tripped the unknown-recipient limit stays refused until that window passes.
    if (this.unknownRcpts.isOver(network)) return { limit: 'unknown-recipients', network };
    const c = this.connections.hit(network);
    return c.over ? { limit: 'connection-rate', network, resetAt: c.resetAt } : null;
  }

  /** Count an unknown recipient; a refusal when that takes the network over its limit. */
  onUnknownRecipient(clientIp: string): RateLimitRefusal | null {
    if (isPrivateClient(clientIp)) return null;
    const network = networkOf(clientIp);
    const c = this.unknownRcpts.hit(network);
    return c.over ? { limit: 'unknown-recipients', network, resetAt: c.resetAt } : null;
  }

  /** Networks tracked, for /health. */
  tracked(): { connections: number; unknownRecipients: number } {
    return { connections: this.connections.size(), unknownRecipients: this.unknownRcpts.size() };
  }
}
