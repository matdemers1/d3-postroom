// PST-T-0.15: the node:dns side of the challenge against a tiny UDP DNS server on 127.0.0.1 —
// CNAME following, NS → A for the zone's authoritative servers, and TXT asked of one server
// directly. The server answers from a table; nothing leaves the host.
import { createSocket, type Socket } from 'node:dgram';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeChallengeDns, resolveChallengeTarget, waitForTxt } from '../../../src/acme/dns.js';

type Rr = { type: 1; ip: string } | { type: 2 | 5; name: string } | { type: 16; text: string };

const TABLE = new Map<string, Rr[]>([
  ['_acme-challenge.mx.d3cloud.io', [{ type: 5, name: 'mx.d3cloud.io.bigfluffymurderbuffalo.com' }]],
  ['bigfluffymurderbuffalo.com', [{ type: 2, name: 'ns1.fake.test' }, { type: 2, name: 'ns2.fake.test' }]],
  ['ns1.fake.test', [{ type: 1, ip: '127.0.0.1' }]],
  ['ns2.fake.test', [{ type: 1, ip: '127.0.0.1' }]],
  ['mx.d3cloud.io.bigfluffymurderbuffalo.com', [{ type: 16, text: 'the-value' }]],
]);

function encodeName(name: string): Buffer {
  return Buffer.concat([...name.split('.').filter((l) => l !== '').map((l) => Buffer.concat([Buffer.of(l.length), Buffer.from(l, 'ascii')])), Buffer.of(0)]);
}

function readQuestion(msg: Buffer): { name: string; type: number; end: number } {
  const labels: string[] = [];
  let off = 12;
  for (let len = msg[off] ?? 0; len !== 0; len = msg[off] ?? 0) {
    labels.push(msg.subarray(off + 1, off + 1 + len).toString('ascii'));
    off += len + 1;
  }
  return { name: labels.join('.').toLowerCase(), type: msg.readUInt16BE(off + 1), end: off + 5 };
}

function answer(query: Buffer): Buffer {
  const q = readQuestion(query);
  const rrs = (TABLE.get(q.name) ?? []).filter((r) => r.type === q.type);
  const known = TABLE.has(q.name);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8400 | (known ? 0 : 3), 2); // QR, AA, NOERROR / NXDOMAIN
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(rrs.length, 6);
  const answers = rrs.map((r) => {
    const rdata = r.type === 1 ? Buffer.from(r.ip.split('.').map(Number)) : r.type === 16 ? Buffer.concat([Buffer.of(r.text.length), Buffer.from(r.text)]) : encodeName(r.name);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(r.type, 0);
    fixed.writeUInt16BE(1, 2);
    fixed.writeUInt32BE(60, 4);
    fixed.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([Buffer.of(0xc0, 0x0c), fixed, rdata]);
  });
  return Buffer.concat([header, query.subarray(12, q.end), ...answers]);
}

let server: Socket;
let port = 0;

beforeAll(async () => {
  server = createSocket('udp4');
  server.on('message', (msg, rinfo) => {
    server.send(answer(msg), rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => {
    server.bind(0, '127.0.0.1', () => {
      resolve();
    });
  });
  port = server.address().port;
});

afterAll(() => {
  server.close();
});

describe('node:dns challenge lookups (PST-T-0.15)', () => {
  it('follows the delegation CNAME into the challenge zone', async () => {
    const dns = nodeChallengeDns({ resolver: `127.0.0.1:${String(port)}` });
    expect(await dns.cname('_acme-challenge.mx.d3cloud.io')).toBe('mx.d3cloud.io.bigfluffymurderbuffalo.com');
    expect(await dns.cname('nothing.d3cloud.io')).toBeNull();
    expect(await resolveChallengeTarget(dns, 'mx.d3cloud.io', 'bigfluffymurderbuffalo.com')).toBe('mx.d3cloud.io.bigfluffymurderbuffalo.com');
  });

  it('finds the authoritative servers and reads the TXT from them directly', async () => {
    const dns = nodeChallengeDns({ resolver: `127.0.0.1:${String(port)}` });
    expect(await dns.authoritativeServers('bigfluffymurderbuffalo.com')).toEqual(['127.0.0.1']);
    expect(await dns.txtAt(`127.0.0.1:${String(port)}`, 'mx.d3cloud.io.bigfluffymurderbuffalo.com')).toEqual(['the-value']);
    expect(await dns.txtAt(`127.0.0.1:${String(port)}`, 'absent.bigfluffymurderbuffalo.com')).toEqual([]);
  });

  it('waitForTxt returns once every server serves the value', async () => {
    const base = nodeChallengeDns({ resolver: `127.0.0.1:${String(port)}` });
    // Authoritative servers are on :53 in the real world; point the fake's port at our server.
    const dns = { ...base, txtAt: (_s: string, n: string) => base.txtAt(`127.0.0.1:${String(port)}`, n) };
    const seen = await waitForTxt(dns, { zone: 'bigfluffymurderbuffalo.com', name: 'mx.d3cloud.io.bigfluffymurderbuffalo.com', value: 'the-value', timeoutMs: 5_000, intervalMs: 10, sleep: () => Promise.resolve(), now: Date.now });
    expect(seen).toEqual({ servers: 1, checks: 1 });
  });
});
