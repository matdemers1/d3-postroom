#!/usr/bin/env node
// Fuzz smoke for @postroom/pgp (PST-T-12.1): a short, seeded fast-check burst of arbitrary bytes,
// of OpenPGP-packet-shaped and DER-shaped bytes, and of single-byte mutations of the real corpus
// (keys, signatures, encrypted messages, CMS SignedData/EnvelopedData, certificates) through every
// reader (see target.mjs), then whole messages with mutated bytes through analyzeMessage, which must
// always resolve to a report. Seed: FUZZ_SEED (CI pins 424242).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { exercise } from './target.mjs';

const pkg = join(import.meta.dirname, '..', '..', 'packages', 'pgp');
const { analyzeMessage, encodePacket, encodeTlv } = await import(join(pkg, 'dist', 'index.js'));

const seed = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const started = Date.now();
const corpusDir = join(import.meta.dirname, 'corpus');
const corpus = readdirSync(corpusDir).map((f) => readFileSync(join(corpusDir, f)));
const emlDir = join(pkg, 'test', 'fixtures');
const emls = readdirSync(emlDir).filter((f) => f.endsWith('.eml')).map((f) => readFileSync(join(emlDir, f)));

const packetish = fc.array(fc.tuple(fc.integer({ min: 0, max: 63 }), fc.uint8Array({ maxLength: 80 })), { maxLength: 6 })
  .map((ps) => Buffer.concat(ps.map(([t, b]) => encodePacket(t, b))));
const derish = fc.array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.boolean(), fc.integer({ min: 0, max: 40 }), fc.uint8Array({ maxLength: 60 })), { maxLength: 6 })
  .map((ts) => ts.reduce((acc, [c, k, t, v]) => encodeTlv(c, k, t, Buffer.concat([acc, Buffer.from(v)])), Buffer.alloc(0)));
const mutated = (pool) => fc.tuple(fc.constantFrom(...pool), fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 6 }), fc.option(fc.nat(), { nil: undefined }))
  .map(([base, edits, cut]) => {
    const b = Buffer.from(base);
    for (const [at, v] of edits) if (b.length > 0) b[at % b.length] = v;
    return cut === undefined || b.length === 0 ? b : b.subarray(0, cut % b.length);
  });

let runs = 0;
try {
  fc.assert(
    fc.property(fc.oneof(fc.uint8Array({ maxLength: 1500 }).map((b) => Buffer.from(b)), packetish, derish, mutated(corpus)), (bytes) => {
      runs++;
      exercise(bytes);
    }),
    { numRuns: 2500, seed },
  );
  await fc.assert(
    fc.asyncProperty(mutated(emls), fc.integer({ min: 1, max: 700 }), async (eml, size) => {
      runs++;
      const chunks = [];
      for (let i = 0; i < eml.length; i += size) chunks.push(eml.subarray(i, i + size));
      const r = await analyzeMessage(chunks, []);
      if (typeof r.signature.status !== 'string' || typeof r.encryption.status !== 'string') throw new Error('no report');
      // Total, and not by accident: a bug caught by the last-resort handler is still a bug.
      if (r.signature.status === 'unsupported:internal-error' || r.encryption.status === 'failed:internal-error') throw new Error(`internal error: ${r.signature.reasons.join('; ')}${r.encryption.reasons.join('; ')}`);
    }),
    { numRuns: 300, seed },
  );
} catch (err) {
  console.error(`fuzz/pgp/smoke: FAILED after ${String(runs)} runs (seed=${String(seed)})`);
  console.error(err);
  process.exit(1);
}

console.log(`fuzz/pgp/smoke: ok (${String(runs)} runs, seed=${String(seed)}, ${String(Date.now() - started)} ms)`);
process.exit(0);
