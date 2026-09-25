// Unit test of the @postroom/dns adapter mapping only - no real resolver, no network.
import { RCode } from '@postroom/dns';
import type { DnsAnswer, Resolver, ResolverResult } from '@postroom/dns';
import { DnsServfailError, DnsTimeoutError } from '@postroom/dns';
import { describe, expect, it } from 'vitest';
import { adaptDnsResolver, SpfTempError } from '../../src/index.js';

function fakeResolver(overrides: Partial<Resolver>): Resolver {
  const notImplemented = () => Promise.reject(new Error('not implemented in this fake'));
  return {
    query: notImplemented,
    a: notImplemented,
    aaaa: notImplemented,
    mx: notImplemented,
    txt: notImplemented,
    tlsa: notImplemented,
    ptr: notImplemented,
    ...overrides,
  };
}

function txtAnswer(text: string): DnsAnswer {
  return { kind: 'TXT', name: 'example.com.', ttl: 300, type: 16, class: 1, strings: [text], text };
}

describe('adaptDnsResolver', () => {
  it('maps SERVFAIL (DnsServfailError) to SpfTempError', async () => {
    const resolver = fakeResolver({ txt: () => Promise.reject(new DnsServfailError('example.com', 16)) });
    const dns = adaptDnsResolver(resolver);
    await expect(dns.txt('example.com')).rejects.toBeInstanceOf(SpfTempError);
  });

  it('maps a resolver timeout to SpfTempError', async () => {
    const resolver = fakeResolver({ a: () => Promise.reject(new DnsTimeoutError('timed out')) });
    const dns = adaptDnsResolver(resolver);
    await expect(dns.a('example.com')).rejects.toBeInstanceOf(SpfTempError);
  });

  it('maps NXDOMAIN to a void lookup with no records, not an error', async () => {
    const result: ResolverResult = { rcode: RCode.NXDOMAIN, ad: false, answers: [], authority: [] };
    const resolver = fakeResolver({ a: () => Promise.resolve(result) });
    const dns = adaptDnsResolver(resolver);
    await expect(dns.a('nowhere.example')).resolves.toEqual({ records: [], void: true });
  });

  it('maps a NOERROR response with matching answers to non-void records', async () => {
    const result: ResolverResult = { rcode: RCode.NOERROR, ad: false, answers: [txtAnswer('v=spf1 -all')], authority: [] };
    const resolver = fakeResolver({ txt: () => Promise.resolve(result) });
    const dns = adaptDnsResolver(resolver);
    await expect(dns.txt('example.com')).resolves.toEqual({ records: ['v=spf1 -all'], void: false });
  });

  it('maps a NOERROR response with zero matching answers to a void lookup', async () => {
    const result: ResolverResult = { rcode: RCode.NOERROR, ad: false, answers: [], authority: [] };
    const resolver = fakeResolver({ a: () => Promise.resolve(result) });
    const dns = adaptDnsResolver(resolver);
    await expect(dns.a('example.com')).resolves.toEqual({ records: [], void: true });
  });
});
