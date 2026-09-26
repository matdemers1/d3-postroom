// PST-REQ-096, PST-REQ-097: the monitor runner alerts exactly once on ok→firing and once again on
// firing→ok, stays silent while the condition holds steady over several runs, and persists its
// state (a fake `setting` table stands in for the database) so a restart does not repeat the alert.
// PST-T-4.7 fixes: an alert only ever counts as delivered once actually sent (or the relay is
// explicitly unconfigured); overlapping ticks and a hung check are both guarded against.
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@postroom/db';
import { createAlertSender, type AlertMessage, type AlertResult } from '@postroom/alerts';
import { createMonitorRunner } from '../../../src/monitors/runner.js';
import { createBlocklistMonitor } from '../../../src/monitors/blocklist.js';
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

  describe("a monitor's minIntervalMs (PST-T-7.3, PST-REQ-124)", () => {
    const SIX_HOURS_MS = 6 * 3_600_000;

    it('still listed on the next ticks within 6h: no re-query and no new alert', async () => {
      const { db } = fakeDb();
      const { sendAlert, calls } = fakeSendAlert();
      const lookupA = vi.fn().mockResolvedValue(['127.0.0.4']); // Spamhaus XBL: listed, every call
      const monitor = createBlocklistMonitor({ ip: '203.0.113.9', resolverServer: '10.0.0.1:53', zoneKeys: ['spamhaus'], lookupA });
      expect(monitor).not.toBeNull();
      let clock = new Date('2026-09-26T00:00:00.000Z');
      const runner = createMonitorRunner({ db, monitors: monitor === null ? [] : [monitor], sendAlert, now: () => clock });

      await runner.runOnce(); // ok -> firing: first real query
      expect(calls).toHaveLength(1);
      expect(lookupA).toHaveBeenCalledTimes(1);

      clock = new Date(clock.getTime() + 60_000); // one more 60s tick, well within 6h
      await runner.runOnce();
      clock = new Date(clock.getTime() + 60_000);
      await runner.runOnce();
      expect(lookupA).toHaveBeenCalledTimes(1); // no re-query
      expect(calls).toHaveLength(1); // no new alert — still "firing", nothing to say
    });

    it('after 6h a clean result fires exactly one recovery', async () => {
      const { db } = fakeDb();
      const { sendAlert, calls } = fakeSendAlert();
      const listed = { current: true };
      const lookupA = vi.fn(() => Promise.resolve(listed.current ? ['127.0.0.4'] : []));
      const monitor = createBlocklistMonitor({ ip: '203.0.113.9', resolverServer: '10.0.0.1:53', zoneKeys: ['spamhaus'], lookupA });
      expect(monitor).not.toBeNull();
      let clock = new Date('2026-09-26T00:00:00.000Z');
      const runner = createMonitorRunner({ db, monitors: monitor === null ? [] : [monitor], sendAlert, now: () => clock });

      await runner.runOnce(); // ok -> firing
      expect(calls).toHaveLength(1);
      expect(lookupA).toHaveBeenCalledTimes(1);

      listed.current = false;
      clock = new Date(clock.getTime() + 60_000); // well within 6h: no re-query, still "firing"
      await runner.runOnce();
      expect(lookupA).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);

      clock = new Date(clock.getTime() + SIX_HOURS_MS + 1_000); // now due
      await runner.runOnce(); // firing -> ok
      expect(lookupA).toHaveBeenCalledTimes(2);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.subject).toMatch(/RESOLVED: blocklist/);
    });

    it('a restart with a recent persisted check does not immediately re-query', async () => {
      const { db } = fakeDb();
      const alerts1 = fakeSendAlert();
      const lookupA1 = vi.fn().mockResolvedValue(['127.0.0.4']);
      const monitor1 = createBlocklistMonitor({ ip: '203.0.113.9', resolverServer: '10.0.0.1:53', zoneKeys: ['spamhaus'], lookupA: lookupA1 });
      expect(monitor1).not.toBeNull();
      const clock = new Date('2026-09-26T00:00:00.000Z');
      const runner1 = createMonitorRunner({ db, monitors: monitor1 === null ? [] : [monitor1], sendAlert: alerts1.sendAlert, now: () => clock });
      await runner1.runOnce();
      expect(lookupA1).toHaveBeenCalledTimes(1);
      expect(alerts1.calls).toHaveLength(1);

      // A brand-new runner/monitor instance (a worker restart), same database, moments later.
      const alerts2 = fakeSendAlert();
      const lookupA2 = vi.fn().mockResolvedValue(['127.0.0.4']);
      const monitor2 = createBlocklistMonitor({ ip: '203.0.113.9', resolverServer: '10.0.0.1:53', zoneKeys: ['spamhaus'], lookupA: lookupA2 });
      const soonAfter = new Date(clock.getTime() + 5_000);
      const runner2 = createMonitorRunner({ db, monitors: monitor2 === null ? [] : [monitor2], sendAlert: alerts2.sendAlert, now: () => soonAfter });
      await runner2.runOnce();
      expect(lookupA2).not.toHaveBeenCalled();
      expect(alerts2.calls).toHaveLength(0);
    });
  });
});
