// PST-T-5.3: the naive Bayes training loop — drain pending move events once at start, then on an
// interval. Errors are logged and retried next tick; an event is only stamped when it was applied.
import type { BlobStore } from '@postroom/blobstore';
import type { Db } from '@postroom/db';
import { createTrainingConsumer, type TrainingConsumer } from './consumer.js';
import { blobHeaderReader } from './headers.js';

export { createTrainingConsumer, DEFAULT_BATCH, TRAINING_LOCK, type TrainingBatch, type TrainingConsumer, type TrainingOutcome } from './consumer.js';
export { blobHeaderReader, MAX_HEADER_BYTES } from './headers.js';
export { loadBayesModel } from './model.js';

export interface TrainingLoop {
  readonly consumer: TrainingConsumer;
  stop(): Promise<void>;
}

export function startTrainingLoop(deps: {
  db: Db;
  blobs: Pick<BlobStore, 'get'>;
  intervalMs: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
}): TrainingLoop {
  const consumer = createTrainingConsumer({ db: deps.db, readHeaders: blobHeaderReader(deps.blobs), log: deps.log });
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (running !== null) return;
    running = consumer
      .drain()
      .then(() => undefined)
      .catch((err: unknown) => {
        deps.log('bayes-training-error', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, deps.intervalMs);
  return {
    consumer,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
