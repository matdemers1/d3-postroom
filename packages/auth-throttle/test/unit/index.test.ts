import { describe, expect, it } from 'vitest';
import { PACKAGE, createAuthThrottle, memoryLedger, networkOf, normalizeIp, sourceOf, type AuthAttempt, type Sleep } from '../../src/index.js';

function harness(overrides: { sourceCeiling?: number } = {}) {
  const clock = { t: Date.UTC(2026, 8, 25, 12, 0, 0) };
  const now = (): number => clock.t;
  const slept: number[] = [];
  // Fake sleep: records the tarpit and advances the fake clock by it.
  const sleep: Sleep = (ms) => {
    slept.push(ms);
    clock.t += ms;
    return Promise.resolve();
  };
  const ledger = memoryLedger(now);
  const throttle = createAuthThrottle({ ledger, now, sleep, ...overrides });
  return { clock, slept, ledger, throttle };
}

const alice: AuthAttempt = { protocol: 'imap', username: 'Alice@D3cloud.io', ip: '198.51.100.7' };

describe('@postroom/auth-throttle', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE).toBe('@postroom/auth-throttle');
  });

  it('ten consecutive failures: delays never fall, rise strictly from the 4th, and cap at 30 s', async () => {
    const { throttle, ledger } = harness();
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      const gate = await throttle.before(alice);
      expect(gate.outcome).toBe('proceed');
      delays.push(gate.delayMs);
      await throttle.failure(alice, 'bad-password');
    }
    expect(delays).toEqual([0, 0, 0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] ?? 0);
    for (let i = 4; i < 9; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1] ?? 0);
    expect(Math.max(...delays)).toBe(30_000);
    // An eleventh attempt is still capped.
    expect((await throttle.before(alice)).delayMs).toBe(30_000);
    expect(ledger.entries).toHaveLength(10);
    expect(ledger.entries[0]).toMatchObject({ protocol: 'imap', username: 'alice@d3cloud.io', network: '198.51.100.0/24', reason: 'bad-password' });
  });

  it('keys the streak on username (case-insensitive) and the /24, not the exact address', async () => {
    const { throttle } = harness();
    for (let i = 0; i < 4; i++) await throttle.failure({ ...alice, ip: `198.51.100.${String(10 + i)}` }, 'bad-password');
    expect((await throttle.before({ ...alice, username: 'ALICE@d3cloud.io' })).delayMs).toBe(2_000);
    // Another network or another user starts clean.
    expect((await throttle.before({ ...alice, ip: '203.0.113.1' })).delayMs).toBe(0);
    expect((await throttle.before({ ...alice, username: 'bob@d3cloud.io' })).delayMs).toBe(0);
  });

  it('failures across many usernames from one address trip the source ceiling: 30 s and refuse', async () => {
    const { throttle } = harness();
    for (let i = 0; i < 19; i++) await throttle.failure({ ...alice, username: `user${String(i)}@d3cloud.io` }, 'unknown-user');
    const below = await throttle.before({ ...alice, username: 'fresh@d3cloud.io' });
    expect(below).toMatchObject({ outcome: 'proceed', delayMs: 0, sourceFailures: 19 });
    await throttle.failure({ ...alice, username: 'user19@d3cloud.io' }, 'unknown-user');
    const tripped = await throttle.before({ ...alice, username: 'fresh@d3cloud.io' });
    expect(tripped).toMatchObject({ outcome: 'refuse', delayMs: 30_000, streak: 0, sourceFailures: 20 });
    // The ceiling is per source: a neighbour in the same /24 is not refused.
    expect((await throttle.before({ ...alice, ip: '198.51.100.8', username: 'fresh@d3cloud.io' })).outcome).toBe('proceed');
  });

  it('a success resets the streak without deleting the failures', async () => {
    const { throttle, ledger } = harness();
    for (let i = 0; i < 6; i++) await throttle.failure(alice, 'bad-password');
    expect((await throttle.before(alice)).delayMs).toBe(8_000);
    await throttle.success(alice);
    const after = await throttle.before(alice);
    expect(after).toMatchObject({ delayMs: 0, streak: 0 });
    expect(ledger.entries).toHaveLength(6);
    // New failures after the success build a new streak from zero.
    for (let i = 0; i < 3; i++) await throttle.failure(alice, 'bad-password');
    expect((await throttle.before(alice)).delayMs).toBe(1_000);
  });

  it('the 15-minute window slides: old failures stop counting one by one', async () => {
    const { throttle, clock } = harness();
    for (let i = 0; i < 5; i++) {
      await throttle.failure(alice, 'bad-password');
      clock.t += 60_000;
    }
    // Failures at t0, t0+1m, …, t0+4m; now t0+5m.
    expect((await throttle.before(alice)).streak).toBe(5);
    clock.t += 10 * 60_000 - 5_000; // before() slept 4 s, so now t0+15m-1s: nothing has aged out
    expect((await throttle.before(alice)).streak).toBe(5);
    clock.t += 60_000; // the first two are now older than 15 minutes
    expect((await throttle.before(alice)).streak).toBe(3);
    clock.t += 15 * 60_000;
    expect(await throttle.before(alice)).toMatchObject({ streak: 0, delayMs: 0 });
  });

  it('an aborted client stops the tarpit and gets no verdict', async () => {
    const ledger = memoryLedger();
    const throttle = createAuthThrottle({ ledger, baseDelayMs: 60_000, maxDelayMs: 60_000 });
    for (let i = 0; i < 3; i++) await throttle.failure(alice, 'bad-password');
    const ac = new AbortController();
    const started = Date.now();
    const pending = throttle.before(alice, ac.signal);
    setTimeout(() => {
      ac.abort();
    }, 20);
    const gate = await pending;
    expect(gate.outcome).toBe('aborted');
    expect(gate.delayMs).toBe(60_000);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('the real sleep does not block the event loop', async () => {
    const ledger = memoryLedger();
    const throttle = createAuthThrottle({ ledger, baseDelayMs: 50, maxDelayMs: 50 });
    for (let i = 0; i < 3; i++) await throttle.failure(alice, 'bad-password');
    let ticked = false;
    setTimeout(() => {
      ticked = true;
    }, 5);
    const gate = await throttle.before(alice);
    expect(gate).toMatchObject({ outcome: 'proceed', delayMs: 50 });
    expect(ticked).toBe(true);
  });
});

describe('networks', () => {
  it('normalizes and groups addresses', () => {
    expect(normalizeIp('::FFFF:192.0.2.9')).toBe('192.0.2.9');
    expect(networkOf('192.0.2.9')).toBe('192.0.2.0/24');
    expect(networkOf('::ffff:192.0.2.9')).toBe('192.0.2.0/24');
    expect(networkOf('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(networkOf('2001:DB8::1')).toBe('2001:db8:0:0::/64');
    expect(networkOf('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(networkOf('::1')).toBe('0:0:0:0::/64');
    expect(networkOf('unknown')).toBe('unknown');
    expect(sourceOf('192.0.2.9')).toBe('192.0.2.9');
    expect(sourceOf('2001:db8:1:2::99')).toBe('2001:db8:1:2::/64');
  });
});
