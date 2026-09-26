// The worker daemon: runs the inbound pipeline (PST-T-2.7) on the 'inbound' queue — verify, parse,
// classify, sieve, file, notify — for every message smtp-in spooled — and, on their own queues and
// worker, the nightly backup and restore drill (PST-T-0.16, PST-T-0.17). ACME joins in a later phase.
import { createAlertSender } from '@postroom/alerts';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { createDb } from '@postroom/db';
import { envInt, envString, runDaemon } from '@postroom/daemon';
import { startWorker } from '@postroom/queue';
import { backupHandler, BACKUP_QUEUE } from './backup/job.js';
import { DRILL_QUEUE, startNightly } from './backup/schedule.js';
import { maintenanceDeps } from './backup/wire.js';
import { DAEMON } from './daemon.js';
import { drillHandler } from './drill/drill.js';
import { inboundHealth, maintenanceHealth } from './health.js';
import { buildMonitors, createMonitorRunner } from './monitors/index.js';
import { createInboundPipeline, INBOUND_QUEUE } from './pipeline.js';
import { sweepUnthreaded } from './sweep/thread-sweep.js';

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
    // Backups and drills get their own worker, so a long dump never holds up inbound mail, and a
    // lease longer than any backup, so a running one is not claimed a second time.
    const maintenance = maintenanceDeps(ctx.env, db, databaseUrl, ctx.log);
    const maintenanceWorker = await startWorker({
      db,
      databaseUrl,
      queues: { [BACKUP_QUEUE]: backupHandler(maintenance.backup), [DRILL_QUEUE]: drillHandler(maintenance.drill) },
      pollMs: 60_000,
      leaseMs: envInt(ctx.env, 'BACKUP_LEASE_MS', 3 * 3_600_000),
      log: ctx.log,
    });
    const nightly = startNightly({
      db,
      times: { backupAt: envString(ctx.env, 'BACKUP_AT', '03:00'), drillAt: envString(ctx.env, 'DRILL_AT', '04:30') },
      log: ctx.log,
    });
    // Repairs a Message left with threadId NULL by a crash between the file stage's commit and its
    // post-commit assignThread call (PST-T-3.14, PST-REQ-078): once at start, then on an interval.
    const threadSweepMs = envInt(ctx.env, 'THREAD_SWEEP_MS', 60_000);
    const runThreadSweep = (): void => {
      sweepUnthreaded({ db, blobs: lazyBlobs, log: ctx.log, now: () => new Date() }).catch((err: unknown) => {
        ctx.log('thread-sweep-error', { error: err instanceof Error ? err.message : String(err) });
      });
    };
    runThreadSweep();
    const threadSweepTimer = setInterval(runThreadSweep, threadSweepMs);

    // Health alerts through the D3 Auth relay (PST-T-4.7, PST-REQ-096, PST-REQ-097): tunnel,
    // backlog, cert expiry, disk, blocklist, backup/drill and NTP skew, each alerting once on
    // firing and once again on recovery — never through Postroom's own outbound queue.
    const sendAlert = createAlertSender(
      {
        url: envString(ctx.env, 'MAIL_RELAY_URL', ''),
        token: envString(ctx.env, 'MAIL_RELAY_TOKEN', ''),
        to: envString(ctx.env, 'ALERT_TO', ''),
      },
      { log: ctx.log },
    );
    const { monitors, ntp } = buildMonitors({ db, env: ctx.env, backupsConfigured: maintenance.backup.config.s3 !== null });
    const monitorRunner = createMonitorRunner({ db, monitors, sendAlert, log: ctx.log });
    const monitorIntervalMs = envInt(ctx.env, 'MONITOR_INTERVAL_MS', 60_000);
    const runMonitors = (): void => {
      monitorRunner.runOnce().catch((err: unknown) => {
        ctx.log('monitor-run-error', { error: err instanceof Error ? err.message : String(err) });
      });
    };
    runMonitors();
    const monitorTimer = setInterval(runMonitors, monitorIntervalMs);

    ctx.addHealth(async () => ({
      inbound: await inboundHealth(db),
      ...(await maintenanceHealth(db)),
      monitors: monitorRunner.statuses(),
      ntp: ntp.getStatus(),
    }));
    ctx.log('inbound-worker', { leaseMs, blobRoot, backupsConfigured: maintenance.backup.config.s3 !== null, threadSweepMs, monitorIntervalMs });
    ctx.onShutdown(async () => {
      clearInterval(threadSweepTimer);
      clearInterval(monitorTimer);
      nightly.stop();
      await maintenanceWorker.stop();
      await worker.stop();
      await db.$disconnect();
    });
  },
});
