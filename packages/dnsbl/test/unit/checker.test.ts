import { RCode, RRType, type DnsAnswer, type Resolver, type ResolverResult } from '@postroom/dns';
import { describe, expect, it, vi } from 'vitest';
import { createDnsblChecker } from '../../src/checker.js';

function aAnswer(address: string): DnsAnswer {
  return { kind: 'A', name: 'ignored', ttl: 300, type: RRType.A, class: 1, address };
}

function fakeResolver(handler: (name: string) => Promise<ResolverResult> | ResolverResult): Resolver {
  const notImplemented = (): never => {
    throw new Error('not implemented in this fake');
  };
  return {
    query: (name) => Promise.resolve(handler(name)),
    a: (name) => Promise.resolve(handler(name)),
    aaaa: notImplemented,
    mx: notImplemented,
    txt: notImplemented,
    tlsa: notImplemented,
    ptr: notImplemented,
  };
}

function nxdomain(): ResolverResult {
  return { rcode: RCode.NXDOMAIN, ad: false, answers: [], authority: [] };
}

function listed(...addresses: string[]): ResolverResult {
  return { rcode: RCode.NOERROR, ad: false, answers: addresses.map(aAnswer), authority: [] };
}

describe('createDnsblChecker: boot-time resolver trust (PST-REQ-063)', () => {
  it.each(['1.1.1.1', '1.1.1.1:53', '8.8.8.8', '9.9.9.9', '208.67.222.222'])('refuses the public resolver %s', (server) => {
    expect(() => createDnsblChecker({ resolver: fakeResolver(nxdomain), server })).toThrow(/DNSBL requires our own validating resolver/);
  });

  it('refuses a public resolver even when a DQS key is configured', () => {
    expect(() => createDnsblChecker({ resolver: fakeResolver(nxdomain), server: '1.1.1.1', dqsKey: 'testkey' })).toThrow(
      /DNSBL requires our own validating resolver/,
    );
  });

  it.each(['127.0.0.1', '10.0.0.5', '192.168.1.1', 'unbound', 'unbound:53'])('accepts our own resolver %s', (server) => {
    expect(() => createDnsblChecker({ resolver: fakeResolver(nxdomain), server })).not.toThrow();
  });
});

describe('createDnsblChecker: lookup policy', () => {
  it('an SBL-listed IP (127.0.0.2, Spamhaus\'s reserved test address) is listed and reject-worthy', async () => {
    const checker = createDnsblChecker({ resolver: fakeResolver(() => listed('127.0.0.2')), server: '127.0.0.1' });
    const result = await checker.lookup('203.0.113.9');
    expect(result.listed).toBe(true);
    expect(result.lists).toEqual(['SBL']);
    expect(result.zone).toBe('zen.spamhaus.org');
  });

  it('an XBL-listed IP is listed and reject-worthy', async () => {
    const checker = createDnsblChecker({ resolver: fakeResolver(() => listed('127.0.0.4')), server: '127.0.0.1' });
    const result = await checker.lookup('203.0.113.9');
    expect(result.listed).toBe(true);
    expect(result.lists).toEqual(['XBL']);
  });

  it('a PBL-only listing is recorded but is not reject-worthy', async () => {
    const checker = createDnsblChecker({ resolver: fakeResolver(() => listed('127.0.0.10')), server: '127.0.0.1' });
    const result = await checker.lookup('203.0.113.9');
    expect(result.listed).toBe(false);
    expect(result.lists).toEqual(['PBL']);
  });

  it('NXDOMAIN is not listed', async () => {
    const checker = createDnsblChecker({ resolver: fakeResolver(nxdomain), server: '127.0.0.1' });
    const result = await checker.lookup('203.0.113.9');
    expect(result.listed).toBe(false);
    expect(result.lists).toEqual([]);
  });

  it('a resolver error (timeout/SERVFAIL-like) is not listed, never 5xx\'d, and flags health', async () => {
    const checker = createDnsblChecker({
      resolver: fakeResolver(() => Promise.reject(new Error('SERVFAIL'))),
      server: '127.0.0.1',
    });
    const result = await checker.lookup('203.0.113.9');
    expect(result.listed).toBe(false);
    expect(result.reason).toBe('dnsbl temporarily unavailable');
    expect(checker.health().ok).toBe(false);
  });

  it('a 127.255.255.254 signalling code (queried via a public resolver) is not listed and flags health', async () => {
    const checker = createDnsblChecker({ resolver: fakeResolver(() => listed('127.255.255.254')), server: '127.0.0.1' });
    const result = await checker.lookup('203.0.113.9');
    expect(result.listed).toBe(false);
    expect(result.lists).toEqual([]);
    expect(result.reason).toBe('dnsbl temporarily unavailable');
    expect(checker.health().ok).toBe(false);
  });

  it('never reports a zone that embeds the DQS key', async () => {
    const checker = createDnsblChecker({
      resolver: fakeResolver(() => listed('127.0.0.2')),
      server: '127.0.0.1',
      dqsKey: 'super-secret-key',
    });
    const result = await checker.lookup('203.0.113.9');
    expect(result.zone).toBe('zen.spamhaus.org');
    expect(JSON.stringify(result)).not.toContain('super-secret-key');
  });

  it('caches a lookup for repeat queries of the same IP', async () => {
    const handler = vi.fn(() => listed('127.0.0.2'));
    const checker = createDnsblChecker({ resolver: fakeResolver(handler), server: '127.0.0.1' });
    await checker.lookup('203.0.113.9');
    await checker.lookup('203.0.113.9');
    await checker.lookup('203.0.113.9');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not cache across different IPs', async () => {
    const handler = vi.fn(() => nxdomain());
    const checker = createDnsblChecker({ resolver: fakeResolver(handler), server: '127.0.0.1' });
    await checker.lookup('203.0.113.9');
    await checker.lookup('203.0.113.10');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
