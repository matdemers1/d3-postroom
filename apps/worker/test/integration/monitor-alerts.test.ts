// PST-REQ-096, PST-REQ-097: the monitor runner's persisted state survives a restart (a fresh runner
// reading the same database does not repeat an alert already sent), and alerting never touches
// Postroom's own outbound queue or any job row — "the queue stopped" property.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { createAlertSender, type AlertMessage, type AlertResult } from '@postroom/alerts';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { createMonitorRunner } from '../../src/monitors/runner.js';
import type { Monitor, MonitorCheckResult } from '../../src/monitors/types.js';

const baseUrl = process.env['DATABASE_URL'];

function stubMonitor(name: string, results: MonitorCheckResult[]): Monitor {
  let i = 0;
  return {
    name,
    check: (): Promise<MonitorCheckResult> => {
      const result = results[Math.min(i, results.length - 1)];
      i += 1;
      return Promise.resolve(result ?? { ok: true, detail: 'ok' });
    },
  };
}

function recordingAlertSender(sent: AlertMessage[]): (msg: AlertMessage) => Promise<AlertResult> {
  return (msg: AlertMessage): Promise<AlertResult> => {
    sent.push(msg);
    return Promise.resolve({ sent: true });
  };
}

describe.skipIf(baseUrl === undefined)('monitor alerts (PST-T-4.7)', () => {
  let t: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t47_alerts');
    db = t.db;
  }, 30_000);

  afterAll(async () => {
    await t.drop();
  });

  it('a still-firing condition after a runner restart does not repeat the alert; recovery still fires once', async () => {
    const sent1: AlertMessage[] = [];
    const runner1 = createMonitorRunner({ db, monitors: [stubMonitor('tunnel', [{ ok: false, detail: 'down' }])], sendAlert: recordingAlertSender(sent1) });
    await runner1.runOnce();
    expect(sent1).toHaveLength(1);
    expect(sent1[0]?.subject).toMatch(/FIRING/);

    // A brand-new runner instance, same database: the condition is unchanged.
    const sent2: AlertMessage[] = [];
    const runner2 = createMonitorRunner({ db, monitors: [stubMonitor('tunnel', [{ ok: false, detail: 'down' }])], sendAlert: recordingAlertSender(sent2) });
    await runner2.runOnce();
    expect(sent2).toHaveLength(0);

    const runner3 = createMonitorRunner({ db, monitors: [stubMonitor('tunnel', [{ ok: true, detail: 'up' }])], sendAlert: recordingAlertSender(sent2) });
    await runner3.runOnce();
    expect(sent2).toHaveLength(1);
    expect(sent2[0]?.subject).toMatch(/RESOLVED/);
  });

  it('alerting never creates an outbound job or message row — the queue stopped', async () => {
    const before = { jobs: await db.job.count(), outbound: await db.outboundMessage.count() };

    // A real (unconfigured) alert sender: no relay configured, so `sendAlert` resolves { sent: false }
    // without throwing — proving the property holds even when the relay itself is absent.
    const sendAlert = createAlertSender({ url: '', token: '', to: '' });
    const runner = createMonitorRunner({
      db,
      monitors: [stubMonitor('blocklist', [{ ok: false, detail: 'listed' }, { ok: true, detail: 'clear' }])],
      sendAlert,
    });
    await runner.runOnce();
    await runner.runOnce();

    const after = { jobs: await db.job.count(), outbound: await db.outboundMessage.count() };
    expect(after).toEqual(before);
  });
});
