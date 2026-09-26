import { describe, expect, it } from 'vitest';
import { refuseIfPublicResolver } from '../../src/trust.js';

describe('refuseIfPublicResolver hardening (PST-REQ-063)', () => {
  it('refuses public resolvers however the value is padded or spelled', () => {
    for (const s of [' 1.1.1.1', '1.1.1.1 ', '\t8.8.8.8:53\n', '[2606:4700:4700::1111]:53', 'dns.google', 'one.one.one.one:53', 'DNS.GOOGLE.']) {
      expect(() => { refuseIfPublicResolver(s); }, JSON.stringify(s)).toThrow();
    }
  });
  it('accepts our own resolver by service name, loopback or private address', () => {
    for (const s of ['unbound:53', 'unbound', 'localhost:53', '127.0.0.1', '10.0.0.53:53', ' unbound:53 ']) {
      expect(() => { refuseIfPublicResolver(s); }, JSON.stringify(s)).not.toThrow();
    }
  });
});
