// PST-REQ-096, PST-REQ-097: the monitor runner alerts exactly once on ok→firing and once again on
// firing→ok, stays silent while the condition holds steady over several runs, and persists its
// state (a fake `setting` table stands in for the database) so a restart does not repeat the alert.
// PST-T-4.7 fixes: an alert only ever counts as delivered once actually sent (or the relay is
// explicitly unconfigured); overlapping ticks and a hung check are both guarded against.
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@postroom/db';
import { createAlertSender, type AlertMessage, type AlertResult } from '@postroom/alerts';
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

/** A `sendAlert` whose next N results are scripted (e.g. failures then a success), for exercising
 * retry-until-delivered. */
function scriptedSendAlert(results: AlertResult[]): { sendAlert: (msg: AlertMessage) => Promise<AlertResult>; calls: AlertMessage[] } {
  const calls: AlertMessage[] = [];
  let i = 0;
  return {
    calls,
    sendAlert: (msg: AlertMessage): Promise<AlertResult> => {
      calls.push(msg);
      const result = results[Math.min(i, results.length - 1)];
      i += 1;
      return Promise.resolve(result ?? { sent: true });
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
    expect(statuses[0]).toMatchObject({ name: 'disk', ok: true, detail: 'disk at 40%', alert: 'delivered' });
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

  it('an unconfigured relay still advances state, but records that delivery failed (PST-T-4.7 fix #1)', async () => {
    const { db } = fakeDb();
    const { sendAlert, calls } = scriptedSendAlert([{ sent: false, reason: 'relay unconfigured' }]);
    const monitor = stubMonitor('tunnel', [{ ok: false, detail: 'down' }]);
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });
    await runner.runOnce();
    expect(calls).toHaveLength(1);
    expect(runner.statuses()[0]).toMatchObject({ ok: false, alert: 'not delivered: relay unconfigured' });

    // Steady on the next tick: no further send attempts (state already advanced).
    const monitor2 = stubMonitor('tunnel', [{ ok: false, detail: 'still down' }]);
    const runner2 = createMonitorRunner({ db, monitors: [monitor2], sendAlert });
    await runner2.runOnce();
    expect(calls).toHaveLength(1);
  });

  it('a configured relay that fails to send does not advance state, and keeps retrying the same episode until delivered (PST-T-4.7 fix #1)', async () => {
    const { db } = fakeDb();
    const { sendAlert, calls } = scriptedSendAlert([
      { sent: false, reason: 'relay request failed' },
      { sent: false, reason: 'relay request failed' },
      { sent: true },
    ]);
    const firingResult: MonitorCheckResult = { ok: false, detail: 'disk at 95%' };

    const attempt = async (): Promise<void> => {
      const monitor = stubMonitor('disk', [firingResult]);
      const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });
      await runner.runOnce();
    };

    await attempt(); // fails to send — must not be recorded as delivered
    expect(calls).toHaveLength(1);
    await attempt(); // retried — still failing
    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe(calls[1]?.key); // same episode, same key
    await attempt(); // retried — now succeeds
    expect(calls).toHaveLength(3);
    expect(calls[2]?.key).toBe(calls[0]?.key);

    // Now delivered: a later tick with the same firing condition sends nothing further.
    await attempt();
    expect(calls).toHaveLength(3);
  });

  it('a still-undelivered firing that self-resolves is dropped without ever alerting (either direction)', async () => {
    const { db } = fakeDb();
    const { sendAlert, calls } = scriptedSendAlert([{ sent: false, reason: 'relay request failed' }]);
    const firing = stubMonitor('backlog', [{ ok: false, detail: 'backlog high' }]);
    const runner1 = createMonitorRunner({ db, monitors: [firing], sendAlert });
    await runner1.runOnce();
    expect(calls).toHaveLength(1);

    // The condition clears before the firing alert was ever delivered.
    const recovered = stubMonitor('backlog', [{ ok: true, detail: 'backlog clear' }]);
    const runner2 = createMonitorRunner({ db, monitors: [recovered], sendAlert });
    await runner2.runOnce();
    // No recovery alert either — the operator was never told it was firing in the first place.
    expect(calls).toHaveLength(1);
  });

  it('does not start a tick while the previous one is still running (PST-T-4.7 fix #3)', async () => {
    const { db } = fakeDb();
    const { sendAlert } = fakeSendAlert();
    let calls = 0;
    const resolvers: (() => void)[] = [];
    const slow: Monitor = {
      name: 'slow',
      check: () =>
        new Promise((resolve) => {
          calls += 1;
          resolvers.push(() => {
            resolve({ ok: true, detail: 'done' });
          });
        }),
    };
    const runner = createMonitorRunner({ db, monitors: [slow], sendAlert });
    const first = runner.runOnce();
    const second = runner.runOnce(); // must be a no-op: the first tick has not finished
    await second;
    expect(calls).toBe(1); // the overlapping call never invoked check() a second time

    resolvers[0]?.();
    await first;
    expect(calls).toBe(1);

    // A tick after the first has finished runs normally.
    const third = runner.runOnce();
    resolvers[1]?.();
    await third;
    expect(calls).toBe(2);
  });

  it('fire -> recover -> fire within an hour sends 3 alerts with the REAL createAlertSender (PST-T-4.7 fix #2)', async () => {
    const { db } = fakeDb();
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const sendAlert = createAlertSender({ url: 'https://relay.example/send', token: 't', to: 'ops@example.org', fetch: fetchMock });

    const runOnceWith = async (result: MonitorCheckResult): Promise<void> => {
      const monitor = stubMonitor('tunnel', [result]);
      const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });
      await runner.runOnce();
    };

    await runOnceWith({ ok: false, detail: 'down' }); // fire #1
    await runOnceWith({ ok: true, detail: 'up' }); // recover
    await runOnceWith({ ok: false, detail: 'down again' }); // fire #2 — same monitor, well within an hour

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = fetchMock.mock.calls.map((call) => {
      const body = JSON.parse((call[1] as { body: string }).body) as { subject: string };
      return body.subject;
    });
    expect(keys[0]).toMatch(/FIRING/);
    expect(keys[1]).toMatch(/RESOLVED/);
    expect(keys[2]).toMatch(/FIRING/);
  });

  it("a monitor's check() is raced against a hard timeout (PST-T-4.7 fix #3)", async () => {
    const { db } = fakeDb();
    const { sendAlert, calls } = fakeSendAlert();
    const hung: Monitor = {
      name: 'hung',
      check: () => new Promise(() => undefined), // never resolves
    };
    const runner = createMonitorRunner({ db, monitors: [hung], sendAlert, checkTimeoutMs: 20 });
    await runner.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/did not finish within 20ms/);
  });
});
