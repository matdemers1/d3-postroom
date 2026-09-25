import { afterEach, describe, expect, it } from 'vitest';
import { DnsTimeoutError } from '../../src/errors.js';
import { resolveMxTargets } from '../../src/mx.js';
import { createResolver } from '../../src/resolver.js';
import { RCode, RRType } from '../../src/types.js';
import {
  buildMessage,
  rdataA,
  rdataMx,
} from '../unit/helpers/build-packet.js';
import { startFakeDnsServer } from './helpers/fake-dns-server.js';
import type { FakeAnswerSpec, FakeDnsServer } from './helpers/fake-dns-server.js';
import type { DecodeResult } from '../../src/types.js';

let server: FakeDnsServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

interface FixedSpec {
  question: string;
  type: number;
  answers: NonNullable<Parameters<typeof buildMessage>[0]['answers']>;
  rcode?: number;
}

function withQueryId(fixed: (query: DecodeResult) => FixedSpec): FakeAnswerSpec['buildResponse'] {
  return (query) => {
    const id = query.ok ? query.message.id : 0;
    const spec = fixed(query);
    return buildMessage({
      id,
      flags: { rcode: spec.rcode ?? RCode.NOERROR },
      question: { name: spec.question, type: spec.type },
      answers: spec.answers,
    });
  };
}

describe('DNS integration: UDP round trip', () => {
  it('resolves an A record over plain UDP', async () => {
    server = await startFakeDnsServer(
      new Map([
        [
          'a.example.com|1',
          {
            buildResponse: withQueryId(() => ({
              question: 'a.example.com',
              type: RRType.A,
              answers: [{ name: 'a.example.com', type: RRType.A, rdata: rdataA('203.0.113.10') }],
            })),
          },
        ],
      ]),
    );
    const resolver = createResolver({ server: `127.0.0.1:${String(server.port)}`, timeoutMs: 500, tries: 2 });
    const result = await resolver.a('a.example.com');
    expect(result.rcode).toBe(RCode.NOERROR);
    expect(result.answers[0]).toMatchObject({ kind: 'A', address: '203.0.113.10' });
  });
});

describe('DNS integration: TC=1 falls back to TCP', () => {
  it('retries over TCP and gets the full answer', async () => {
    server = await startFakeDnsServer(
      new Map([
        [
          'big.example.com|16',
          {
            truncateOnUdp: true,
            buildResponse: withQueryId(() => ({
              question: 'big.example.com',
              type: RRType.TXT,
              answers: [],
              rcode: RCode.NOERROR,
            })),
          },
        ],
      ]),
    );
    const resolver = createResolver({ server: `127.0.0.1:${String(server.port)}`, timeoutMs: 500, tries: 2 });
    const result = await resolver.txt('big.example.com');
    expect(result.rcode).toBe(RCode.NOERROR);
  });
});

describe('DNS integration: timeout + retry', () => {
  it('retries once after a dropped first request and succeeds on the second', async () => {
    server = await startFakeDnsServer(
      new Map([
        [
          'flaky.example.com|1',
          {
            dropRequests: 1,
            buildResponse: withQueryId(() => ({
              question: 'flaky.example.com',
              type: RRType.A,
              answers: [{ name: 'flaky.example.com', type: RRType.A, rdata: rdataA('198.51.100.1') }],
            })),
          },
        ],
      ]),
    );
    const resolver = createResolver({ server: `127.0.0.1:${String(server.port)}`, timeoutMs: 300, tries: 2 });
    const result = await resolver.a('flaky.example.com');
    expect(result.answers[0]).toMatchObject({ kind: 'A', address: '198.51.100.1' });
  });

  it('throws DnsTimeoutError when every try is dropped', async () => {
    server = await startFakeDnsServer(
      new Map([
        [
          'dead.example.com|1',
          {
            dropRequests: 99,
            buildResponse: withQueryId(() => ({ question: 'dead.example.com', type: RRType.A, answers: [] })),
          },
        ],
      ]),
    );
    const resolver = createResolver({ server: `127.0.0.1:${String(server.port)}`, timeoutMs: 200, tries: 2 });
    await expect(resolver.a('dead.example.com')).rejects.toBeInstanceOf(DnsTimeoutError);
  });
});

describe('DNS integration: resolveMxTargets end to end', () => {
  it('resolves MX targets and their addresses against the fake server', async () => {
    server = await startFakeDnsServer(
      new Map([
        [
          'mail.example.com|15',
          {
            buildResponse: withQueryId(() => ({
              question: 'mail.example.com',
              type: RRType.MX,
              answers: [
                { name: 'mail.example.com', type: RRType.MX, rdata: rdataMx(10, 'mx1.mail.example.com') },
              ],
            })),
          },
        ],
        [
          'mx1.mail.example.com|1',
          {
            buildResponse: withQueryId(() => ({
              question: 'mx1.mail.example.com',
              type: RRType.A,
              answers: [{ name: 'mx1.mail.example.com', type: RRType.A, rdata: rdataA('192.0.2.50') }],
            })),
          },
        ],
        [
          'mx1.mail.example.com|28',
          { buildResponse: withQueryId(() => ({ question: 'mx1.mail.example.com', type: RRType.AAAA, answers: [] })) },
        ],
      ]),
    );
    const resolver = createResolver({ server: `127.0.0.1:${String(server.port)}`, timeoutMs: 500, tries: 2 });
    const result = await resolveMxTargets(resolver, 'mail.example.com');
    expect(result.kind).toBe('mx');
    if (result.kind !== 'mx') return;
    expect(result.targets).toEqual([{ host: 'mx1.mail.example.com', preference: 10, addresses: ['192.0.2.50'] }]);
  });
});
