// PST-T-4.13, PST-REQ-182: the wireguard monitor's pure logic against a faked sidecar endpoint, and
// — through the real runner — proof that a stopped handshake fires exactly one FIRING and, once it
// resumes, exactly one RESOLVED.
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@postroom/db';
import type { AlertMessage, AlertResult } from '@postroom/alerts';
import { createWireguardMonitor } from '../../../src/monitors/wireguard.js';
import { createMonitorRunner } from '../../../src/monitors/runner.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeDb(): { db: Db } {
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
  return { db: { setting } as unknown as Db };
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

describe('wireguard monitor (PST-REQ-182)', () => {
  it('is disabled when no health URL is configured', () => {
    expect(createWireguardMonitor({ url: '' })).toBeNull();
  });

  it('is quiet when the sidecar reports itself unconfigured', async () => {
    const fetchFake = vi.fn().mockResolvedValue(jsonResponse({ configured: false }));
    const monitor = createWireguardMonitor({ url: 'http://wireguard:9108/cgi-bin/health', fetch: fetchFake });
    const result = await monitor?.check();
    expect(result?.ok).toBe(true);
    expect(result?.detail).toMatch(/unconfigured/);
  });

  it('fires when the latest handshake is older than the threshold, clears once fresh', async () => {
    const fetchFake = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ configured: true, ageSeconds: 400 }))
      .mockResolvedValueOnce(jsonResponse({ configured: true, ageSeconds: 5 }));
    const monitor = createWireguardMonitor({ url: 'http://wireguard:9108/cgi-bin/health', fetch: fetchFake, thresholdS: 180 });
    const firing = await monitor?.check();
    expect(firing?.ok).toBe(false);
    expect(firing?.detail).toMatch(/400s ago/);
    const clear = await monitor?.check();
    expect(clear?.ok).toBe(true);
  });

  it('fires when there has never been a handshake', async () => {
    const fetchFake = vi.fn().mockResolvedValue(jsonResponse({ configured: true, ageSeconds: null, latestHandshake: null }));
    const monitor = createWireguardMonitor({ url: 'http://wireguard:9108/cgi-bin/health', fetch: fetchFake });
    const result = await monitor?.check();
    expect(result?.ok).toBe(false);
    expect(result?.detail).toMatch(/no handshake recorded/);
  });

  it('fires on an unreachable sidecar and on a non-2xx response', async () => {
    const unreachable = createWireguardMonitor({ url: 'http://wireguard:9108/cgi-bin/health', fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    expect((await unreachable?.check())?.ok).toBe(false);

    const nonOk = createWireguardMonitor({ url: 'http://wireguard:9108/cgi-bin/health', fetch: vi.fn().mockResolvedValue(new Response('', { status: 502 })) });
    expect((await nonOk?.check())?.ok).toBe(false);
  });

  it('through the real runner: a stopped handshake fires exactly one FIRING and, once it resumes, exactly one RESOLVED', async () => {
    const { db } = fakeDb();
    const { sendAlert, calls } = fakeSendAlert();
    const handshakeAgeS = { current: 5 }; // fresh to start

    const monitor = createWireguardMonitor({
      url: 'http://wireguard:9108/cgi-bin/health',
      fetch: () => Promise.resolve(jsonResponse({ configured: true, ageSeconds: handshakeAgeS.current })),
      thresholdS: 180,
    });
    if (monitor === null) throw new Error('monitor unexpectedly disabled');
    const runner = createMonitorRunner({ db, monitors: [monitor], sendAlert });

    await runner.runOnce(); // ok: fresh handshake
    expect(calls).toHaveLength(0);

    // The handshake stops advancing (the peer link is down) — age climbs past the threshold.
    handshakeAgeS.current = 250;
    await runner.runOnce(); // ok -> firing
    await runner.runOnce(); // firing -> firing (still stale)
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subject).toBe('[Postroom] FIRING: wireguard');

    // The handshake resumes.
    handshakeAgeS.current = 3;
    await runner.runOnce(); // firing -> ok
    expect(calls).toHaveLength(2);
    expect(calls[1]?.subject).toBe('[Postroom] RESOLVED: wireguard');
  });
});
