#!/usr/bin/env node
// Fuzz smoke for @postroom/dsn's report readers (PST-T-11.15 / PST-REQ-088): a short, seeded
// fast-check burst of arbitrary bytes, DSN/ARF-shaped field lines and corpus reports with edits,
// through fuzz/dsn-report/target.mjs's own fuzz(), so the smoke run, the fixture replay and the
// nightly jazzer run all check one set of invariants. Exits non-zero on any failure. Seed:
// FUZZ_SEED (CI pins 424242). A crasher becomes a regression fixture in fuzz/dsn-report/fixtures.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';

const { fuzz } = await import('./target.mjs');

const seed = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const started = Date.now();
const corpusDir = join(import.meta.dirname, 'corpus');
const docs = readdirSync(corpusDir).map((f) => readFileSync(join(corpusDir, f)));

const token = fc.constantFrom('Final-Recipient: ', 'rfc822; ', 'Action: failed', 'Status: ', '5.1.1', '9.99.999', '5.1', 'Diagnostic-Code: smtp; ', '550-5.1.1 ', 'Feedback-Type: abuse', 'Original-Rcpt-To: <a@b>', 'Incidents: 99999999999', '<', '>', ';', ':', '\r\n', '\n', '\r', '\r\n\r\n', ' ', '\t', 'ÿ', '+2D');
const shaped = fc.array(fc.oneof({ weight: 3, arbitrary: token }, { weight: 1, arbitrary: fc.string({ maxLength: 8 }) }), { maxLength: 80 }).map((p) => Buffer.from(p.join(''), 'utf8'));
const mutated = fc
  .tuple(fc.constantFrom(...docs), fc.array(fc.tuple(fc.nat(), fc.nat({ max: 8 }), fc.uint8Array({ maxLength: 6 })), { maxLength: 4 }))
  .map(([doc, edits]) => {
    let out = Buffer.from(doc);
    for (const [at, len, bytes] of edits) {
      const i = at % (out.length + 1);
      out = Buffer.concat([out.subarray(0, i), Buffer.from(bytes), out.subarray(i + len)]);
    }
    return out;
  });
const body = fc.oneof({ weight: 4, arbitrary: mutated }, { weight: 2, arbitrary: shaped }, { weight: 1, arbitrary: fc.uint8Array({ maxLength: 600 }).map((b) => Buffer.from(b)) });
const input = fc.tuple(fc.nat({ max: 255 }), body).map(([g, b]) => Buffer.concat([Buffer.from([g]), b]));

let runs = 0;
try {
  for (const doc of docs) for (let g = 0; g < 2; g++) fuzz(Buffer.concat([Buffer.from([g]), doc]));
  // One long input, so the size cap is exercised on every run of the smoke.
  fuzz(Buffer.concat([Buffer.from([0]), Buffer.from('Final-Recipient: rfc822; a@b\nAction: failed\nStatus: 5.1.1\n\n'.repeat(3000))]));
  fc.assert(
    fc.property(input, (data) => {
      runs++;
      fuzz(data);
    }),
    { numRuns: 2000, seed },
  );
} catch (err) {
  console.error(`fuzz/dsn-report/smoke: FAILED after ${String(runs)} runs (seed=${String(seed)})`);
  console.error(err);
  process.exit(1);
}

console.log(`fuzz/dsn-report/smoke: ok (${String(runs)} runs, seed=${String(seed)}, ${String(Date.now() - started)} ms)`);
process.exit(0);
