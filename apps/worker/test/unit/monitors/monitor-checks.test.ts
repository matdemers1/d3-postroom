// PST-T-4.7: pure monitor logic — tunnel, cert expiry, disk, blocklist, NTP skew — each simulated
// with an injected fake, asserting exactly the ok/detail transition doneWhen needs.
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createTunnelMonitor } from '../../../src/monitors/tunnel.js';
import { createCertMonitor } from '../../../src/monitors/cert.js';
import { createDiskMonitor } from '../../../src/monitors/disk.js';
import { createBlocklistMonitor, publicBlocklistZone } from '../../../src/monitors/blocklist.js';
import { createNtpMonitor } from '../../../src/monitors/ntp.js';

const CERT_FIXTURE = fileURLToPath(new URL('../../fixtures/cert.crt', import.meta.url));

describe('tunnel monitor (PST-REQ-097)', () => {
  it('is disabled when the URL is empty', () => {
    expect(createTunnelMonitor({ url: '' })).toBeNull();
  });

  it('fires on a non-2xx response and clears on 200', async () => {
    const fetches = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('', { status: 200 }));
    const monitor = createTunnelMonitor({ url: 'https://mail.d3cloud.io/health', fetch: fetches });
    expect(monitor).not.toBeNull();
    const first = await monitor?.check();
    expect(first).toMatchObject({ ok: false });
    const second = await monitor?.check();
    expect(second).toMatchObject({ ok: true });
  });

  it('fires on a network error', async () => {
    const fetches = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const monitor = createTunnelMonitor({ url: 'https://mail.d3cloud.io/health', fetch: fetches });
    const result = await monitor?.check();
    expect(result?.ok).toBe(false);
    expect(result?.detail).toMatch(/ECONNREFUSED/);
  });
});

describe('cert expiry monitor (PST-REQ-021, PST-REQ-097)', () => {
  const notAfter = new X509Certificate(readFileSync(CERT_FIXTURE)).validTo;

  it('is disabled with no configured files', () => {
    expect(createCertMonitor({ files: [] })).toBeNull();
  });

  it('fires a test cert with 10 days left, clears once past the warn window', async () => {
    const tenDaysBefore = new Date(Date.parse(notAfter) - 10 * 86_400_000);
    const monitor = createCertMonitor({ files: [CERT_FIXTURE], warnDays: 14, now: () => tenDaysBefore });
    expect(monitor).not.toBeNull();
    const firing = await monitor?.check();
    expect(firing).toMatchObject({ ok: false });
    expect(firing?.detail).toMatch(/expires in/);

    const wayBefore = new Date(Date.parse(notAfter) - 365 * 86_400_000);
    const clear = await createCertMonitor({ files: [CERT_FIXTURE], warnDays: 14, now: () => wayBefore })?.check();
    expect(clear).toMatchObject({ ok: true });
  });

  it('fires when the file cannot be read or parsed', async () => {
    const monitor = createCertMonitor({ files: ['/nonexistent/cert.pem'] });
    const result = await monitor?.check();
    expect(result?.ok).toBe(false);
  });
});

describe('disk monitor (PST-REQ-097)', () => {
  it('fires above the threshold and clears below it', async () => {
    const stat = vi
      .fn()
      .mockResolvedValueOnce({ bavail: 5, blocks: 100 }) // 95% used
      .mockResolvedValueOnce({ bavail: 50, blocks: 100 }); // 50% used
    const monitor = createDiskMonitor({ paths: ['/var/lib/postroom/blobs'], thresholdPct: 80, stat });
    expect(monitor).not.toBeNull();
    expect((await monitor?.check())?.ok).toBe(false);
    expect((await monitor?.check())?.ok).toBe(true);
  });

  it('is disabled with no configured paths', () => {
    expect(createDiskMonitor({ paths: [] })).toBeNull();
  });
});

