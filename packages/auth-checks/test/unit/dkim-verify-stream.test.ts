import { generateKeyPairSync } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BodyHasher,
  createDkimVerifier,
  createDkimVerifierStream,
  dnsRecordFor,
  type DkimResult,
} from '../../src/index.js';
import { fakeDns, forgeSignature } from './fixtures/dkim/forge.js';
import { DNS_BRISBANE, DNS_TEST, SIGNED } from './fixtures/rfc8463.js';

const NOW = new Date('2026-09-25T12:00:00Z');
const ed = generateKeyPairSync('ed25519');
const edTxt = dnsRecordFor('ed25519-sha256', ed.publicKey);

const dns = fakeDns({
  'brisbane._domainkey.football.example.com': DNS_BRISBANE,
  'test._domainkey.football.example.com': DNS_TEST,
  'r._domainkey.example.org': edTxt,
  's._domainkey.example.org': edTxt,
  'l._domainkey.example.org': edTxt,
});

// Signatures with every body canonicalization and an l=, on a body with trailing whitespace and
// blank lines — the bytes where a chunk boundary is most likely to matter.
const BASE = [
  'From: Dana <dana@example.org>',
  'To: matt@d3cloud.io',
  'Subject: chunk  boundaries\t',
  '',
  'line one \t ',
  '',
  '  indented\r',
  'trailing blanks follow',
  '',
  '',
  '',
].join('\r\n');
const H = ['from', 'to', 'subject'];
const sign = (canon: 'relaxed/relaxed' | 'simple/simple', selector: string, length?: number): string =>
  forgeSignature(BASE, {
    key: ed.privateKey,
    algorithm: 'ed25519-sha256',
    domain: 'example.org',
    selector,
    canon,
    headers: H,
    ...(length === undefined ? {} : { length }),
  });
const MULTI = sign('relaxed/relaxed', 'r') + sign('simple/simple', 's') + sign('relaxed/relaxed', 'l', 12) + BASE;

const MESSAGES = [
  Buffer.from(SIGNED, 'latin1'),
  Buffer.from(MULTI, 'latin1'),
  Buffer.from(MULTI.replace('indented', 'indenTed'), 'latin1'), // body hash mismatch after l=12
  Buffer.from(SIGNED.replace('lost', 'won!'), 'latin1'),
];

function chunk(buf: Buffer, cuts: readonly number[]): Buffer[] {
  const points = [...new Set(cuts.map((c) => c % (buf.length + 1)))].sort((a, b) => a - b);
  const out: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    out.push(buf.subarray(prev, p));
    prev = p;
  }
  out.push(buf.subarray(prev));
  return out;
}

const verifier = createDkimVerifier({ dns, now: NOW });

describe('streaming equals whole-buffer verification', () => {
  it('sanity: the fixtures produce a mix of outcomes', async () => {
    const all = await Promise.all(MESSAGES.map((m) => verifier.verifyStream(m)));
    expect(all.map((rs) => rs.map((r) => r.result))).toEqual([
      ['pass', 'pass'],
      ['pass', 'pass', 'pass'],
      ['fail', 'fail', 'pass'], // l=12 covers only "line one" and a blank line: the edit is unsigned
      ['fail', 'fail'],
    ]);
  });

  it('fast-check: any chunking gives the same results as the whole buffer (iterator and Transform)', async () => {
    const expected = await Promise.all(MESSAGES.map((m) => verifier.verifyStream(m)));
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: MESSAGES.length - 1 }),
        fc.array(fc.nat(), { maxLength: 60 }),
        fc.boolean(),
        async (which, cuts, viaTransform) => {
          const msg = MESSAGES[which] ?? Buffer.alloc(0);
          const chunks = chunk(msg, cuts);
          let got: DkimResult[];
          if (viaTransform) {
            const v = createDkimVerifierStream({ dns, now: NOW });
            const out: Buffer[] = [];
            await pipeline(Readable.from(chunks), v, collect(out));
            expect(Buffer.concat(out).equals(msg)).toBe(true);
            got = await v.results();
          } else {
            got = await verifier.verifyStream(Readable.from(chunks));
          }
          expect(got).toEqual(expected[which]);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('one-byte chunks match too', async () => {
    for (const m of MESSAGES) {
      const bytes = Array.from({ length: m.length }, (_, i) => m.subarray(i, i + 1));
      expect(await verifier.verifyStream(Readable.from(bytes))).toEqual(await verifier.verifyStream(m));
    }
  });
});

describe('bounded memory', () => {
  it('verifies a 50 MB body without retaining it', async () => {
    const TOTAL = 50 * 1024 * 1024;
    const line = Buffer.from('The quick brown fox jumps over the lazy dog.  0123456789 \t\r\n', 'latin1');
    const CHUNK = 64 * 1024;
    const block = Buffer.alloc(CHUNK);
    for (let i = 0; i < CHUNK; i++) block[i] = line[i % line.length] ?? 0x20;
    // One reused buffer: the source itself allocates nothing per chunk.
    function* body(): Generator<Buffer> {
      for (let sent = 0; sent < TOTAL; sent += CHUNK) yield block.subarray(0, Math.min(CHUNK, TOTAL - sent));
    }
    const hasher = new BodyHasher('relaxed');
    for (const c of body()) hasher.update(c);
    const bh = hasher.digest().toString('base64');

    const head = ['From: Big <big@example.org>', 'To: matt@d3cloud.io', 'Subject: large', '', ''].join('\r\n');
    const sig = forgeSignature(head, {
      key: ed.privateKey,
      algorithm: 'ed25519-sha256',
      domain: 'example.org',
      selector: 'r',
      headers: H,
      bodyHash: bh,
    });
    function* message(): Generator<Buffer> {
      yield Buffer.from(sig + head, 'latin1');
      yield* body();
    }

    const before = process.memoryUsage().arrayBuffers;
    const v = createDkimVerifierStream({ dns, now: NOW });
    let passed = 0;
    await pipeline(
      Readable.from(message()),
      v,
      new Writable({
        write(c: Buffer, _enc, cb): void {
          passed += c.length;
          cb();
        },
      }),
    );
    const rs = await v.results();
    const grown = process.memoryUsage().arrayBuffers - before;

    expect(rs.map((r) => r.result)).toEqual(['pass']);
    const stats = v.stats();
    expect(stats.bodyBytes).toBe(TOTAL);
    expect(passed).toBe(TOTAL + stats.headerBytes);
    // The verifier held at most the header block, never the body.
    expect(stats.maxRetainedBytes).toBeLessThan(4096);
    expect(grown).toBeLessThan(8 * 1024 * 1024);
  }, 120_000);
});

function collect(out: Buffer[]): Writable {
  return new Writable({
    write(c: Buffer, _enc, cb): void {
      out.push(Buffer.from(c));
      cb();
    },
  });
}
