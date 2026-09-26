// The delivery worker in its own process, so the kill -9 test can really kill it. Wired exactly
// like main.ts, but with the sink transport and short timings.
import { createBlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { createDb } from '@postroom/db';
import { startWorker } from '@postroom/queue';
import { OUTBOUND_QUEUE } from '../../../src/enqueue.js';
import { createDeliveryWorker } from '../../../src/worker.js';
import { sinkTransport } from './sink-transport.js';

const env = process.env;
const need = (name: string): string => {
  const v = env[name];
  if (v === undefined || v === '') throw new Error(`${name} is required`);
  return v;
};
const databaseUrl = need('DATABASE_URL');
const leaseMs = Number(need('LEASE_MS'));
const log = (event: string, fields: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, event, ...fields })}\n`);
};

const db = createDb(databaseUrl);
const blobs = createBlobStore({ root: need('BLOB_ROOT'), db, kek: loadKek({ env }) });
const delivery = createDeliveryWorker({
  db,
  transports: { direct: sinkTransport(Number(need('SINK_PORT'))) },
  openMessage: (sha) => blobs.get(sha),
  leaseMs,
  attemptTimeoutMs: Number(need('ATTEMPT_TIMEOUT_MS')),
  log,
});
await delivery.sweep();
setInterval(() => {
  delivery.sweep().catch((error: unknown) => { log('sweep-error', { error: String(error) }); });
}, 200);
await startWorker({ db, databaseUrl, queues: { [OUTBOUND_QUEUE]: delivery.handle }, pollMs: 100, leaseMs, log });
log('ready');
