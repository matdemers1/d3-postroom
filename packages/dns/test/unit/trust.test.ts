import { describe, expect, it } from 'vitest';
import { DnsPublicResolverRefusedError } from '../../src/errors.js';
import { isTrustedResolverAddress, parseServer, refuseIfPublicResolver } from '../../src/trust.js';

describe('parseServer', () => {
  it('splits host:port', () => {
    expect(parseServer('127.0.0.1:53')).toEqual({ host: '127.0.0.1', port: 53 });
    expect(parseServer('unbound:53')).toEqual({ host: 'unbound', port: 53 });
  });

  it('defaults to port 53 for a bare host', () => {
    expect(parseServer('127.0.0.1')).toEqual({ host: '127.0.0.1', port: 53 });
  });

  it('handles bracketed IPv6 literals', () => {
    expect(parseServer('[::1]:53')).toEqual({ host: '::1', port: 53 });
  });
});

describe('isTrustedResolverAddress (PST-REQ-064: AD only trusted from our own resolver)', () => {
  it('trusts loopback and the compose service name', () => {
    expect(isTrustedResolverAddress('127.0.0.1')).toBe(true);
    expect(isTrustedResolverAddress('localhost')).toBe(true);
    expect(isTrustedResolverAddress('unbound')).toBe(true);
    expect(isTrustedResolverAddress('::1')).toBe(true);
  });

  it('trusts RFC 1918 private ranges', () => {
    expect(isTrustedResolverAddress('10.1.2.3')).toBe(true);
    expect(isTrustedResolverAddress('192.168.1.1')).toBe(true);
    expect(isTrustedResolverAddress('172.20.0.5')).toBe(true);
  });

  it('does not trust a public address', () => {
    expect(isTrustedResolverAddress('8.8.8.8')).toBe(false);
    expect(isTrustedResolverAddress('203.0.113.4')).toBe(false);
    expect(isTrustedResolverAddress('172.32.0.5')).toBe(false); // just outside 172.16/12
  });
});

describe('refuseIfPublicResolver', () => {
  it('throws for known public resolvers', () => {
    for (const server of ['8.8.8.8:53', '1.1.1.1:53', '9.9.9.9:53', '208.67.222.222:53']) {
      expect(() => {
        refuseIfPublicResolver(server);
      }).toThrow(DnsPublicResolverRefusedError);
    }
  });

  it('does not throw for our own resolver', () => {
    expect(() => {
      refuseIfPublicResolver('127.0.0.1:53');
    }).not.toThrow();
    expect(() => {
      refuseIfPublicResolver('unbound:53');
    }).not.toThrow();
  });
});
