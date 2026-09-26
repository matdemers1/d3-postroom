// The worker daemon: runs the inbound pipeline (PST-T-2.7) on the 'inbound' queue — verify, parse,
// classify, sieve, file, notify — for every message smtp-in spooled. ACME, backups and the restore
// drill join it in later phases.
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { createDb } from '@postroom/db';
import { envInt, envString, runDaemon } from '@postroom/daemon';
import { startWorker } from '@postroom/queue';
import { DAEMON } from './daemon.js';
import { inboundHealth } from './health.js';
import { createInboundPipeline, INBOUND_QUEUE } from './pipeline.js';

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9106),
  start: async (ctx) => {
    const databaseUrl = envString(ctx.env, 'DATABASE_URL', '');
    if (databaseUrl === '') throw new Error('DATABASE_URL is required');
    const db = createDb(databaseUrl);
    const blobRoot = envString(ctx.env, 'BLOB_ROOT', '/var/lib/postroom/blobs');
    // Opened on first use, so the daemon boots (and reports health) before a message needs the KEK.
    let blobs: BlobStore | undefined;
    const getBlobs = (): BlobStore => (blobs ??= createBlobStore({ root: blobRoot, db, kek: loadKek({ env: ctx.env }) }));
    const lazyBlobs: BlobStore = {
      get root() { return blobRoot; },
      put: (source, opts) => getBlobs().put(source, opts),
      get: (sha256) => getBlobs().get(sha256),
      getBuffer: (sha256) => getBlobs().getBuffer(sha256),
      stat: (sha256) => getBlobs().stat(sha256),
      release: (sha256, tx) => getBlobs().release(sha256, tx),
      reap: (sha256) => getBlobs().reap(sha256),
      verify: (sha256) => getBlobs().verify(sha256),
      gc: (opts) => getBlobs().gc(opts),
    };
    const pipeline = createInboundPipeline({ db, blobs: lazyBlobs, log: ctx.log });
    const leaseMs = envInt(ctx.env, 'INBOUND_LEASE_MS', 300_000);
    const worker = await startWorker({
      db,
      databaseUrl,
      queues: { [INBOUND_QUEUE]: pipeline.handle },
      pollMs: envInt(ctx.env, 'INBOUND_POLL_MS', 5_000),
      leaseMs,
      log: ctx.log,
    });
    ctx.addHealth(async () => ({ inbound: await inboundHealth(db) }));
    ctx.log('inbound-worker', { leaseMs, blobRoot });
    ctx.onShutdown(async () => {
      await worker.stop();
      await db.$disconnect();
    });
  },
});
