// The FCrDNS guard (PST-T-4.16, PST-REQ-187) against a fake resolver: PTR(EDGE_PUBLIC_IP) must name
// the EHLO host, and that host's A record must resolve back to EDGE_PUBLIC_IP, in both directions,
// before direct delivery on :25 is allowed to run at all.
import { RCode, RRType, type DnsAnswer, type Resolver, type ResolverResult } from '@postroom/dns';
import { describe, expect, it, vi } from 'vitest';
import { createFcrdnsGuard, DEFAULT_STALE_VALID_MS, DEFAULT_TTL_MS } from '../../src/transports/fcrdns.js';

const EDGE_IP = '18.208.39.127';
const HELO = 'mx.d3cloud.io';

function ptrAnswer(target: string): DnsAnswer {
  return { name: '127.39.208.18.in-addr.arpa.', ttl: 300, type: RRType.PTR, class: 1, kind: 'PTR', target };
}
function aAnswer(name: string, address: string): DnsAnswer {
  return { name, ttl: 300, type: RRType.A, class: 1, kind: 'A', address };
}
function ok(answers: DnsAnswer[]): ResolverResult {
  return { rcode: RCode.NOERROR, ad: true, answers, authority: [] };
}

interface Script {
  ptr?: ResolverResult | (() => Promise<ResolverResult>);
  a?: ResolverResult | (() => Promise<ResolverResult>);
}

function fakeResolver(script: Script): Resolver & { calls: { ptr: number; a: number } } {
  const calls = { ptr: 0, a: 0 };
  const resolve = (entry: ResolverResult | (() => Promise<ResolverResult>) | undefined): Promise<ResolverResult> => {
    if (entry === undefined) return Promise.resolve(ok([]));
    return typeof entry === 'function' ? entry() : Promise.resolve(entry);
  };
  return {
    calls,
    query: () => Promise.reject(new Error('fcrdns test resolver: query() not scripted')),
    a: () => { calls.a++; return resolve(script.a); },
    aaaa: () => Promise.reject(new Error('not scripted')),
    mx: () => Promise.reject(new Error('not scripted')),
    txt: () => Promise.reject(new Error('not scripted')),
    tlsa: () => Promise.reject(new Error('not scripted')),
    ptr: () => { calls.ptr++; return resolve(script.ptr); },
  };
}

