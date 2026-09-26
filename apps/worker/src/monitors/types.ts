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
}
