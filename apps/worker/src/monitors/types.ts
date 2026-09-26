// The monitor contract every health check implements (PST-T-4.7): a name for its dedupe/state key
// and a `check` that never throws in practice — a throw is treated as a firing condition by the
// runner, so an implementation may still throw, but should not rely on that path for a normal
// finding.
export interface MonitorCheckResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly value?: unknown;
}

export interface Monitor {
  readonly name: string;
  check(): Promise<MonitorCheckResult>;
  /** A minimum spacing between calls to `check()`, honoured by the runner via the monitor's
   * persisted `checkedAt` (PST-T-7.3) — for a check whose target rate-limits or bans a frequent
   * querier (a DNSBL zone). Between checks the runner reuses the last persisted result rather than
   * calling `check()` again, so a worker restart never triggers an immediate re-query storm. Omit
   * (or leave undefined) for "run on every tick", the default for every other monitor. */
  readonly minIntervalMs?: number | undefined;
}
