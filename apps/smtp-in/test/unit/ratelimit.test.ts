// PST-REQ-185: per-/24 (/64) fixed windows, reset after the window, bounded memory, private exempt.
import { describe, expect, it } from 'vitest';
import { networkOf } from '../../src/greylist.js';
import { InboundRateLimits, RATE_LIMIT_DEFAULTS, WindowCounter } from '../../src/ratelimit.js';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('WindowCounter', () => {
  it('allows `limit` events per window, is over on the next, and resets once the window passes', () => {
    const c = clock();
    const w = new WindowCounter({ limit: 3, windowMs: 60_000, now: c.now });
    expect([1, 2, 3].map(() => w.hit('k').over)).toEqual([false, false, false]);
    expect(w.hit('k').over).toBe(true);
    expect(w.isOver('k')).toBe(true);
    c.advance(59_999);
    expect(w.isOver('k')).toBe(true);
    c.advance(1);
    expect(w.isOver('k')).toBe(false);
    expect(w.hit('k')).toMatchObject({ over: false, count: 1 });
  });

  it('being refused does not extend the window', () => {
    const c = clock();
    const w = new WindowCounter({ limit: 1, windowMs: 10_000, now: c.now });
    w.hit('k');
    for (let i = 0; i < 9; i++) {
      c.advance(1_000);
      expect(w.hit('k').over).toBe(true);
    }
    c.advance(1_000);
    expect(w.hit('k').over).toBe(false);
  });

  it('never tracks more than maxKeys: sweeps expired windows, then evicts the oldest live one', () => {
    const c = clock();
    const w = new WindowCounter({ limit: 1, windowMs: 1_000, maxKeys: 100, now: c.now });
    for (let i = 0; i < 100; i++) w.hit(`a${String(i)}`);
    expect(w.size()).toBe(100);
    c.advance(1_000);
    w.hit('fresh');
    expect(w.size()).toBe(1); // every expired window swept
    for (let i = 0; i < 10_000; i++) w.hit(`b${String(i)}`);
    expect(w.size()).toBeLessThanOrEqual(100);
    expect(w.isOver('b9999')).toBe(false);
    w.hit('b9999');
    expect(w.isOver('b9999')).toBe(true); // the newest survives; the oldest went
    expect(w.isOver('fresh')).toBe(false);
  });
});

describe('InboundRateLimits', () => {
  it('defaults: 30 connections a minute, 20 unknown recipients in ten minutes', () => {
    expect(RATE_LIMIT_DEFAULTS).toEqual({ connectionsPerWindow: 30, connectionWindowMs: 60_000, unknownRecipientsPerWindow: 20, unknownRecipientWindowMs: 600_000 });
  });

  it('counts connections per /24: the 31st from anywhere in the block is refused, another block is not', () => {
    const c = clock();
    const l = new InboundRateLimits({ ...RATE_LIMIT_DEFAULTS, now: c.now });
    for (let i = 0; i < 30; i++) expect(l.onConnect(`198.51.100.${String(i + 1)}`)).toBeNull();
    expect(l.onConnect('198.51.100.200')).toMatchObject({ limit: 'connection-rate', network: '198.51.100.0/24' });
    expect(l.onConnect('198.51.101.1')).toBeNull();
    c.advance(60_000);
    expect(l.onConnect('198.51.100.200')).toBeNull();
  });

  it('counts IPv6 per /64', () => {
    const l = new InboundRateLimits({ ...RATE_LIMIT_DEFAULTS, connectionsPerWindow: 1 });
    expect(l.onConnect('2001:db8:1:2::1')).toBeNull();
    expect(l.onConnect('2001:db8:1:2:ffff::9')).toMatchObject({ limit: 'connection-rate' });
    expect(l.onConnect('2001:db8:1:3::1')).toBeNull();
    expect(networkOf('2001:db8:1:2:ffff::9')).toBe('2001:db8:1:2:0:0:0:0/64');
  });

  it('the 21st unknown recipient trips the limit, and the network is then refused at connect until the window passes', () => {
    const c = clock();
    const l = new InboundRateLimits({ ...RATE_LIMIT_DEFAULTS, now: c.now });
    for (let i = 0; i < 20; i++) expect(l.onUnknownRecipient('203.0.113.7')).toBeNull();
    expect(l.onUnknownRecipient('203.0.113.8')).toMatchObject({ limit: 'unknown-recipients', network: '203.0.113.0/24' });
    expect(l.onConnect('203.0.113.99')).toMatchObject({ limit: 'unknown-recipients' });
    c.advance(600_000);
    expect(l.onConnect('203.0.113.99')).toBeNull();
    expect(l.onUnknownRecipient('203.0.113.7')).toBeNull();
  });

  it('loopback, LAN and tailnet clients are exempt, as they are from greylisting', () => {
    const l = new InboundRateLimits({ ...RATE_LIMIT_DEFAULTS, connectionsPerWindow: 0, unknownRecipientsPerWindow: 0 });
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '100.64.0.9', '::1', 'fd00::1']) {
      expect(l.onConnect(ip)).toBeNull();
      expect(l.onUnknownRecipient(ip)).toBeNull();
    }
    expect(l.tracked()).toEqual({ connections: 0, unknownRecipients: 0 });
  });
});