describe('createFcrdnsGuard', () => {
  it('holds when PTR names the EHLO host and its A record is the egress IP', async () => {
    const resolver = fakeResolver({ ptr: ok([ptrAnswer(HELO)]), a: ok([aAnswer(HELO, EDGE_IP)]) });
    const guard = createFcrdnsGuard({ edgeIp: EDGE_IP, heloName: HELO, resolver });
    await expect(guard.check()).resolves.toEqual({ valid: true });
  });

  it('does not hold on a PTR mismatch (the AWS default, PST production today), and says so', async () => {
    const resolver = fakeResolver({ ptr: ok([ptrAnswer('ec2-18-208-39-127.compute-1.amazonaws.com')]), a: ok([aAnswer(HELO, EDGE_IP)]) });
    const guard = createFcrdnsGuard({ edgeIp: EDGE_IP, heloName: HELO, resolver });
    const verdict = await guard.check();
    expect(verdict).toMatchObject({ valid: false });
    expect(!verdict.valid ? verdict.reason : '').toMatch(/^FCrDNS not yet valid: PTR is ec2-18-208-39-127\.compute-1\.amazonaws\.com/);
    // The A lookup never runs once the PTR itself is wrong: no point resolving a name that was not confirmed.
    expect(resolver.calls.a).toBe(0);
  });

  it('does not hold when the A record for the EHLO host does not match the egress IP', async () => {
    const resolver = fakeResolver({ ptr: ok([ptrAnswer(HELO)]), a: ok([aAnswer(HELO, '203.0.113.9')]) });
    const guard = createFcrdnsGuard({ edgeIp: EDGE_IP, heloName: HELO, resolver });
    const verdict = await guard.check();
    expect(verdict).toMatchObject({ valid: false });
    expect(!verdict.valid ? verdict.reason : '').toMatch(/^FCrDNS not yet valid: A record for mx\.d3cloud\.io is 203\.0\.113\.9/);
  });

  it('does not hold when EDGE_PUBLIC_IP is unset, without touching the resolver', async () => {
    const resolver = fakeResolver({});
    const guard = createFcrdnsGuard({ edgeIp: undefined, heloName: HELO, resolver });
    const verdict = await guard.check();
    expect(verdict).toEqual({ valid: false, reason: 'FCrDNS not yet valid: EDGE_PUBLIC_IP is not set' });
    expect(resolver.calls.ptr).toBe(0);
    expect(resolver.calls.a).toBe(0);
  });

  it('caches a verdict for up to 15 minutes by default, then looks again', async () => {
    let now = new Date('2026-09-27T00:00:00Z');
    const resolver = fakeResolver({ ptr: ok([ptrAnswer(HELO)]), a: ok([aAnswer(HELO, EDGE_IP)]) });
    const guard = createFcrdnsGuard({ edgeIp: EDGE_IP, heloName: HELO, resolver, now: () => now });
    await expect(guard.check()).resolves.toEqual({ valid: true });
    expect(resolver.calls.ptr).toBe(1);

    now = new Date(now.getTime() + DEFAULT_TTL_MS - 1);
    await expect(guard.check()).resolves.toEqual({ valid: true });
    expect(resolver.calls.ptr).toBe(1); // still cached, one millisecond short of the window

    now = new Date(now.getTime() + 1);
    await expect(guard.check()).resolves.toEqual({ valid: true });
    expect(resolver.calls.ptr).toBe(2); // the window elapsed: looked again
  });

  it('logs once when the verdict changes, not on every check', async () => {
    let now = new Date('2026-09-27T00:00:00Z');
    let holds = false;
    const resolver = fakeResolver({
      ptr: () => Promise.resolve(ok([ptrAnswer(holds ? HELO : 'ec2-18-208-39-127.compute-1.amazonaws.com')])),
      a: ok([aAnswer(HELO, EDGE_IP)]),
    });
    const log = vi.fn();
    const guard = createFcrdnsGuard({ edgeIp: EDGE_IP, heloName: HELO, resolver, now: () => now, log, ttlMs: 1 });

    await guard.check(); // invalid (PTR mismatch), first ever verdict: no "change" to log
    expect(log).not.toHaveBeenCalled();

    now = new Date(now.getTime() + 2);
    await guard.check(); // still invalid: unchanged, no log
    expect(log).not.toHaveBeenCalled();

    holds = true;
    now = new Date(now.getTime() + 2);
    await guard.check(); // flips to valid: exactly one log line
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('fcrdns-verdict-changed', expect.objectContaining({ from: false, to: true }));

    now = new Date(now.getTime() + 2);
    await guard.check(); // still valid: no further log
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a lookup error keeps a still-fresh valid verdict, but fails closed once it goes stale', async () => {
    let now = new Date('2026-09-27T00:00:00Z');
    let failing = false;
    const resolver = fakeResolver({
      ptr: () => (failing ? Promise.reject(new Error('DNS SERVFAIL')) : Promise.resolve(ok([ptrAnswer(HELO)]))),
      a: ok([aAnswer(HELO, EDGE_IP)]),
    });
    const guard = createFcrdnsGuard({ edgeIp: EDGE_IP, heloName: HELO, resolver, now: () => now, ttlMs: 1 });

    await expect(guard.check()).resolves.toEqual({ valid: true });

    failing = true;
    now = new Date(now.getTime() + DEFAULT_STALE_VALID_MS - 1);
    await expect(guard.check()).resolves.toEqual({ valid: true }); // still within the grace window

    now = new Date(now.getTime() + 2);
    const verdict = await guard.check(); // grace window elapsed: fails closed
    expect(verdict).toMatchObject({ valid: false });
    expect(!verdict.valid ? verdict.reason : '').toMatch(/^FCrDNS not yet valid: lookup failed/);
  });
});
