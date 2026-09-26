// The monitor runner (PST-REQ-096, PST-REQ-097): on every tick, run each monitor and alert exactly
// once on an ok→firing transition and once again on firing→ok, through the D3 Auth relay
// (`SendAlert`) — never Postroom's own queue.
//
// The persisted `state` (a `monitor:<name>` setting row) only ever advances once the alert for that
// transition was actually delivered — or the relay is unconfigured, which never will deliver and is
// recorded as such rather than retried forever. A configured relay that failed to send (network
// error, non-2xx) leaves `state` where it was, so the next tick's check, still seeing the old
// `state`, retries the same alert on the same episode key until it goes through (PST-T-4.7 fix #1).
//
// Each episode — one firing-to-recovery cycle — gets its own dedupe key, generated once when the
// transition is first detected and reused for every retry of that same transition, so
// `@postroom/alerts`' one-hour same-key dedupe only ever suppresses a true repeat, never a fresh
// episode that fires again within the hour (PST-T-4.7 fix #2).
//
// `runOnce` refuses to start a second pass while one is already in flight, and each monitor's
// `check()` is raced against a hard timeout — a hung check must not hang every monitor behind it,
// or every future tick (PST-T-4.7 fix #3).
import { randomUUID } from 'node:crypto';
import type { Db, Prisma } from '@postroom/db';
import type { SendAlert } from '@postroom/alerts';
import type { Monitor, MonitorCheckResult } from './types.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** How the most recent transition's alert was (or was not) delivered. */
export type AlertDeliveryStatus = 'delivered' | 'not delivered: relay unconfigured' | `not delivered: ${string}`;

export interface MonitorStatus {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** When this ok/firing state began. */
  readonly since: string;
  /** How the alert for the current (or most recently settled) transition was delivered. */
  readonly alert: AlertDeliveryStatus;
}

interface PendingTransition {
  readonly target: 'ok' | 'firing';
  readonly episodeKey: string;
  readonly detail: string;
  readonly reason: string;
}

interface PersistedMonitorState {
  /** The last transition that was actually delivered (or accepted as undeliverable-by-design). */
  readonly state: 'ok' | 'firing';
  readonly since: string;
  readonly detail: string;
  readonly alert: AlertDeliveryStatus;
  /** An in-flight transition whose alert has not yet been delivered; retried each tick until it is,
   * or until the underlying condition reverts before ever being reported. */
  readonly pending?: PendingTransition;
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

class CheckTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new CheckTimeoutError(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runCheck(monitor: Monitor, timeoutMs: number): Promise<MonitorCheckResult> {
  try {
    return await withTimeout(monitor.check(), timeoutMs, `monitor '${monitor.name}' check did not finish within ${String(timeoutMs)}ms`);
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
  /** A hard ceiling on any one monitor's check(), so a hung check cannot hang the whole tick. */
  readonly checkTimeoutMs?: number | undefined;
}

export interface MonitorRunner {
  /** Run every monitor once, alerting on any delivered transition. Never throws. A call that
   * arrives while a previous one is still running is a no-op (logged, not queued or overlapped). */
  runOnce(): Promise<void>;
  /** The latest known status per monitor, for /health. */
  statuses(): MonitorStatus[];
}

const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

function isDelivered(sent: { sent: boolean; reason?: string | undefined }): boolean {
  // A key already sent within the dedupe window means some earlier attempt for this exact episode
  // already got through — treat it the same as a fresh success, not a failure to retry forever.
  return sent.sent || sent.reason === 'deduped';
}

export function createMonitorRunner(opts: MonitorRunnerOptions): MonitorRunner {
  const log = opts.log ?? ((): void => undefined);
  const now = opts.now ?? ((): Date => new Date());
  const checkTimeoutMs = opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const current = new Map<string, MonitorStatus>();
  let running = false;

  function alertMessage(monitorName: string, target: 'ok' | 'firing', detail: string): { subject: string; text: string } {
    return target === 'firing'
      ? { subject: `[Postroom] FIRING: ${monitorName}`, text: `${monitorName} — ${detail}` }
      : { subject: `[Postroom] RESOLVED: ${monitorName}`, text: `${monitorName} recovered — ${detail}` };
  }

  async function runOne(monitor: Monitor): Promise<void> {
    const result = await runCheck(monitor, checkTimeoutMs);
    const prior = await readState(opts.db, monitor.name);
    const priorState = prior?.state ?? 'ok';
    const target: 'ok' | 'firing' = result.ok ? 'ok' : 'firing';
    const nowIso = now().toISOString();

    if (target === priorState) {
      // The confirmed state already matches. If an earlier, different-direction transition is
      // still pending delivery, the condition reverted before anyone was ever told — drop it
      // silently rather than deliver a stale alert.
      if (prior?.pending !== undefined) {
        await writeState(opts.db, monitor.name, { state: priorState, since: prior.since, detail: prior.detail, alert: prior.alert });
      }
      current.set(monitor.name, {
        name: monitor.name,
        ok: result.ok,
        detail: result.detail,
        since: prior?.since ?? nowIso,
        alert: prior?.alert ?? 'delivered',
      });
      return;
    }

    // A transition to `target` is needed: either brand new, or a retry of one already pending.
    const pending = prior?.pending?.target === target ? prior.pending : undefined;
    const episodeKey = pending?.episodeKey ?? `${monitorStateKey(monitor.name)}:${target}:${nowIso}:${randomUUID()}`;
    const { subject, text } = alertMessage(monitor.name, target, result.detail);
    const sent = await opts.sendAlert({ subject, text, key: episodeKey });
    const unconfigured = sent.reason === 'relay unconfigured';

    if (isDelivered(sent) || unconfigured) {
      const alert: AlertDeliveryStatus = unconfigured ? 'not delivered: relay unconfigured' : 'delivered';
      await writeState(opts.db, monitor.name, { state: target, since: nowIso, detail: result.detail, alert });
      log(target === 'firing' ? 'monitor-firing' : 'monitor-recovered', { name: monitor.name, detail: result.detail, alert });
      current.set(monitor.name, { name: monitor.name, ok: result.ok, detail: result.detail, since: nowIso, alert });
      return;
    }

    // The relay is configured but the send failed: do not advance `state` — keep the same episode
    // key so the next tick retries this exact alert, until it is delivered or the condition reverts.
    const reason = sent.reason ?? 'unknown';
    const nextPending: PendingTransition = { target, episodeKey, detail: result.detail, reason };
    await writeState(opts.db, monitor.name, {
      state: priorState,
      since: prior?.since ?? nowIso,
      detail: prior?.detail ?? result.detail,
      alert: prior?.alert ?? 'delivered',
      pending: nextPending,
    });
    log('monitor-alert-retry', { name: monitor.name, target, reason });
    current.set(monitor.name, {
      name: monitor.name,
      ok: result.ok,
      detail: result.detail,
      since: prior?.since ?? nowIso,
      alert: `not delivered: ${reason}`,
    });
  }

  return {
    runOnce: async (): Promise<void> => {
      if (running) {
        log('monitor-tick-skipped', { reason: 'previous tick still running' });
        return;
      }
      running = true;
      try {
        for (const monitor of opts.monitors) {
          await runOne(monitor);
        }
      } finally {
        running = false;
      }
    },
    statuses: (): MonitorStatus[] => Array.from(current.values()),
  };
}
