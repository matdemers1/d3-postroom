// PST-T-4.7 fix #6: every one of the 7 REAL monitors (PST-REQ-097), wired through the REAL runner,
// with fakes only at the edges of the world it must reach (fetch, statfs, a DNSBL lookup, an SNTP
// query, the filesystem's clock via `now`, and a real database for backlog and backup/drill) —
// proving one alert on firing and one recovery on clearing, condition by condition.
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboundState, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { enqueue } from '@postroom/queue';
import type { AlertMessage, AlertResult } from '@postroom/alerts';
import { createBacklogMonitor } from '../../src/monitors/backlog.js';
import { createBackupMonitor } from '../../src/monitors/backup.js';
import { createBlocklistMonitor } from '../../src/monitors/blocklist.js';
import { createCertMonitor } from '../../src/monitors/cert.js';
import { createDiskMonitor } from '../../src/monitors/disk.js';
import { createNtpMonitor } from '../../src/monitors/ntp.js';
import { createTunnelMonitor } from '../../src/monitors/tunnel.js';
import { createMonitorRunner } from '../../src/monitors/runner.js';
import { recordBackup, recordDrill } from '../../src/backup/state.js';

const baseUrl = process.env['DATABASE_URL'];
const CERT_FIXTURE = fileURLToPath(new URL('../fixtures/cert.crt', import.meta.url));

function fakeSendAlert(): { sendAlert: (msg: AlertMessage) => Promise<AlertResult>; calls: AlertMessage[] } {
  const calls: AlertMessage[] = [];
  return {
    calls,
    sendAlert: (msg: AlertMessage): Promise<AlertResult> => {
      calls.push(msg);
      return Promise.resolve({ sent: true });
    },
  };
}

