import { describe, expect, it } from 'vitest';
import * as dns from '../../src/index.js';

describe('@postroom/dns public API surface', () => {
  it('exports the resolver factory, MX resolution, wire codec and trust helpers', () => {
    expect(typeof dns.createResolver).toBe('function');
    expect(typeof dns.resolveMxTargets).toBe('function');
    expect(typeof dns.encodeQuery).toBe('function');
    expect(typeof dns.decodeMessage).toBe('function');
    expect(typeof dns.refuseIfPublicResolver).toBe('function');
    expect(typeof dns.isTrustedResolverAddress).toBe('function');
    expect(dns.RRType.MX).toBe(15);
    expect(dns.RCode.SERVFAIL).toBe(2);
  });
});
