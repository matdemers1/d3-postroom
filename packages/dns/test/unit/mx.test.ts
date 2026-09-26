import { describe, expect, it } from 'vitest';
import { DnsServfailError } from '../../src/errors.js';
import { resolveMxTargets } from '../../src/mx.js';
import { RCode } from '../../src/types.js';
import type { DnsAnswer, Resolver, ResolverResult } from '../../src/types.js';

function mxAnswer(name: string, preference: number, exchange: string): DnsAnswer {
  return { kind: 'MX', name, ttl: 300, type: 15, class: 1, preference, exchange };
}
function aAnswer(name: string, address: string): DnsAnswer {
  return { kind: 'A', name, ttl: 300, type: 1, class: 1, address };
}

function stubResolver(handlers: Partial<Record<'mx' | 'a' | 'aaaa', (name: string) => Promise<ResolverResult> | ResolverResult>>): Resolver {
  const empty = (): ResolverResult => ({ rcode: RCode.NOERROR, ad: false, answers: [], authority: [] });
  return {
    query: () => Promise.resolve(empty()),
    mx: async (name) => handlers.mx ? handlers.mx(name) : empty(),
    a: async (name) => handlers.a ? handlers.a(name) : empty(),
    aaaa: async (name) => handlers.aaaa ? handlers.aaaa(name) : empty(),
    txt: () => Promise.resolve(empty()),
    tlsa: () => Promise.resolve(empty()),
    ptr: () => Promise.resolve(empty()),
  };
}

describe('resolveMxTargets: MX order', () => {
  it('orders by preference ascending and randomizes only within a tie group', async () => {
    const resolver = stubResolver({
      mx: () => ({
        rcode: RCode.NOERROR,
        ad: true,
        authority: [],
        answers: [
          mxAnswer('example.com', 20, 'low.example.com'),
          mxAnswer('example.com', 10, 'mid-a.example.com'),
          mxAnswer('example.com', 10, 'mid-b.example.com'),
        ],
      }),
      a: (name) => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [aAnswer(name, '203.0.113.1')] }),
      aaaa: () => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [] }),
    });
    // rng fixed at 0 => no swaps in the Fisher-Yates shuffle, deterministic tie order preserved.
    const result = await resolveMxTargets(resolver, 'example.com', { rng: () => 0 });
    expect(result.kind).toBe('mx');
    if (result.kind !== 'mx') return;
    const preferences = result.targets.map((t) => t.preference);
    expect(preferences).toEqual([10, 10, 20]);
    expect(result.targets[2]?.host).toBe('low.example.com');
    const tieHosts = new Set(result.targets.slice(0, 2).map((t) => t.host));
    expect(tieHosts).toEqual(new Set(['mid-a.example.com', 'mid-b.example.com']));
    expect(result.targets[0]?.addresses).toEqual(['203.0.113.1']);
  });
});

describe('resolveMxTargets: implicit MX', () => {
  it('falls back to the domain A/AAAA record when there is no MX', async () => {
    const resolver = stubResolver({
      mx: () => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [] }),
      a: (name) => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [aAnswer(name, '198.51.100.5')] }),
      aaaa: () => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [] }),
    });
    const result = await resolveMxTargets(resolver, 'nomx.example.com');
    expect(result.kind).toBe('implicit');
    if (result.kind !== 'implicit') return;
    expect(result.targets).toEqual([{ host: 'nomx.example.com', preference: 0, addresses: ['198.51.100.5'] }]);
  });

  it('is a permanent failure when there is neither MX nor an address', async () => {
    const resolver = stubResolver({
      mx: () => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [] }),
      a: () => ({ rcode: RCode.NXDOMAIN, ad: true, authority: [], answers: [] }),
      aaaa: () => ({ rcode: RCode.NXDOMAIN, ad: true, authority: [], answers: [] }),
    });
    const result = await resolveMxTargets(resolver, 'ghost.example.com');
    expect(result).toEqual({ kind: 'permanent', reason: 'no-mx-no-address' });
  });
});

