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
   * (or leave undefined) for "run on every tick", the default for every other monitor.
   *
   * `minIntervalMs` only ever rate-limits the *check* itself: an alert still awaiting delivery for
   * an already-detected transition is retried on every tick regardless (PST-T-4.7's
   * retry-until-delivered still applies unconditionally). */
  readonly minIntervalMs?: number | undefined;
  /** A stable signature of what `check()` last examined (e.g. the IP and zone set for `blocklist`).
   * When present, the runner persists it alongside `checkedAt` and only honours `minIntervalMs`
   * while the signature is unchanged — a changed target (a changed EDGE_PUBLIC_IP) is always due
   * immediately, never held back by a stale cached result for the old target (PST-T-7.3). */
  readonly inputKey?: (() => string) | undefined;
}
