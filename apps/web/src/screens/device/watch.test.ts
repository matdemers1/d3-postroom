// PST-T-16.16 (PST-DA-039): the first-use watch asks every five seconds, stops on the first sign-in,
// on unmount, or after ten minutes; it survives a failed check; and the page is "Connect a device"
// with its four clients and the copyable settings.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeForPath } from '../../routes';
import { POLL_INTERVAL_MS, POLL_LIMIT_MS, connectedMessage, securityLabel, startWatch, type Observation } from './watch';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('startWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks at once, then every five seconds, and stops at the first sign-in', async () => {
    const answers: Observation[] = [
      { redeemed: false, lastUsedAt: null },
      { redeemed: true, lastUsedAt: null },
      { redeemed: true, lastUsedAt: '2026-09-30T12:00:00.000Z' },
    ];
    const check = vi.fn(() => Promise.resolve(answers.shift() ?? { redeemed: true, lastUsedAt: 'later' }));
    const updates: Observation[] = [];
    startWatch(check, (o) => updates.push(o), () => undefined, { now: () => Date.now() });
    await flush();
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);
    expect(updates.at(-1)?.lastUsedAt).toBe('2026-09-30T12:00:00.000Z');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('stops asking when stopped (the screen unmounted)', async () => {
    const check = vi.fn(() => Promise.resolve({ redeemed: false, lastUsedAt: null }));
    const stop = startWatch(check, () => undefined, () => undefined, { now: () => Date.now() });
    await flush();
    stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('keeps asking after a failed check', async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ redeemed: true, lastUsedAt: '2026-09-30T12:00:00.000Z' });
    const updates: Observation[] = [];
    startWatch(check, (o) => updates.push(o), () => undefined, { now: () => Date.now() });
    await flush();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(updates).toHaveLength(1);
  });

  it('gives up after ten minutes, once', async () => {
    const check = vi.fn(() => Promise.resolve({ redeemed: false, lastUsedAt: null }));
    const timeout = vi.fn();
    startWatch(check, () => undefined, timeout, { now: () => Date.now() });
    await vi.advanceTimersByTimeAsync(POLL_LIMIT_MS + POLL_INTERVAL_MS * 3);
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(check.mock.calls.length).toBeLessThanOrEqual(POLL_LIMIT_MS / POLL_INTERVAL_MS + 1);
    const calls = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
    expect(check).toHaveBeenCalledTimes(calls);
  });
});

describe('copy', () => {
  it('says where and when it connected', () => {
    const message = connectedMessage('2026-09-30T15:42:00.000Z', 'en-US');
    expect(message).toMatch(/^Connected over IMAP at \d{1,2}:\d{2}/);
  });

  it('names transport security the way mail apps do', () => {
    expect(securityLabel('tls')).toBe('SSL/TLS');
    expect(securityLabel('starttls')).toBe('STARTTLS');
  });
});

describe('the Connect a device page', () => {
  const read = (path: string): string => readFileSync(join(__dirname, path), 'utf8');

  it('is titled Connect a device, in the route table and on the page', () => {
    expect(routeForPath('/settings/security')?.title).toBe('Connect a device');
    expect(read('../DeviceSetup.tsx')).toContain('<PageHeader title="Connect a device"');
  });

  it('offers iPhone, Mac, Thunderbird and Other', () => {
    const page = read('../DeviceSetup.tsx');
    for (const label of ['iPhone', 'Mac', 'Thunderbird', 'Other']) expect(page).toContain(`label: '${label}'`);
  });

  it('gives the IMAP server, both SMTP ports and the username a Copy each', () => {
    const block = read('ServerSettings.tsx');
    for (const label of ['label="IMAP server"', 'label="IMAP port"', 'label="SMTP server"', 'label={`SMTP port ${String(s.port)}`}', 'label="username"']) expect(block).toContain(label);
  });

  it('shows the same settings block in the app-password reveal', () => {
    const passwords = read('../AppPasswords.tsx');
    expect(passwords).toContain('<ServerSettings />');
    expect(passwords).toContain("watch={{ kind: 'password', id: revealed.id }}");
  });
});
