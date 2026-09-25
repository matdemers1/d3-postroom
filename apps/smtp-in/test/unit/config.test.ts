import { describe, expect, it } from 'vitest';
import { loadConfig, MAX_MESSAGE_SIZE } from '../../src/config.js';
import { canonicalIp } from '../../src/rdns.js';
import { looksLikeProxyHeader } from '../../src/server.js';
import { encodeProxyV2 } from '@postroom/proxy-protocol';

describe('loadConfig', () => {
  it('defaults: :25, mx.d3cloud.io, SIZE 104857600, edge peer 10.77.0.1, 5 s PROXY deadline, no TLS', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 25,
      hostname: 'mx.d3cloud.io',
      maxSize: 104_857_600,
      edgePeers: ['10.77.0.1'],
      proxyTimeoutMs: 5_000,
      maxRecipientsPerMessage: 100,
      maxErrors: 10,
      tlsCertFile: undefined,
      tlsKeyFile: undefined,
    });
    expect(MAX_MESSAGE_SIZE).toBe(104_857_600);
  });

  it('reads a list of edge peers and the TLS files', () => {
    const c = loadConfig({ EDGE_PEER_ADDRESS: '10.77.0.1, fd00::1', TLS_CERT_FILE: '/c.pem', TLS_KEY_FILE: '/k.pem', SMTP_PORT: '2525' });
    expect(c.edgePeers).toEqual(['10.77.0.1', 'fd00::1']);
    expect(c.tlsCertFile).toBe('/c.pem');
    expect(c.port).toBe(2525);
  });
});

describe('canonicalIp', () => {
  it('unmaps IPv4-mapped IPv6 and canonicalises IPv6', () => {
    expect(canonicalIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(canonicalIp('2001:DB8:0:0::1')).toBe('2001:db8::1');
    expect(canonicalIp('192.0.2.1')).toBe('192.0.2.1');
  });
});

describe('looksLikeProxyHeader', () => {
  it('spots v2 and v1 headers and nothing else', () => {
    const v2 = encodeProxyV2({
      command: 'PROXY',
      family: 'TCP4',
      source: { address: '1.2.3.4', port: 1 },
      destination: { address: '5.6.7.8', port: 25 },
    });
    expect(looksLikeProxyHeader(v2)).toBe(true);
    expect(looksLikeProxyHeader(Buffer.from('PROXY TCP4 1.2.3.4 5.6.7.8 1 25\r\n'))).toBe(true);
    expect(looksLikeProxyHeader(Buffer.from('EHLO client.example\r\n'))).toBe(false);
  });
});
