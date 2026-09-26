// The nightly scheduler (PST-T-0.16, PST-T-0.17): a timer in the worker that enqueues one 'backup'
// and one 'drill' job per UTC day, once each is due. The queue's idempotency key
// (`backup:<yyyy-mm-dd>`, `drill:<yyyy-mm-dd>`) makes the tick safe to repeat every minute, across
// restarts and across two workers: whoever enqueues first wins, everyone else is a no-op.
import type { Db } from '@postroom/db';
import { enqueue } from '@postroom/queue';
import { BACKUP_QUEUE, isoDate, type Log } from './job.js';

export const DRILL_QUEUE = 'drill';

export interface NightlyTimes {
  /** UTC `HH:MM`. */
  backupAt: string;
  drillAt: string;
}

export interface DueJob {
  queue: string;
  date: string;
  idempotencyKey: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseHhmm(value: string): number {
  const m = HHMM.exec(value);
  if (m === null) throw new Error(`expected a UTC time as HH:MM, got "${value}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The jobs due at `now`: each of today's runs whose time has passed. */
export function dueJobs(now: Date, times: NightlyTimes): DueJob[] {
  const date = isoDate(now);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const due: DueJob[] = [];
  if (minute >= parseHhmm(times.backupAt)) due.push({ queue: BACKUP_QUEUE, date, idempotencyKey: `backup:${date}` });
  if (minute >= parseHhmm(times.drillAt)) due.push({ queue: DRILL_QUEUE, date, idempotencyKey: `drill:${date}` });
  return due;
}

/** Enqueue whatever is due; returns the keys newly enqueued. */
export async function tick(db: Db, now: Date, times: NightlyTimes): Promise<string[]> {
  const enqueued: string[] = [];
  for (const job of dueJobs(now, times)) {
    const created = await enqueue(db, job.queue, { date: job.date }, { idempotencyKey: job.idempotencyKey, maxAttempts: 3 });
    if (created !== null) enqueued.push(job.idempotencyKey);
  }
  return enqueued;
}

export interface Nightly {
  stop: () => void;
}

export function startNightly(opts: { db: Db; times: NightlyTimes; log: Log; intervalMs?: number; now?: () => Date }): Nightly {
  parseHhmm(opts.times.backupAt);
  parseHhmm(opts.times.drillAt);
  const now = opts.now ?? (() => new Date());
  let busy = false;
  const run = (): void => {
    if (busy) return;
    busy = true;
    tick(opts.db, now(), opts.times).then(
      (keys) => {
        busy = false;
        if (keys.length > 0) opts.log('nightly-enqueued', { keys });
      },
      (error: unknown) => {
        busy = false;
        // Logged, and retried on the next tick: the idempotency key makes that safe.
        opts.log('nightly-enqueue-error', { error: error instanceof Error ? error.message : String(error) });
      },
    );
  };
  run();
  const timer = setInterval(run, opts.intervalMs ?? 60_000);
  timer.unref();
  return { stop: () => { clearInterval(timer); } };
}
