import { describe, expect, it } from 'vitest';
import { isPrivateClient } from '../../src/greylist.js';

describe('isPrivateClient', () => {
  it('exempts loopback, RFC 1918, CGNAT/tailnet, ULA and link-local', () => {
    for (const ip of ['127.0.0.1', '10.77.0.1', '172.20.1.2', '192.168.1.231', '100.101.102.103', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.5']) {
      expect(isPrivateClient(ip), ip).toBe(true);
    }
  });
  it('greylists everyone else', () => {
    for (const ip of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '::ffff:203.0.113.9', 'not-an-ip']) {
      expect(isPrivateClient(ip), ip).toBe(false);
    }
  });
});
