// The monitor runner (PST-REQ-096, PST-REQ-097): on every tick, run each monitor and alert exactly
// once on an ok→firing transition and once again on firing→ok, through the D3 Auth relay
// (`SendAlert`) — never Postroom's own queue. State is persisted per monitor under a `setting` row
// (`monitor:<name>`) so a restart mid-incident does not repeat the alert, and cleared/updated only
// on a transition, so a condition that holds for many ticks in a row alerts once.
//
// Firing and recovery use distinct dedupe keys (`...:firing` / `...:recovery`) so `@postroom/alerts`'
// one-hour same-key dedupe can never swallow a recovery that follows closely after its alert.
import type { Db, Prisma } from '@postroom/db';
import type { SendAlert } from '@postroom/alerts';
import type { Monitor, MonitorCheckResult } from './types.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface MonitorStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** When this ok/firing state began. */
  readonly since: string;
}

interface PersistedMonitorState {
  readonly state: 'ok' | 'firing';
  readonly since: string;
  readonly detail: string;
}

export function monitorStateKey(name: string): string {
  return `monitor:${name}`;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function readState(db: Db, name: string): Promise<PersistedMonitorState | null> {
  const row = await db.setting.findUnique({ where: { key: monitorStateKey(name) } });
  return row === null ? null : (row.value as unknown as PersistedMonitorState);
}

async function writeState(db: Db, name: string, value: PersistedMonitorState): Promise<void> {
  const key = monitorStateKey(name);
  await db.setting.upsert({ where: { key }, create: { key, value: toJson(value) }, update: { value: toJson(value) } });
}

async function runCheck(monitor: Monitor): Promise<MonitorCheckResult> {
  try {
    return await monitor.check();
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface MonitorRunnerOptions {
  readonly db: Db;
  readonly monitors: readonly Monitor[];
  readonly sendAlert: SendAlert;
  readonly log?: Log | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface MonitorRunner {
  /** Run every monitor once, alerting on any transition. Never throws. */
  runOnce(): Promise<void>;
  /** The latest known status per monitor, for /health. */
  statuses(): MonitorStatus[];
}

export function createMonitorRunner(opts: MonitorRunnerOptions): MonitorRunner {
  const log = opts.log ?? ((): void => undefined);
  const now = opts.now ?? ((): Date => new Date());
  const current = new Map<string, MonitorStatus>();

  async function runOne(monitor: Monitor): Promise<void> {
    const result = await runCheck(monitor);
    const prior = await readState(opts.db, monitor.name);
    const wasFiring = prior?.state === 'firing';
    const nowIso = now().toISOString();

    if (!result.ok && !wasFiring) {
      await writeState(opts.db, monitor.name, { state: 'firing', since: nowIso, detail: result.detail });
      const sent = await opts.sendAlert({
        subject: `[Postroom] FIRING: ${monitor.name}`,
        text: `${monitor.name} — ${result.detail}`,
        key: `${monitorStateKey(monitor.name)}:firing`,
      });
      log('monitor-firing', { name: monitor.name, detail: result.detail, sent: sent.sent, reason: sent.reason });
      current.set(monitor.name, { name: monitor.name, ok: false, detail: result.detail, since: nowIso });
      return;
    }

    if (result.ok && wasFiring) {
      await writeState(opts.db, monitor.name, { state: 'ok', since: nowIso, detail: result.detail });
      const sent = await opts.sendAlert({
        subject: `[Postroom] RESOLVED: ${monitor.name}`,
        text: `${monitor.name} recovered — ${result.detail}`,
        key: `${monitorStateKey(monitor.name)}:recovery`,
      });
      log('monitor-recovered', { name: monitor.name, detail: result.detail, sent: sent.sent, reason: sent.reason });
      current.set(monitor.name, { name: monitor.name, ok: true, detail: result.detail, since: nowIso });
      return;
    }

    // Steady state (ok→ok or firing→firing): no alert, no write — `since` keeps the transition time.
    current.set(monitor.name, { name: monitor.name, ok: result.ok, detail: result.detail, since: prior?.since ?? nowIso });
  }

  return {
    runOnce: async (): Promise<void> => {
      for (const monitor of opts.monitors) {
        await runOne(monitor);
      }
    },
    statuses: (): MonitorStatus[] => Array.from(current.values()),
  };
}