describe.skipIf(baseUrl === undefined)('one alert, one recovery — every real monitor through the real runner (PST-T-4.7)', () => {
  let t: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t47_coverage');
    db = t.db;
  }, 30_000);

  afterAll(async () => {
    await t.drop();
  });

  it('tunnel: a fetch mock that fails, then succeeds', async () => {
    const { sendAlert, calls } = fakeSendAlert();
    const up = { current: false };
    const fetchFake = ((): Promise<Response> =>
      up.current ? Promise.resolve(new Response('', { status: 200 })) : Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const monitor = createTunnelMonitor({ url: 'https://mail.d3cloud.io/health', fetch: fetchFake });
    if (monitor === null) throw new Error('monitor unexpectedly disabled');
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });

    await runner.runOnce(); // ok -> firing
    await runner.runOnce(); // steady
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('[Postroom] FIRING: tunnel');

    up.current = true;
    await runner.runOnce(); // firing -> ok
    expect(calls).toHaveLength(2);
    expect(calls[1]?.subject).toBe('[Postroom] RESOLVED: tunnel');
  });

  it('backlog: real outbound job rows past the threshold, then drained', async () => {
    const { sendAlert, calls } = fakeSendAlert();
    const monitor = createBacklogMonitor({ db, threshold: 1, maxAgeS: 3_600 });
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });

    await runner.runOnce(); // ok (nothing queued)
    expect(calls).toHaveLength(0);

    await enqueue(db, 'outbound', { messageId: 'cov-1', domain: 'example.org' });
    await enqueue(db, 'outbound', { messageId: 'cov-2', domain: 'example.org' });
    await runner.runOnce(); // ok -> firing
    await runner.runOnce(); // steady
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('[Postroom] FIRING: backlog');

    await db.job.updateMany({ where: { queue: 'outbound' }, data: { status: 'done' } });
    await runner.runOnce(); // firing -> ok
    expect(calls).toHaveLength(2);
    expect(calls[1]?.subject).toBe('[Postroom] RESOLVED: backlog');
  });

  it('cert-expiry: a fixture certificate within the warn window, then well outside it', async () => {
    const { sendAlert, calls } = fakeSendAlert();
    const notAfter = Date.parse(new X509Certificate(readFileSync(CERT_FIXTURE)).validTo);
    const clock = { current: new Date(notAfter - 10 * 86_400_000) }; // 10 days left: firing

    const monitor = createCertMonitor({ files: [CERT_FIXTURE], warnDays: 14, now: () => clock.current });
    if (monitor === null) throw new Error('monitor unexpectedly disabled');
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });

    await runner.runOnce(); // ok -> firing
    await runner.runOnce(); // steady
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('[Postroom] FIRING: cert-expiry');

    clock.current = new Date(notAfter - 365 * 86_400_000); // a year out: clearly fine
    await runner.runOnce(); // firing -> ok
    expect(calls).toHaveLength(2);
    expect(calls[1]?.subject).toBe('[Postroom] RESOLVED: cert-expiry');
  });

  it('disk: statfs reporting over threshold, then under it', async () => {
    const { sendAlert, calls } = fakeSendAlert();
    const disk = { bavail: 5, blocks: 100 }; // 95% used: firing
    const monitor = createDiskMonitor({
      paths: ['/var/lib/postroom/blobs'],
      thresholdPct: 80,
      stat: () => Promise.resolve(disk),
    });
    if (monitor === null) throw new Error('monitor unexpectedly disabled');
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });

    await runner.runOnce();
    await runner.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('[Postroom] FIRING: disk');

    disk.bavail = 60; // 40% used
    await runner.runOnce();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.subject).toBe('[Postroom] RESOLVED: disk');
  });

  it('blocklist: a DNSBL lookup returning a reject-worthy code, then clean', async () => {
    const { sendAlert, calls } = fakeSendAlert();
    const listed = { current: true };
    const monitor = createBlocklistMonitor({
      ip: '203.0.113.9',
      resolverServer: '10.0.0.1:53',
      zoneKeys: ['spamhaus'],
      // PST-T-7.3's real 6h cadence is covered by monitor-runner.test.ts; here every tick should
      // re-query, same as every other monitor in this suite.
      minIntervalMs: 0,
      lookupA: () => Promise.resolve(listed.current ? ['127.0.0.4'] : []),
    });
    if (monitor === null) throw new Error('monitor unexpectedly disabled');
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });

    await runner.runOnce();
    await runner.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('[Postroom] FIRING: blocklist');

    listed.current = false;
    await runner.runOnce();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.subject).toBe('[Postroom] RESOLVED: blocklist');
  });

  it('backup-drill: a real failed backup row, then a real good one', async () => {
    const { sendAlert, calls } = fakeSendAlert();
    const monitor = createBackupMonitor({ db, configured: true, maxAgeS: 3_600 });
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });

    await recordBackup(db, { at: new Date().toISOString(), ok: false, bytes: 0, objects: 0, reason: 'credential rejected' });
    await recordDrill(db, { at: new Date().toISOString(), ok: false, reason: 'no dump to restore' });
    await runner.runOnce();
    await runner.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('[Postroom] FIRING: backup-drill');

    const now = new Date().toISOString();
    await recordBackup(db, { at: now, ok: true, bytes: 100, objects: 3 });
    await recordDrill(db, { at: now, ok: true, reason: 'opened cleanly' });
    await runner.runOnce();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.subject).toBe('[Postroom] RESOLVED: backup-drill');
  });

  it('ntp: an SNTP query reporting a large skew, then in sync', async () => {
    const { sendAlert, calls } = fakeSendAlert();
    const offset = { current: 5_000 };
    const monitor = createNtpMonitor({
      server: 'time.cloudflare.com',
      thresholdMs: 2_000,
      query: () => Promise.resolve({ offsetMs: offset.current, server: 'time.cloudflare.com' }),
    });
    if (monitor === null) throw new Error('monitor unexpectedly disabled');
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });

    await runner.runOnce();
    await runner.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('[Postroom] FIRING: ntp');

    offset.current = 5;
    await runner.runOnce();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.subject).toBe('[Postroom] RESOLVED: ntp');
  });

  it('inbound backlog also fires on its own (independent of the outbound queue)', async () => {
    const { sendAlert, calls } = fakeSendAlert();
    const monitor = createBacklogMonitor({ db: t.db, threshold: 1_000, maxAgeS: 1 });
    const runner = createMonitorRunner({ db: t.db, monitors: [monitor], sendAlert });
    await runner.runOnce();
    expect(calls).toHaveLength(0);

    await t.db.inboundMessage.create({
      data: { envelopeFrom: 'alice@example.org', recipients: [], blobSha256: 'b'.repeat(64), size: 10, state: InboundState.spooled },
    });
    await new Promise((r) => setTimeout(r, 1_100));
    await runner.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('[Postroom] FIRING: backlog');
  });
});
