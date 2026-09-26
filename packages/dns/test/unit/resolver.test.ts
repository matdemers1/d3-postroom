import { describe, expect, it } from 'vitest';
import { responseMatchesQuery, reverseDnsName } from '../../src/resolver.js';
import { RRType } from '../../src/types.js';
import type { DnsMessage } from '../../src/types.js';

function baseMessage(overrides: Partial<DnsMessage> = {}): DnsMessage {
  return {
    id: 42,
    qr: true,
    opcode: 0,
    aa: false,
    tc: false,
    rd: true,
    ra: true,
    ad: false,
    cd: false,
    rcode: 0,
    questions: [{ name: 'example.com', type: RRType.A, class: 1 }],
    answers: [],
    authority: [],
    additional: [],
    ...overrides,
  };
}

describe('responseMatchesQuery: anti-spoofing (id/question echo)', () => {
  it('accepts a response whose id and question match', () => {
    expect(responseMatchesQuery(baseMessage(), 42, 'example.com', RRType.A)).toBe(true);
  });

  it('drops a response with a mismatched id (spoofed or stray reply)', () => {
    expect(responseMatchesQuery(baseMessage({ id: 99 }), 42, 'example.com', RRType.A)).toBe(false);
  });

  it('drops a response whose question name does not match', () => {
    const msg = baseMessage({ questions: [{ name: 'evil.example.com', type: RRType.A, class: 1 }] });
    expect(responseMatchesQuery(msg, 42, 'example.com', RRType.A)).toBe(false);
  });

  it('drops a response whose question type does not match', () => {
    const msg = baseMessage({ questions: [{ name: 'example.com', type: RRType.MX, class: 1 }] });
    expect(responseMatchesQuery(msg, 42, 'example.com', RRType.A)).toBe(false);
  });

  it('drops a response with no question section', () => {
    expect(responseMatchesQuery(baseMessage({ questions: [] }), 42, 'example.com', RRType.A)).toBe(false);
  });

  it('drops a message that is not actually a response (QR=0)', () => {
    expect(responseMatchesQuery(baseMessage({ qr: false }), 42, 'example.com', RRType.A)).toBe(false);
  });

  it('is case- and trailing-dot-insensitive on the question name', () => {
    const msg = baseMessage({ questions: [{ name: 'Example.COM.', type: RRType.A, class: 1 }] });
    expect(responseMatchesQuery(msg, 42, 'example.com', RRType.A)).toBe(true);
  });
});

describe('reverseDnsName', () => {
  it('builds the in-addr.arpa name for IPv4', () => {
    expect(reverseDnsName('192.0.2.1')).toBe('1.2.0.192.in-addr.arpa.');
  });

  it('builds the ip6.arpa name for IPv6', () => {
    expect(reverseDnsName('2001:db8::1')).toBe(
      '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa.',
    );
  });
});
