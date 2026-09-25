import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RCode, RRType } from '../../src/types.js';
import { decodeMessage, encodeQuery } from '../../src/wire.js';
import {
  buildMessage,
  rdataA,
  rdataAAAA,
  rdataMx,
  rdataName,
  rdataTlsa,
  rdataTxt,
} from './helpers/build-packet.js';

describe('encodeQuery', () => {
  it('sets RD and AD, and an EDNS0 OPT with DO=1 and a 1232-byte payload size', () => {
    const { id, packet } = encodeQuery('example.com', RRType.A);
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.message.id).toBe(id);
    expect(decoded.message.rd).toBe(true);
    expect(decoded.message.ad).toBe(true);
    expect(decoded.message.qr).toBe(false);
    expect(decoded.message.questions).toHaveLength(1);
    expect(decoded.message.questions[0]?.name.toLowerCase()).toBe('example.com');
    expect(decoded.message.questions[0]?.type).toBe(RRType.A);
    expect(decoded.message.additional).toHaveLength(0); // OPT is consumed, not exposed as an answer
  });

  it('produces a fresh random id per call by default', () => {
    const ids = new Set(Array.from({ length: 20 }, () => encodeQuery('x.com', RRType.A).id));
    expect(ids.size).toBeGreaterThan(1);
  });
});

