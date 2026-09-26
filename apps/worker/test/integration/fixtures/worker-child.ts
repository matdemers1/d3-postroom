// The inbound worker in its own process, so the kill -9 test can really kill it. Wired like
// main.ts, with a short lease and an optional place to park forever: PAUSE_AT=<stage> parks just
// before that stage starts; PAUSE_AT=file-tx parks inside the file stage's open transaction, after
// the copies are written and before the commit.
import { createBlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { createDb } from '@postroom/db';
import { startWorker } from '@postroom/queue';
import { createInboundPipeline, INBOUND_QUEUE } from '../../../src/pipeline.js';
import type { PipelineFaults } from '../../../src/stages/types.js';

const env = process.env;
const need = (name: string): string => {
  const v = env[name];
  if (v === undefined || v === '') throw new Error(`${name} is required`);
  return v;
};
const databaseUrl = need('DATABASE_URL');
const leaseMs = Number(need('LEASE_MS'));
const pauseAt = env['PAUSE_AT'] ?? '';
const log = (event: string, fields: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, event, ...fields })}\n`);
};
const park = (where: string): Promise<void> => {
  log('paused', { where });
  return new Promise<void>(() => undefined);
};

const faults: PipelineFaults = {
  beforeStage: (stage) => (stage === pauseAt ? park(stage) : Promise.resolve()),
  inFileTransaction: () => (pauseAt === 'file-tx' ? park('file-tx') : Promise.resolve()),
};

const db = createDb(databaseUrl);
const blobs = createBlobStore({ root: need('BLOB_ROOT'), db, kek: loadKek({ env }) });
const pipeline = createInboundPipeline({ db, blobs, log, faults });
await startWorker({ db, databaseUrl, queues: { [INBOUND_QUEUE]: pipeline.handle }, pollMs: 100, leaseMs, log });
log('ready');
