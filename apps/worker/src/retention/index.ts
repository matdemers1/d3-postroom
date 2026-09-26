// PST-T-7.7 (PST-REQ-129, PST-REQ-130): the retention loop — sweep once at start, then on an
// interval. Errors are logged and the next tick tries again; every batch is its own transaction,
// so a failed run leaves nothing half done.
import type { BlobStore } from '@postroom/blobstore';
import type { Db } from '@postroom/db';
import { createRetentionSweeper, type Log, type RetentionSweeper } from './sweep.js';

export { DAY_MS, DEFAULT_RETENTION_DAYS, effectiveDays, retentionAction, type RetentionAction } from './policy.js';
export {
  createRetentionSweeper,
  DEFAULT_BATCH,
  DEFAULT_MAX_BATCHES,
  DEFAULT_SPOOL_GRACE_MS,
  MAILBOX_CHANNEL,
  type RetentionDeps,
  type RetentionOptions,
  type RetentionResult,
  type RetentionSweeper,
} from './sweep.js';

export interface RetentionLoop {
  readonly sweep: RetentionSweeper;
  stop(): Promise<void>;
}

export function startRetentionLoop(deps: {
  db: Db;
  blobs: Pick<BlobStore, 'release' | 'reap' | 'gc'>;
  intervalMs: number;
  log: Log;
}): RetentionLoop {
  const sweep = createRetentionSweeper({ db: deps.db, blobs: deps.blobs, log: deps.log });
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (running !== null) return;
    running = sweep()
      .then(() => undefined)
      .catch((err: unknown) => {
        deps.log('retention-sweep-error', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, deps.intervalMs);
  return {
    sweep,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
