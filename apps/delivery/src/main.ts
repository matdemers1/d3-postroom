// Outbound delivery daemon (PST-P-1): runs the 'outbound' queue through the direct MX client
// (PST-T-1.6). It lives in the wireguard sidecar's network namespace, so :25 leaves from the edge.
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { createDb, type Prisma } from '@postroom/db';
import { envInt, envString, runDaemon } from '@postroom/daemon';
import { startWorker } from '@postroom/queue';
import { DAEMON } from './daemon.js';
import { createDsnHook } from './dsn.js';
import { OUTBOUND_QUEUE } from './enqueue.js';
import { deliveryHealth } from './health.js';
import { transportsFromEnv } from './transports/index.js';
import { createDeliveryWorker } from './worker.js';

await runDaemon({
  name: DAEMON,
  healthPort: envInt(process.env, 'HEALTH_PORT', 9104),
  start: async (ctx) => {
    const databaseUrl = envString(ctx.env, 'DATABASE_URL', '');
    if (databaseUrl === '') throw new Error('DATABASE_URL is required');
    const db = createDb(databaseUrl);
    const leaseMs = envInt(ctx.env, 'DELIVERY_LEASE_MS', 300_000);
    const attemptTimeoutMs = envInt(ctx.env, 'DELIVERY_ATTEMPT_TIMEOUT_MS', 240_000);
    const sweepMs = envInt(ctx.env, 'DELIVERY_SWEEP_MS', 60_000);
    const blobRoot = envString(ctx.env, 'BLOB_ROOT', '/var/lib/postroom/blobs');

    // Opened on first use, so the daemon boots (and reports health) before the first message
    // needs the KEK.
    let blobs: BlobStore | undefined;
    const getBlobs = (): BlobStore => (blobs ??= createBlobStore({ root: blobRoot, db, kek: loadKek({ env: ctx.env }) }));
    const openMessage = (sha256: string): ReturnType<BlobStore['get']> => getBlobs().get(sha256);

    const delivery = createDeliveryWorker({
      db,
      transports: transportsFromEnv(ctx.env, ctx.log, {
        findUnique: (args) => db.setting.findUnique(args),
        upsert: (args) =>
          db.setting.upsert({
            where: args.where,
            create: { key: args.create.key, value: args.create.value as Prisma.InputJsonValue },
            update: { value: args.update.value as Prisma.InputJsonValue },
          }),
      }),
      openMessage,
      onDsn: (intent) => createDsnHook({ db, blobstore: getBlobs(), log: ctx.log })(intent),
      leaseMs,
      attemptTimeoutMs,
      log: ctx.log,
    });

    const runSweep = async (): Promise<void> => {
      try {
        const result = await delivery.sweep();
        if (result.recovered + result.rescheduled + result.dsnRetried > 0) ctx.log('sweep', { ...result });
      } catch (error) {
        ctx.log('sweep-error', { error: error instanceof Error ? error.message : String(error) });
      }
    };
    // Recover what a previous process left mid-attempt before taking new work.
    await runSweep();
    const sweeper = setInterval(() => { void runSweep(); }, sweepMs);

    const worker = await startWorker({
      db,
      databaseUrl,
      queues: { [OUTBOUND_QUEUE]: delivery.handle },
      pollMs: envInt(ctx.env, 'DELIVERY_POLL_MS', 5_000),
      leaseMs,
      log: ctx.log,
    });
    ctx.addHealth(async () => ({ outbound: await deliveryHealth(db) }));
    ctx.log('started', { leaseMs, attemptTimeoutMs, sweepMs });
    ctx.onShutdown(async () => {
      clearInterval(sweeper);
      await worker.stop();
      await db.$disconnect();
    });
  },
});
