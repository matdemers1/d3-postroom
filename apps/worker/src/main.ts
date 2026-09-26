// The worker daemon: runs the inbound pipeline (PST-T-2.7) on the 'inbound' queue — verify, parse,
// classify, sieve, file, notify — for every message smtp-in spooled — and, on their own queues and
// worker, the nightly backup and restore drill (PST-T-0.16, PST-T-0.17). ACME joins in a later phase.
import { createAlertSender } from '@postroom/alerts';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { loadKek } from '@postroom/crypto';
import { createDb } from '@postroom/db';
import { envInt, envString, revision, runDaemon } from '@postroom/daemon';
import { startWorker } from '@postroom/queue';
import { backupHandler, BACKUP_QUEUE } from './backup/job.js';
import { DRILL_QUEUE, startNightly } from './backup/schedule.js';
import { maintenanceDeps } from './backup/wire.js';
import { DAEMON } from './daemon.js';
import { drillHandler } from './drill/drill.js';
import { createExportSweeper, exportHandler, EXPORT_QUEUE } from './export/index.js';
import { inboundHealth, maintenanceHealth } from './health.js';
import { importHandler, IMPORT_QUEUE } from './import/index.js';
import { buildMonitors, createMonitorRunner } from './monitors/index.js';
import { createInboundPipeline, INBOUND_QUEUE } from './pipeline.js';
import { createThreadSweeper } from './sweep/thread-sweep.js';
import { startTrainingLoop } from './training/index.js';
import { startRetentionLoop } from './retention/index.js';

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
    const threadSweep = createThreadSweeper({ db, blobs: lazyBlobs, log: ctx.log, now: () => new Date() });
    const runThreadSweep = (): void => {
      threadSweep().catch((err: unknown) => {
        ctx.log('thread-sweep-error', { error: err instanceof Error ? err.message : String(err) });
      });
    };
    runThreadSweep();
    const threadSweepTimer = setInterval(runThreadSweep, threadSweepMs);

    // PST-T-5.3 (PST-REQ-104): train each account's naive Bayes on the moves users make, from any
    // client. Its own block and its own shutdown hook, so it merges beside the other registrations.
    const training = startTrainingLoop({ db, blobs: lazyBlobs, intervalMs: envInt(ctx.env, 'BAYES_TRAINING_MS', 5_000), log: ctx.log });
    ctx.onShutdown(() => training.stop());

    // PST-T-7.7 (PST-REQ-129, PST-REQ-130): retention — Junk (and any mailbox with a policy) moves
    // to Trash, Trash and Rejects expire, the last reference to a blob crypto-shreds it, and a gc
    // pass removes files a crash left without a row. Its own block and its own shutdown hook.
    const retention = startRetentionLoop({ db, blobs: lazyBlobs, intervalMs: envInt(ctx.env, 'RETENTION_SWEEP_MS', 3_600_000), log: ctx.log });
    ctx.onShutdown(() => retention.stop());

    // PST-T-10.1 (PST-REQ-151): the full-data export, on its own queue and worker (a 10 GB mailbox
    // must not hold up inbound mail), plus a sweep that deletes an archive 24 h after it finishes.
    // Its own block and its own shutdown hook, so it merges beside the other registrations.
    const exportWorker = await startWorker({
      db,
      databaseUrl,
      queues: { [EXPORT_QUEUE]: exportHandler({ db, blobs: lazyBlobs, revision: revision(ctx.env), log: ctx.log }) },
      pollMs: 5_000,
      leaseMs: envInt(ctx.env, 'EXPORT_LEASE_MS', 3_600_000),
      log: ctx.log,
    });
    const exportSweepMs = envInt(ctx.env, 'EXPORT_SWEEP_MS', 60_000);
    const exportSweep = createExportSweeper({ db, blobs: lazyBlobs, log: ctx.log });
    const runExportSweep = (): void => {
      exportSweep().catch((err: unknown) => {
        ctx.log('export-sweep-error', { error: err instanceof Error ? err.message : String(err) });
      });
    };
    runExportSweep();
    const exportSweepTimer = setInterval(runExportSweep, exportSweepMs);
    ctx.onShutdown(async () => {
      clearInterval(exportSweepTimer);
      await exportWorker.stop();
    });

    // PST-T-10.2 (PST-REQ-152): IMAP import from another server, on its own queue and worker (an
    // import can run for hours; inbound mail never waits behind it). The handler heartbeats its
    // lease and fences every commit on it, so a long import is never claimed twice. Its own block
    // and its own shutdown hook, so it merges beside the other registrations.
    const importLeaseMs = envInt(ctx.env, 'IMPORT_LEASE_MS', 600_000);
    const importWorker = await startWorker({
      db,
      databaseUrl,
      queues: { [IMPORT_QUEUE]: importHandler({ db, blobs: lazyBlobs, kek: () => loadKek({ env: ctx.env }), leaseMs: importLeaseMs, log: ctx.log }) },
      pollMs: 5_000,
      leaseMs: importLeaseMs,
      log: ctx.log,
    });
    ctx.onShutdown(() => importWorker.stop());

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
    const monitorRunner = createMonitorRunner({
      db,
      monitors,
      sendAlert,
      log: ctx.log,
      checkTimeoutMs: envInt(ctx.env, 'MONITOR_CHECK_TIMEOUT_MS', 30_000),
    });
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
      ntp: ntp === null ? ('not configured' as const) : (ntp.getStatus() ?? ('pending' as const)),
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
