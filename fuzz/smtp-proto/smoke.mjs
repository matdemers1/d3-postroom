#!/usr/bin/env node
// Fuzz smoke for @postroom/smtp-proto: a short, seeded fast-check burst over the line reader, the
// command parser and the reply parser. Asserts they never throw on arbitrary bytes at arbitrary
// chunk boundaries, never hold more than one chunk plus one line, and that only <CRLF>.<CRLF> ends
// DATA. Exits non-zero on any failure. Seed: FUZZ_SEED (CI pins 424242).
//
// Imports the built package (dist/). If it has not been built yet, it builds it first, so the CI
// job does not depend on a separate build step having run.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fc from 'fast-check';

const pkg = join(import.meta.dirname, '..', '..', 'packages', 'smtp-proto');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('smtp-proto fuzz: build failed');
    process.exit(1);
  }
}
const { SmtpLineReader, parseCommand, ReplyParser, SmtpReplyError } = await import(pathToFileURL(entry).href);

const seed = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const MAX_LINE = 128;
const started = Date.now();

// Bytes biased toward the interesting ones: CR, LF, dot, NUL, space, and command text.
const interesting = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(13, 10, 46, 0, 32) },
  { weight: 2, arbitrary: fc.constantFrom(...Buffer.from('MAIL FROM:<a@b> RCPT TO: DATA\r\n.')) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 255 }) },
);
const chunk = fc.oneof(
  fc.uint8Array({ maxLength: 400 }),
  fc.array(interesting, { maxLength: 400 }).map((a) => Uint8Array.from(a)),
);

function check(name, property, numRuns) {
  const out = fc.check(property, { seed, numRuns });
  if (out.failed) {
    console.error(`smtp-proto fuzz: ${name} FAILED (seed ${seed})`);
    console.error(fc.defaultReportMessage(out));
    return false;
  }
  console.log(`smtp-proto fuzz: ${name} ok (${out.numRuns} runs)`);
  return true;
}

const results = [
  check(
    'line reader + command parser on arbitrary chunks',
    fc.property(fc.array(chunk, { maxLength: 12 }), fc.boolean(), (chunks, startInData) => {
      const reader = new SmtpLineReader({ maxLineLength: MAX_LINE });
      if (startInData) reader.startData({ maxSize: 1000 });
      for (const c of chunks) {
        reader.push(c);
        if (reader.bufferedBytes > c.length + MAX_LINE) throw new Error(`holding ${reader.bufferedBytes} octets`);
        for (let ev = reader.next(); ev; ev = reader.next()) {
          if (ev.type === 'line') {
            if (ev.line.length > MAX_LINE) throw new Error('line over the limit');
            const parsed = parseCommand(ev.line, { smtputf8: true });
            if (!parsed.ok && (parsed.reply.code < 500 || parsed.reply.code > 599)) {
              throw new Error(`parse error reply ${parsed.reply.code}`);
            }
            if (parsed.ok && parsed.command.verb === 'DATA') reader.startData({ maxSize: 1000 });
          }
          if (ev.type === 'data' && ev.chunk.length === 0) throw new Error('empty data event');
        }
        if (reader.bufferedBytes > MAX_LINE) throw new Error(`retained ${reader.bufferedBytes} octets`);
      }
    }),
    1200,
  ),
  check(
    'only CRLF.CRLF ends DATA',
    fc.property(fc.array(chunk, { maxLength: 8 }), (chunks) => {
      const reader = new SmtpLineReader();
      reader.startData();
      const all = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const terminator = all.indexOf('\r\n.\r\n');
      const startsWithDot = all.subarray(0, 3).equals(Buffer.from('.\r\n'));
      let consumed = 0;
      let ended = -1;
      for (const c of chunks) {
        reader.push(c);
        for (let ev = reader.next(); ev; ev = reader.next()) {
          if (ev.type === 'data-end' && ended < 0) ended = consumed + c.length - reader.bufferedBytes;
        }
        consumed += c.length;
        if (ended >= 0) break;
      }
      // DATA ends exactly after the first <CRLF>.<CRLF> (or a leading ".<CRLF>", the empty
      // message) — never earlier on some lookalike, never later.
      const expected = startsWithDot ? 3 : terminator < 0 ? -1 : terminator + 5;
      if (ended !== expected) throw new Error(`DATA ended at ${ended}, expected ${expected}`);
    }),
    500,
  ),
  check(
    'reply parser never throws anything but SmtpReplyError',
    fc.property(fc.array(chunk, { maxLength: 8 }), (chunks) => {
      const p = new ReplyParser({ maxLineLength: 256 });
      try {
        for (const c of chunks) p.push(c);
      } catch (err) {
        if (!(err instanceof SmtpReplyError)) throw err;
      }
    }),
    500,
  ),
];

console.log(`smtp-proto fuzz: seed ${seed}, ${Date.now() - started} ms`);
process.exit(results.every(Boolean) ? 0 : 1);