describe('blocklist monitor (PST-REQ-097, PST-REQ-124)', () => {
  it('is disabled with no edge IP configured', () => {
    expect(createBlocklistMonitor({ ip: '', resolverServer: '127.0.0.1:53' })).toBeNull();
  });

  it('fires when the DNSBL lookup returns a reject-worthy code, clears when not listed', async () => {
    const lookupA = vi.fn().mockResolvedValueOnce(['127.0.0.4']).mockResolvedValueOnce([]);
    const monitor = createBlocklistMonitor({ ip: '203.0.113.9', resolverServer: '10.0.0.1:53', zoneKeys: ['spamhaus'], lookupA });
    expect(monitor).not.toBeNull();
    const firing = await monitor?.check();
    expect(firing).toMatchObject({ ok: false });
    expect(firing?.detail).toMatch(/listed on Spamhaus ZEN: Spamhaus ZEN \(XBL; delist at https:\/\/check\.spamhaus\.org\/\)/);
    const clear = await monitor?.check();
    expect(clear).toMatchObject({ ok: true });
  });

  it('treats a Spamhaus signalling code as unknown, not a listing', async () => {
    const lookupA = vi.fn().mockResolvedValue(['127.255.255.254']);
    const monitor = createBlocklistMonitor({ ip: '203.0.113.9', resolverServer: '10.0.0.1:53', zoneKeys: ['spamhaus'], lookupA });
    const result = await monitor?.check();
    expect(result?.ok).toBe(true);
    expect(result?.detail).toMatch(/unknown \(query error\)/);
  });

  it('never reports a DQS key in the zone name', () => {
    expect(publicBlocklistZone('secretkey.zen.dq.spamhaus.net')).toBe('zen.spamhaus.org');
  });

  it('checks every major blocklist by default, naming only the one that lists the IP', async () => {
    const lookupA = vi.fn((name: string) => Promise.resolve(name.includes('b.barracudacentral.org') ? ['127.0.0.2'] : []));
    const monitor = createBlocklistMonitor({ ip: '203.0.113.9', resolverServer: '10.0.0.1:53', lookupA });
    expect(monitor).not.toBeNull();
    const firing = await monitor?.check();
    expect(firing?.ok).toBe(false);
    expect(firing?.detail).toMatch(/listed on Barracuda: Barracuda \(listed; delist at https:\/\/www\.barracudacentral\.org\/rbl\/removal-request\)/);
    expect(firing?.detail).not.toMatch(/SpamCop|UCEPROTECT|PSBL|Mailspike|Spamhaus/);
    // Six zones queried, one lookup call each.
    expect(lookupA).toHaveBeenCalledTimes(6);
  });

  it('reports a zone query error as unknown, not a listing, without masking a real listing elsewhere', async () => {
    const lookupA = vi.fn((name: string) => {
      if (name.includes('zen.spamhaus.org')) return Promise.resolve(['127.255.255.255']); // rate limited
      return Promise.resolve([]);
    });
    const monitor = createBlocklistMonitor({ ip: '203.0.113.9', resolverServer: '10.0.0.1:53', zoneKeys: ['spamhaus', 'barracuda'], lookupA });
    const result = await monitor?.check();
    expect(result?.ok).toBe(true);
    expect(result?.detail).toMatch(/not listed on/);
  });

  it('defaults to a 6-hour minInterval, so the runner checks it at most every 6 hours', () => {
    const monitor = createBlocklistMonitor({ ip: '203.0.113.9', resolverServer: '10.0.0.1:53' });
    expect(monitor?.minIntervalMs).toBe(6 * 3_600_000);
  });
});

describe('ntp monitor (PST-REQ-100)', () => {
  it('is disabled with no server configured', () => {
    expect(createNtpMonitor({ server: '' })).toBeNull();
  });

  it('fires when the offset exceeds the threshold and clears within it, reporting getStatus()', async () => {
    const query = vi.fn().mockResolvedValueOnce({ offsetMs: 5_000, server: 'time.cloudflare.com' }).mockResolvedValueOnce({ offsetMs: 10, server: 'time.cloudflare.com' });
    const monitor = createNtpMonitor({ server: 'time.cloudflare.com', thresholdMs: 2_000, query });
    expect(monitor).not.toBeNull();
    expect(monitor?.getStatus()).toBeNull();
    const firing = await monitor?.check();
    expect(firing?.ok).toBe(false);
    expect(monitor?.getStatus()).toMatchObject({ synchronized: false, offsetMs: 5_000, server: 'time.cloudflare.com' });
    const clear = await monitor?.check();
    expect(clear?.ok).toBe(true);
    expect(monitor?.getStatus()).toMatchObject({ synchronized: true, offsetMs: 10 });
  });
});
