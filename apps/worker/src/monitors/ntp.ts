// NTP skew (PST-REQ-100, PST-REQ-097): query NTP_SERVER by SNTP and fire when the offset exceeds
// `thresholdMs`. Also exposes the latest reading (updated on every check, ok or not) for /health,
// independent of the runner's alert cadence. Disabled (returns null) with no server configured —
// the daemon must not reach the public internet unless told to (PST-T-4.7).
import { querySntp, type SntpQueryOptions, type SntpResult } from './sntp.js';
import type { Monitor } from './types.js';

export interface NtpStatus {
  readonly synchronized: boolean;
  readonly offsetMs: number;
  readonly server: string;
  readonly checkedAt: string;
}

export interface NtpMonitor extends Monitor {
  /** The last reading, or null before the first check has run. */
  getStatus(): NtpStatus | null;
}

export interface NtpMonitorOptions {
  readonly server: string;
  readonly thresholdMs?: number | undefined;
  readonly query?: ((opts: SntpQueryOptions) => Promise<SntpResult>) | undefined;
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_THRESHOLD_MS = 2_000;

export function createNtpMonitor(opts: NtpMonitorOptions): NtpMonitor | null {
  if (opts.server === '') return null;
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const query = opts.query ?? querySntp;
  const now = opts.now ?? ((): Date => new Date());
  let status: NtpStatus | null = null;

  return {
    name: 'ntp',
    check: async () => {
      const result = await query({ host: opts.server });
      const synchronized = Math.abs(result.offsetMs) <= thresholdMs;
      status = { synchronized, offsetMs: result.offsetMs, server: opts.server, checkedAt: now().toISOString() };
      return {
        ok: synchronized,
        detail: synchronized
          ? `offset ${result.offsetMs.toFixed(1)}ms from ${opts.server}, within ${String(thresholdMs)}ms`
          : `offset ${result.offsetMs.toFixed(1)}ms from ${opts.server} exceeds ${String(thresholdMs)}ms`,
        value: status,
      };
    },
    getStatus: () => status,
  };
}
