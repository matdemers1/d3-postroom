#!/usr/bin/env node
// Fuzz smoke for @postroom/ical (PST-T-8.1 / PST-REQ-088): a short, seeded fast-check burst of
// arbitrary bytes and iCalendar-shaped text (corpus lines, tokens, noise, assorted line breaks)
// through fuzz/ical/target.mjs's own fuzz(), so the smoke run, the fixture replay and the nightly
// jazzer run all check one set of invariants. Exits non-zero on any failure. Seed: FUZZ_SEED (CI
// pins 424242). A crasher becomes a regression fixture in fuzz/ical/fixtures before it is fixed.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';

const { fuzz } = await import('./target.mjs');

const seed = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const started = Date.now();
const corpusDir = join(import.meta.dirname, 'corpus');
const files = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.ics'))
  .map((f) => readFileSync(join(corpusDir, f), 'utf8').split(/\r\n|\n/).filter((l) => l !== ''));
const lines = files.flat();

const token = fc.constantFrom('BEGIN:VCALENDAR', 'END:VCALENDAR', 'BEGIN:VEVENT', 'END:VEVENT', 'BEGIN:VTIMEZONE', 'RRULE:FREQ=SECONDLY;BYSETPOS=-1', 'RRULE:FREQ=YEARLY;BYWEEKNO=-1;BYDAY=-1SU', 'EXDATE;VALUE=DATE:20260101', 'RDATE;VALUE=PERIOD:20260101T000000Z/PT1H', 'RECURRENCE-ID;TZID=Europe/Berlin:20260330T100000', 'DTSTART;TZID=Nowhere/Zone:20260308T023000', 'DURATION:-P1W', 'TZOFFSETFROM:+2359', ' ', '\t', ';', ':', ',', '"', '^n', '\\\\');
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
// The target reads its range and cap from the last 10 bytes (FuzzedDataProvider: 5 + 4 + 1), so
// append exactly that many and the body reaches the parser intact.
const input = fc
  .tuple(
    fc.oneof({ weight: 3, arbitrary: mutated }, { weight: 2, arbitrary: shaped }, { weight: 1, arbitrary: fc.uint8Array({ maxLength: 800 }).map((b) => Buffer.from(b)) }),
    fc.uint8Array({ minLength: 10, maxLength: 10 }),
  )
  .map(([body, tail]) => Buffer.concat([body, Buffer.from(tail)]));

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
  console.error(`fuzz/ical/smoke: FAILED after ${String(runs)} runs (seed=${String(seed)})`);
  console.error(err);
  process.exit(1);
}

console.log(`fuzz/ical/smoke: ok (${String(runs)} runs, seed=${String(seed)}, ${String(Date.now() - started)} ms)`);
process.exit(0);
