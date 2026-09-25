// The Postgres job queue every Postroom stage runs on (PST-T-1.5, PST-T-2.7). Jobs are rows in
// `job`; a worker claims one with FOR UPDATE SKIP LOCKED, so any number of workers can run without
// a broker, and a crashed worker's claim expires and is retried. `enqueue` is idempotent by key, so
// a producer that crashed between its commit and its enqueue can safely enqueue again.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { Db, Job, Prisma } from '@postroom/db';

export const PACKAGE = '@postroom/queue';

type Tx = Prisma.TransactionClient | Db;

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
}

/** Add a job. Inside a caller's transaction it commits (and wakes workers) with the caller's rows. */
export async function enqueue(tx: Tx, queue: string, payload: Prisma.InputJsonValue, options: EnqueueOptions = {}): Promise<Job | null> {
  if (options.idempotencyKey !== undefined) {
    const existing = await tx.job.findUnique({ where: { idempotencyKey: options.idempotencyKey } });
    if (existing !== null) return null;
  }
  return tx.job.create({
    data: {
      queue,
      payload,
      runAt: options.runAt ?? new Date(),
      maxAttempts: options.maxAttempts ?? 10,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    },
  });
}

/** Exponential backoff with full jitter, capped: attempt 1 → up to base, doubling to `capMs`. */
export function backoffMs(attempt: number, baseMs = 30_000, capMs = 3_600_000, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

export interface ClaimOptions {
  workerId: string;
  /** A claim older than this is presumed dead (its worker crashed) and may be taken again. */
  leaseMs?: number;
  now?: Date;
}

/** Claim the next due job on `queue`, or null. The claim is committed before the handler runs. */
export async function claim(db: Db, queue: string, options: ClaimOptions): Promise<Job | null> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (options.leaseMs ?? 300_000));
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE job SET status = 'running', locked_at = ${now}, locked_by = ${options.workerId}, attempts = attempts + 1
    WHERE id = (
      SELECT id FROM job
      WHERE queue = ${queue}
        AND ((status = 'pending' AND run_at <= ${now})
          OR (status = 'running' AND locked_at < ${staleBefore}))
      ORDER BY run_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id`;
  const id = rows[0]?.id;
  return id === undefined ? null : db.job.findUnique({ where: { id } });
}

export async function complete(db: Db, job: Pick<Job, 'id' | 'lockedBy'>): Promise<void> {
  await db.job.updateMany({
    where: { id: job.id, status: 'running', lockedBy: job.lockedBy },
    data: { status: 'done', finishedAt: new Date(), lockedAt: null },
  });
}

/** Record a failure: retry after backoff, or `dead` once attempts are spent (visible, replayable). */
export async function fail(db: Db, job: Pick<Job, 'id' | 'attempts' | 'maxAttempts' | 'lockedBy'>, error: unknown, options: { retryAt?: Date; now?: Date } = {}): Promise<'retry' | 'dead'> {
  const now = options.now ?? new Date();
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const dead = job.attempts >= job.maxAttempts;
  await db.job.updateMany({
    where: { id: job.id, status: 'running', lockedBy: job.lockedBy },
    data: dead
      ? { status: 'dead', lastError: message.slice(0, 4000), finishedAt: now, lockedAt: null }
      : { status: 'pending', lastError: message.slice(0, 4000), lockedAt: null, runAt: options.retryAt ?? new Date(now.getTime() + backoffMs(job.attempts)) },
  });
  return dead ? 'dead' : 'retry';
}

/** Put a dead or done job back in line — the "replayable stages" promise (PST-T-2.7). */
export async function replay(db: Db, id: string): Promise<void> {
  await db.job.update({ where: { id }, data: { status: 'pending', attempts: 0, runAt: new Date(), lastError: null, finishedAt: null, lockedAt: null, lockedBy: null } });
}

export type Handler = (job: Job) => Promise<void>;

export interface WorkerOptions {
  db: Db;
  /** For LISTEN; a dedicated connection outside Prisma's pool. */
  databaseUrl: string;
  queues: Record<string, Handler>;
  workerId?: string;
  pollMs?: number;
  leaseMs?: number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface RunningWorker {
  stop: () => Promise<void>;
  /** Run every due job once and return how many ran (tests use this instead of timers). */
  drain: () => Promise<number>;
}

/** Process jobs until stopped: woken by NOTIFY, with a slow poll as the backstop. */
export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  const log = options.log ?? (() => undefined);
  let stopped = false;
  const isStopped = (): boolean => stopped;
  let running: Promise<void> = Promise.resolve();
  let wake: (() => void) | undefined;

  const runOne = async (queue: string, handler: Handler): Promise<boolean> => {
    const job = await claim(options.db, queue, { workerId, ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }) });
    if (job === null) return false;
    try {
      await handler(job);
      await complete(options.db, job);
      log('job-done', { queue, id: job.id, attempts: job.attempts });
    } catch (error) {
      const outcome = await fail(options.db, job, error);
      log('job-failed', { queue, id: job.id, attempts: job.attempts, outcome, error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  };

  const drain = async (): Promise<number> => {
    let ran = 0;
    for (;;) {
      let any = false;
      for (const [queue, handler] of Object.entries(options.queues)) {
        if (stopped) return ran;
        if (await runOne(queue, handler)) { any = true; ran++; }
      }
      if (!any) return ran;
    }
  };

  const listener = new pg.Client({ connectionString: options.databaseUrl });
  await listener.connect();
  listener.on('notification', (msg) => {
    if (msg.payload !== undefined && msg.payload in options.queues) wake?.();
  });
  listener.on('error', (error) => { log('listen-error', { error: error.message }); });
  await listener.query('LISTEN postroom_job');

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await drain();
      } catch (error) {
        log('drain-error', { error: error instanceof Error ? error.message : String(error) });
      }
      // `stop()` may have run while drain() awaited; TypeScript cannot see that through the closure.
      if (isStopped()) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.pollMs ?? 5_000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
      wake = undefined;
    }
  };
  running = loop();

  return {
    drain,
    stop: async () => {
      stopped = true;
      wake?.();
      await running;
      await listener.end();
    },
  };
}