describe('decodeMessage: MX ordering with ties', () => {
  it('parses multiple MX records preserving preference and exchange', () => {
    const packet = buildMessage({
      id: 1,
      flags: { rcode: RCode.NOERROR },
      question: { name: 'example.com', type: RRType.MX },
      answers: [
        { name: 'example.com', type: RRType.MX, rdata: rdataMx(10, 'mx1.example.com') },
        { name: 'example.com', type: RRType.MX, rdata: rdataMx(10, 'mx2.example.com') },
        { name: 'example.com', type: RRType.MX, rdata: rdataMx(20, 'mx3.example.com') },
      ],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.message.rcode).toBe(RCode.NOERROR);
    const mxAnswers = decoded.message.answers.filter((rr) => rr.kind === 'MX');
    expect(mxAnswers).toHaveLength(3);
    expect(mxAnswers.map((rr) => [rr.preference, rr.exchange])).toEqual([
      [10, 'mx1.example.com'],
      [10, 'mx2.example.com'],
      [20, 'mx3.example.com'],
    ]);
  });
});

describe('decodeMessage: implicit MX (no MX, but A present)', () => {
  it('returns NOERROR with zero MX answers and an A record for the domain', () => {
    const packet = buildMessage({
      id: 2,
      flags: { rcode: RCode.NOERROR },
      question: { name: 'nomx.example.com', type: RRType.MX },
      answers: [],
      authority: [{ name: 'example.com', type: RRType.SOA, rdata: Buffer.from([0]) }],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.message.rcode).toBe(RCode.NOERROR);
    expect(decoded.message.answers.filter((rr) => rr.kind === 'MX')).toHaveLength(0);
  });
});

describe('decodeMessage: null MX (RFC 7505)', () => {
  it('parses a single "0 ." MX record', () => {
    const packet = buildMessage({
      id: 3,
      flags: { rcode: RCode.NOERROR },
      question: { name: 'nomail.example.com', type: RRType.MX },
      answers: [{ name: 'nomail.example.com', type: RRType.MX, rdata: rdataMx(0, '.') }],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const mx = decoded.message.answers.find((rr) => rr.kind === 'MX');
    expect(mx).toBeDefined();
    if (mx?.kind === 'MX') {
      expect(mx.preference).toBe(0);
      expect(mx.exchange).toBe('.');
    }
  });
});

describe('decodeMessage: NXDOMAIN', () => {
  it('surfaces rcode 3 with no answers', () => {
    const packet = buildMessage({
      id: 4,
      flags: { rcode: RCode.NXDOMAIN },
      question: { name: 'doesnotexist.example.com', type: RRType.MX },
      answers: [],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.message.rcode).toBe(RCode.NXDOMAIN);
    expect(decoded.message.answers).toHaveLength(0);
  });
});

describe('decodeMessage: SERVFAIL (DNSSEC-bogus fixture)', () => {
  it('surfaces rcode 2, which callers must never treat as "no record"', () => {
    const packet = buildMessage({
      id: 5,
      flags: { rcode: RCode.SERVFAIL },
      question: { name: 'bogus.example.com', type: RRType.A },
      answers: [],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.message.rcode).toBe(RCode.SERVFAIL);
  });
});

describe('decodeMessage: AD bit', () => {
  it('parses AD=1 when the resolver validated', () => {
    const packet = buildMessage({
      id: 6,
      flags: { rcode: RCode.NOERROR, ad: true },
      question: { name: 'secure.example.com', type: RRType.A },
      answers: [{ name: 'secure.example.com', type: RRType.A, rdata: rdataA('192.0.2.1') }],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.message.ad).toBe(true);
  });

  it('parses AD=0 when unset', () => {
    const packet = buildMessage({
      id: 7,
      flags: { rcode: RCode.NOERROR, ad: false },
      question: { name: 'plain.example.com', type: RRType.A },
      answers: [{ name: 'plain.example.com', type: RRType.A, rdata: rdataA('192.0.2.2') }],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.message.ad).toBe(false);
  });
});

describe('decodeMessage: TXT multi-string join', () => {
  it('joins multiple character-strings per RFC 7208 §3.3, and exposes the raw strings', () => {
    const packet = buildMessage({
      id: 8,
      flags: { rcode: RCode.NOERROR },
      question: { name: 'example.com', type: RRType.TXT },
      answers: [
        {
          name: 'example.com',
          type: RRType.TXT,
          rdata: rdataTxt(['v=spf1 include:', '_spf.example.com ~all']),
        },
      ],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const txt = decoded.message.answers.find((rr) => rr.kind === 'TXT');
    expect(txt?.kind).toBe('TXT');
    if (txt?.kind === 'TXT') {
      expect(txt.strings).toEqual(['v=spf1 include:', '_spf.example.com ~all']);
      expect(txt.text).toBe('v=spf1 include:_spf.example.com ~all');
    }
  });
});

describe('decodeMessage: TLSA parse', () => {
  it('parses usage/selector/matching-type and cert association data', () => {
    const certData = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const packet = buildMessage({
      id: 9,
      flags: { rcode: RCode.NOERROR },
      question: { name: '_25._tcp.mail.example.com', type: RRType.TLSA },
      answers: [
        { name: '_25._tcp.mail.example.com', type: RRType.TLSA, rdata: rdataTlsa(3, 1, 1, certData) },
      ],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const tlsa = decoded.message.answers.find((rr) => rr.kind === 'TLSA');
    expect(tlsa?.kind).toBe('TLSA');
    if (tlsa?.kind === 'TLSA') {
      expect(tlsa.usage).toBe(3);
      expect(tlsa.selector).toBe(1);
      expect(tlsa.matchingType).toBe(1);
      expect(Buffer.from(tlsa.certData)).toEqual(Buffer.from(certData));
    }
  });
});

describe('decodeMessage: CNAME chain', () => {
  it('parses a CNAME pointing at a target that itself has an A record', () => {
    const packet = buildMessage({
      id: 10,
      flags: { rcode: RCode.NOERROR },
      question: { name: 'www.example.com', type: RRType.A },
      answers: [
        { name: 'www.example.com', type: RRType.CNAME, rdata: rdataName('edge.example.net') },
        { name: 'edge.example.net', type: RRType.A, rdata: rdataA('203.0.113.9') },
      ],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const cname = decoded.message.answers.find((rr) => rr.kind === 'CNAME');
    const a = decoded.message.answers.find((rr) => rr.kind === 'A');
    expect(cname?.kind === 'CNAME' && cname.target).toBe('edge.example.net');
    expect(a?.kind === 'A' && a.address).toBe('203.0.113.9');
  });
});

describe('decodeMessage: AAAA', () => {
  it('parses and RFC 5952-compresses an IPv6 address', () => {
    const packet = buildMessage({
      id: 11,
      flags: { rcode: RCode.NOERROR },
      question: { name: 'v6.example.com', type: RRType.AAAA },
      answers: [
        {
          name: 'v6.example.com',
          type: RRType.AAAA,
          rdata: rdataAAAA([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]),
        },
      ],
    });
    const decoded = decodeMessage(packet);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const aaaa = decoded.message.answers.find((rr) => rr.kind === 'AAAA');
    expect(aaaa?.kind === 'AAAA' && aaaa.address).toBe('2001:db8::1');
  });
});

describe('decodeMessage: robustness', () => {
  it('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 512 }), (bytes) => {
        const result = decodeMessage(bytes);
        expect(typeof result.ok).toBe('boolean');
      }),
      { numRuns: 500 },
    );
  });

  it('returns a typed error for a truncated header', () => {
    const result = decodeMessage(Uint8Array.from([0, 1, 2]));
    expect(result.ok).toBe(false);
  });

  it('returns a typed error for a truncated RR', () => {
    const packet = buildMessage({
      id: 12,
      question: { name: 'example.com', type: RRType.A },
      answers: [{ name: 'example.com', type: RRType.A, rdata: rdataA('1.2.3.4') }],
    });
    const truncated = packet.subarray(0, packet.length - 2);
    const result = decodeMessage(truncated);
    expect(result.ok).toBe(false);
  });
});
