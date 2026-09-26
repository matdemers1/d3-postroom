// PST-REQ-096, PST-REQ-097: the monitor runner alerts exactly once on ok→firing and once again on
// firing→ok, stays silent while the condition holds steady over several runs, and persists its
// state (a fake `setting` table stands in for the database) so a restart does not repeat the alert.
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import type { AlertMessage, AlertResult } from '@postroom/alerts';
import { createMonitorRunner } from '../../../src/monitors/runner.js';
import type { Monitor, MonitorCheckResult } from '../../../src/monitors/types.js';

function fakeDb(): { db: Db; rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  const setting = {
    findUnique: ({ where }: { where: { key: string } }): Promise<{ key: string; value: unknown } | null> => {
      const value = rows.get(where.key);
      return Promise.resolve(value === undefined ? null : { key: where.key, value });
    },
    upsert: ({ where, create }: { where: { key: string }; create: { value: unknown } }): Promise<unknown> => {
      rows.set(where.key, create.value);
      return Promise.resolve({ key: where.key, value: create.value });
    },
  };
  return { db: { setting } as unknown as Db, rows };
}

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

describe('createMonitorRunner', () => {
  it('alerts once on firing, stays silent while it holds, and alerts once on recovery', async () => {
    const { db } = fakeDb();
    const { sendAlert, calls } = fakeSendAlert();
    const monitor = stubMonitor('disk', [
      { ok: false, detail: 'disk at 95%' },
      { ok: false, detail: 'disk at 96%' },
      { ok: false, detail: 'disk at 97%' },
      { ok: true, detail: 'disk at 40%' },
    ]);
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });

    await runner.runOnce(); // ok -> firing
    await runner.runOnce(); // firing -> firing (still bad)
    await runner.runOnce(); // firing -> firing (still bad)
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toMatch(/FIRING: disk/);

    await runner.runOnce(); // firing -> ok
    expect(calls).toHaveLength(2);
    expect(calls[1]?.subject).toMatch(/RESOLVED: disk/);
    expect(calls[0]?.key).not.toBe(calls[1]?.key);

    const statuses = runner.statuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ name: 'disk', ok: true, detail: 'disk at 40%' });
    expect(typeof statuses[0]?.since).toBe('string');
  });

  it('a check that throws counts as firing', async () => {
    const { db } = fakeDb();
    const { sendAlert, calls } = fakeSendAlert();
    const monitor: Monitor = {
      name: 'tunnel',
      check: () => Promise.reject(new Error('boom')),
    };
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });
    await runner.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/boom/);
  });

  it('persists state across a runner restart: a still-firing condition does not re-alert', async () => {
    const { db } = fakeDb();
    const alerts1 = fakeSendAlert();
    const monitor1 = stubMonitor('cert-expiry', [{ ok: false, detail: 'expires soon' }]);
    const runner1 = createMonitorRunner({ db, monitors: [monitor1], sendAlert: alerts1.sendAlert });
    await runner1.runOnce();
    expect(alerts1.calls).toHaveLength(1);

    // A fresh runner instance, same db: the condition is still firing.
    const alerts2 = fakeSendAlert();
    const monitor2 = stubMonitor('cert-expiry', [{ ok: false, detail: 'expires soon' }]);
    const runner2 = createMonitorRunner({ db, monitors: [monitor2], sendAlert: alerts2.sendAlert });
    await runner2.runOnce();
    expect(alerts2.calls).toHaveLength(0);

    // Recovery on the new runner still fires exactly once.
    const monitor3 = stubMonitor('cert-expiry', [{ ok: true, detail: 'renewed' }]);
    const runner3 = createMonitorRunner({ db, monitors: [monitor3], sendAlert: alerts2.sendAlert });
    await runner3.runOnce();
    expect(alerts2.calls).toHaveLength(1);
    expect(alerts2.calls[0]?.subject).toMatch(/RESOLVED/);
  });

  it('runs every monitor each tick, independent of the others', async () => {
    const { db } = fakeDb();
    const { sendAlert, calls } = fakeSendAlert();
    const a = stubMonitor('tunnel', [{ ok: false, detail: 'down' }]);
    const b = stubMonitor('ntp', [{ ok: true, detail: 'in sync' }]);
    const runner = createMonitorRunner({ db, monitors: [a, b], sendAlert });
    await runner.runOnce();
    expect(calls).toHaveLength(1);
    expect(runner.statuses().map((s) => s.name).sort()).toEqual(['ntp', 'tunnel']);
  });
});
