#!/usr/bin/env node
// Fuzz smoke for @postroom/dav-proto (PST-T-8.2 / PST-REQ-088): a short, seeded fast-check burst of
// arbitrary bytes and DAV-shaped XML (corpus documents with edits, markup tokens, XXE attempts)
// through fuzz/dav-proto/target.mjs's own fuzz(), so the smoke run, the fixture replay and the
// nightly jazzer run all check one set of invariants. Exits non-zero on any failure. Seed:
// FUZZ_SEED (CI pins 424242). A crasher becomes a regression fixture in fuzz/dav-proto/fixtures.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';

const { fuzz } = await import('./target.mjs');

const seed = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const started = Date.now();
const corpusDir = join(import.meta.dirname, 'corpus');
const docs = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.xml'))
  .map((f) => readFileSync(join(corpusDir, f), 'utf8'));

const token = fc.constantFrom('<', '>', '</', '/>', '<?xml version="1.0"?>', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>', '&e;', '<!ENTITY', '<![CDATA[', ']]>', '<!--', '-->', '&amp;', '&#13;', '&#x0;', 'xmlns:D="DAV:"', 'xmlns=""', 'D:', 'C:', '<D:prop>', '</D:prop>', '<D:href>', '<C:comp-filter name="VEVENT">', '<C:time-range start="20260101T000000Z"/>', '<C:text-match collation="i;octet">', '"', "'", ' ', '\r\n', '﻿', '%2F', '/../', 'W/"x", "y"', '*');
const shaped = fc.array(fc.oneof({ weight: 3, arbitrary: token }, { weight: 1, arbitrary: fc.string({ maxLength: 10 }) }), { maxLength: 60 }).map((p) => Buffer.from(p.join(''), 'utf8'));
// A whole corpus document with a few slices inserted, replaced or deleted: most still parse, so the
// request parsers see real structure, not only the XML parser's error paths.
const mutated = fc
  .tuple(fc.constantFrom(...docs), fc.array(fc.tuple(fc.nat(), fc.nat({ max: 12 }), fc.oneof(token, fc.string({ maxLength: 8 }))), { maxLength: 5 }))
  .map(([doc, edits]) => {
    let out = doc;
    for (const [at, len, text] of edits) {
      const i = at % (out.length + 1);
      out = out.slice(0, i) + text + out.slice(i + len);
    }
    return Buffer.from(out, 'utf8');
  });
const input = fc.oneof({ weight: 4, arbitrary: mutated }, { weight: 2, arbitrary: shaped }, { weight: 1, arbitrary: fc.uint8Array({ maxLength: 600 }).map((b) => Buffer.from(b)) });

let runs = 0;
try {
  fc.assert(
    fc.property(input, (data) => {
      runs++;
      fuzz(data);
    }),
    { numRuns: 2000, seed },
  );
} catch (err) {
  console.error(`fuzz/dav-proto/smoke: FAILED after ${String(runs)} runs (seed=${String(seed)})`);
  console.error(err);
  process.exit(1);
}

console.log(`fuzz/dav-proto/smoke: ok (${String(runs)} runs, seed=${String(seed)}, ${String(Date.now() - started)} ms)`);
process.exit(0);