describe('resolveMxTargets: null MX', () => {
  it('honours RFC 7505 null MX as "do not deliver"', async () => {
    const resolver = stubResolver({
      mx: () => ({
        rcode: RCode.NOERROR,
        ad: true,
        authority: [],
        answers: [mxAnswer('nomail.example.com', 0, '.')],
      }),
    });
    const result = await resolveMxTargets(resolver, 'nomail.example.com');
    expect(result).toEqual({ kind: 'null-mx' });
  });
});

describe('resolveMxTargets: NXDOMAIN and SERVFAIL', () => {
  it('is a permanent failure on NXDOMAIN', async () => {
    const resolver = stubResolver({ mx: () => ({ rcode: RCode.NXDOMAIN, ad: true, authority: [], answers: [] }) });
    const result = await resolveMxTargets(resolver, 'doesnotexist.example.com');
    expect(result).toEqual({ kind: 'permanent', reason: 'nxdomain' });
  });

  it('propagates DnsServfailError (DNSSEC-bogus) rather than treating it as no-record', async () => {
    const resolver = stubResolver({
      mx: () => {
        throw new DnsServfailError('bogus.example.com', 15);
      },
    });
    await expect(resolveMxTargets(resolver, 'bogus.example.com')).rejects.toBeInstanceOf(DnsServfailError);
  });
});

describe('resolveMxTargets: DNSSEC status for DANE (PST-T-7.5)', () => {
  const secureA = (name: string): ResolverResult => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [aAnswer(name, '203.0.113.9')] });
  const insecureA = (name: string): ResolverResult => ({ rcode: RCode.NOERROR, ad: false, authority: [], answers: [aAnswer(name, '203.0.113.9')] });

  it('reports the MX RRset and each host\'s address lookups as validated only when every answer carried AD', async () => {
    const resolver = stubResolver({
      mx: () => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [mxAnswer('example.com', 10, 'a.example.com'), mxAnswer('example.com', 20, 'b.example.com')] }),
      a: (name) => (name === 'a.example.com' ? secureA(name) : insecureA(name)),
    });
    const result = await resolveMxTargets(resolver, 'example.com', { ipv4Only: true, rng: () => 0 });
    expect(result.kind === 'mx' && result.dnssec).toEqual({ mx: true, hosts: { 'a.example.com': true, 'b.example.com': false } });
  });

  it('an unvalidated AAAA answer makes the host insecure when IPv6 is on', async () => {
    const resolver = stubResolver({
      mx: () => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [mxAnswer('example.com', 10, 'a.example.com')] }),
      a: secureA,
      aaaa: () => ({ rcode: RCode.NOERROR, ad: false, authority: [], answers: [] }),
    });
    const result = await resolveMxTargets(resolver, 'example.com', { ipv4Only: false });
    expect(result.kind === 'mx' && result.dnssec).toEqual({ mx: true, hosts: { 'a.example.com': false } });
  });

  it('an unvalidated MX answer is reported as such, and the implicit MX carries its own status', async () => {
    const insecureMx = stubResolver({
      mx: () => ({ rcode: RCode.NOERROR, ad: false, authority: [], answers: [mxAnswer('example.com', 10, 'a.example.com')] }),
      a: secureA,
    });
    const r1 = await resolveMxTargets(insecureMx, 'example.com', { ipv4Only: true });
    expect(r1.kind === 'mx' && r1.dnssec.mx).toBe(false);

    const implicit = stubResolver({ mx: () => ({ rcode: RCode.NOERROR, ad: true, authority: [], answers: [] }), a: secureA });
    const r2 = await resolveMxTargets(implicit, 'nomx.example.com', { ipv4Only: true });
    expect(r2.kind === 'implicit' && r2.dnssec).toEqual({ mx: true, hosts: { 'nomx.example.com': true } });
  });
});
