import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeProxyV2,
  encodeProxyV2,
  isTrustedProxyPeer,
  type EncodeProxyV2Input,
  type ProxyTlv,
} from '../../src/index.js';

const ipv4 = fc
  .tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255))
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

const ipv6 = fc
  .array(fc.nat(0xffff), { minLength: 8, maxLength: 8 })
  .map((groups) => groups.map((g) => g.toString(16)).join(':'));

const port = fc.integer({ min: 0, max: 65535 });

const tlv: fc.Arbitrary<ProxyTlv> = fc.record({
  type: fc.integer({ min: 0, max: 255 }),
  value: fc.uint8Array({ maxLength: 32 }).map((arr) => Buffer.from(arr)),
});

const v4Input: fc.Arbitrary<EncodeProxyV2Input> = fc.record({
  command: fc.constant('PROXY' as const),
  family: fc.constant('TCP4' as const),
  source: fc.record({ address: ipv4, port }),
  destination: fc.record({ address: ipv4, port }),
  tlvs: fc.array(tlv, { maxLength: 4 }),
});

const v6Input: fc.Arbitrary<EncodeProxyV2Input> = fc.record({
  command: fc.constant('PROXY' as const),
  family: fc.constant('TCP6' as const),
  source: fc.record({ address: ipv6, port }),
  destination: fc.record({ address: ipv6, port }),
  tlvs: fc.array(tlv, { maxLength: 4 }),
});

describe('encodeProxyV2 / decodeProxyV2 round-trip', () => {
  it('round-trips random TCP4 headers', () => {
    fc.assert(
      fc.property(v4Input, (input) => {
        const encoded = encodeProxyV2(input);
        const decoded = decodeProxyV2(encoded);
        expect(decoded.kind).toBe('ok');
        if (decoded.kind !== 'ok') return;
        expect(decoded.bytesConsumed).toBe(encoded.length);
        expect(decoded.header.command).toBe('PROXY');
        expect(decoded.header.family).toBe('TCP4');
        expect(decoded.header.source).toEqual(input.source);
        expect(decoded.header.destination).toEqual(input.destination);
        expect(decoded.header.tlvs).toEqual(input.tlvs);
      }),
    );
  });

  it('round-trips random TCP6 headers', () => {
    fc.assert(
      fc.property(v6Input, (input) => {
        const encoded = encodeProxyV2(input);
        const decoded = decodeProxyV2(encoded);
        expect(decoded.kind).toBe('ok');
        if (decoded.kind !== 'ok') return;
        expect(decoded.bytesConsumed).toBe(encoded.length);
        expect(decoded.header.family).toBe('TCP6');
        expect(decoded.header.source?.port).toBe(input.source?.port);
        expect(decoded.header.destination?.port).toBe(input.destination?.port);
        expect(decoded.header.tlvs).toEqual(input.tlvs);
      }),
    );
  });

  it('encodes an IPv4-mapped IPv6 source as TCP4', () => {
    const encoded = encodeProxyV2({
      command: 'PROXY',
      family: 'TCP6',
      source: { address: '::ffff:203.0.113.7', port: 12345 },
      destination: { address: '::ffff:198.51.100.9', port: 25 },
    });
    const decoded = decodeProxyV2(encoded);
    expect(decoded.kind).toBe('ok');
    if (decoded.kind !== 'ok') return;
    expect(decoded.header.family).toBe('TCP4');
    expect(decoded.header.source).toEqual({ address: '203.0.113.7', port: 12345 });
    expect(decoded.header.destination).toEqual({ address: '198.51.100.9', port: 25 });
  });

  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 128 }), (bytes) => {
        expect(() => decodeProxyV2(Buffer.from(bytes))).not.toThrow();
      }),
    );
  });

  it('reports incomplete for any strict prefix of a valid header', () => {
    fc.assert(
      fc.property(v4Input, fc.integer({ min: 0, max: 1000 }), (input, seed) => {
        const full = encodeProxyV2(input);
        if (full.length < 2) return;
        const cutAt = 1 + (seed % (full.length - 1));
        const prefix = full.subarray(0, cutAt);
        const decoded = decodeProxyV2(prefix);
        expect(decoded.kind).toBe('incomplete');
      }),
    );
  });

  it('rejects a v1 text header', () => {
    const v1 = Buffer.from('PROXY TCP4 192.168.0.1 192.168.0.11 56324 443\r\n');
    const decoded = decodeProxyV2(v1);
    expect(decoded.kind).toBe('error');
  });

  it('rejects a header claiming an overflowing length', () => {
    const buf = Buffer.alloc(16);
    buf.set([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a], 0);
    buf[12] = 0x21; // ver/cmd
    buf[13] = 0x11; // fam/proto TCP4
    buf.writeUInt16BE(0xffff, 14);
    const decoded = decodeProxyV2(buf);
    expect(decoded.kind).toBe('incomplete');
  });
});

describe('isTrustedProxyPeer', () => {
  it('matches an exact address', () => {
    expect(isTrustedProxyPeer('10.77.0.2', ['10.77.0.2'])).toBe(true);
  });

  it('normalises an IPv4-mapped IPv6 remoteAddress', () => {
    expect(isTrustedProxyPeer('::ffff:10.77.0.2', ['10.77.0.2'])).toBe(true);
  });

  it('normalises an IPv4-mapped trusted peer entry', () => {
    expect(isTrustedProxyPeer('10.77.0.2', ['::ffff:10.77.0.2'])).toBe(true);
  });

  it('rejects an address not on the list', () => {
    expect(isTrustedProxyPeer('10.77.0.3', ['10.77.0.2'])).toBe(false);
  });
});
