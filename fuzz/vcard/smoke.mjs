#!/usr/bin/env node
// Fuzz smoke for @postroom/vcard (PST-T-8.1 / PST-REQ-088): a short, seeded fast-check burst of
// arbitrary bytes and vCard-shaped text (corpus lines, tokens, noise, assorted line breaks)
// through fuzz/vcard/target.mjs's own fuzz(), so the smoke run, the fixture replay and the nightly
// jazzer run all check one set of invariants. Exits non-zero on any failure. Seed: FUZZ_SEED (CI
// pins 424242). A crasher becomes a regression fixture in fuzz/vcard/fixtures before it is fixed.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';

const { fuzz } = await import('./target.mjs');

const seed = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const started = Date.now();
const corpusDir = join(import.meta.dirname, 'corpus');
const files = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.vcf'))
  .map((f) => readFileSync(join(corpusDir, f), 'utf8').split(/\r\n|\n/).filter((l) => l !== ''));
const lines = files.flat();

const token = fc.constantFrom('BEGIN:VCARD', 'END:VCARD', 'VERSION:3.0', 'item1.EMAIL;type=pref:a@example.com', 'item1.X-ABLabel:_$!<Other>!$_', 'NOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=utf-8:caf=C3=A9=', 'PHOTO;ENCODING=b;TYPE=JPEG:/9j/', 'PHOTO:data:image/png;base64,iVBORw0KGgo=', 'TEL;WORK;VOICE:1', 'N:a\\;b;c,d;;', ' ', '=', ';', ':', ',', '"', '^n');
const shaped = fc
  .array(fc.oneof({ weight: 5, arbitrary: fc.constantFrom(...lines) }, { weight: 2, arbitrary: token }, { weight: 1, arbitrary: fc.string({ maxLength: 20 }) }), { maxLength: 80 })
  .chain((parts) => fc.array(fc.constantFrom('\r\n', '\n', '\r', '\r\n ', ''), { minLength: parts.length, maxLength: parts.length }).map((seps) => parts.map((p, i) => p + (seps[i] ?? '')).join('')))
  .map((s) => Buffer.from(s, 'utf8'));
// A whole corpus file with a few lines inserted, replaced or deleted: most of these still parse,
// so the round-trip and the helpers see real structure, not just the parser's error paths.
const mutated = fc
  .tuple(
    fc.constantFrom(...files),
    fc.array(fc.tuple(fc.nat(), fc.constantFrom('insert', 'replace', 'delete'), fc.oneof(token, fc.constantFrom(...lines), fc.string({ maxLength: 20 }))), { maxLength: 6 }),
  )
  .map(([file, edits]) => {
    const out = [...file];
    for (const [at, op, text] of edits) {
      const i = at % (out.length + 1);
      if (op === 'insert') out.splice(i, 0, text);
      else if (op === 'replace' && i < out.length) out[i] = text;
      else if (op === 'delete' && i < out.length) out.splice(i, 1);
    }
    return Buffer.from(out.join('\r\n') + '\r\n', 'utf8');
  });
const input = fc.oneof({ weight: 3, arbitrary: mutated }, { weight: 2, arbitrary: shaped }, { weight: 1, arbitrary: fc.uint8Array({ maxLength: 800 }).map((b) => Buffer.from(b)) });

let runs = 0;
try {
  fc.assert(
    fc.property(input, (data) => {
      runs++;
      fuzz(data);
    }),
    { numRuns: 1500, seed },
  );
} catch (err) {
  console.error(`fuzz/vcard/smoke: FAILED after ${String(runs)} runs (seed=${String(seed)})`);
  console.error(err);
  process.exit(1);
}

console.log(`fuzz/vcard/smoke: ok (${String(runs)} runs, seed=${String(seed)}, ${String(Date.now() - started)} ms)`);
process.exit(0);
