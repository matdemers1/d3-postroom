#!/usr/bin/env node
// Fuzz smoke for @postroom/mime (PST-T-2.1): a short, seeded fast-check burst of arbitrary and
// MIME-shaped bytes at arbitrary chunk boundaries through the streaming parser, plus the structured
// header parsers on arbitrary strings. Asserts nothing throws, every run ends with an `end` event,
// the parser's retained bytes never exceed its bound, and work stays linear in the input. Exits
// non-zero on any failure. Seed: FUZZ_SEED (CI pins 424242). A crasher becomes a regression fixture
// in packages/mime/test/unit before it is fixed.
//
// Imports the built package (dist/). If it has not been built yet, it builds it first.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fc from 'fast-check';

const pkg = join(import.meta.dirname, '..', '..', 'packages', 'mime');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('mime fuzz: build failed');
    process.exit(1);
  }
}
const mime = await import(pathToFileURL(entry).href);
const { MimeParser, collectMessage, parseAddressList, parseContentType, parseContentDisposition, parseDate, parseMessageIdList, decodeEncodedWords, parseHeaderBlock } = mime;

const seed = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const started = Date.now();

const token = fc.constantFrom(
  '\r\n', '\n', '\r', '\r\n\r\n', '--', '--b', '--b--', '--c', '-', ' ', '\t', ':', ';', '=', '"', '(', ')', '<', '>', '@',
  'Content-Type: multipart/mixed; boundary=b', 'Content-Type: multipart/alternative; boundary="c"',
  'Content-Type: multipart/digest; boundary=b', 'Content-Type: message/rfc822', 'Content-Type: text/plain; charset=iso-2022-jp',
  'Content-Transfer-Encoding: base64', 'Content-Transfer-Encoding: quoted-printable', 'Content-Disposition: attachment; filename*0*=utf-8\'\'%E2%82;',
  '=?utf-8?B?', '=?utf-8?Q?', '?=', '=0D=0A', '=\r\n', 'From ', 'Subject: x', ' folded',
);
const mimeish = fc.array(fc.oneof({ weight: 4, arbitrary: token }, { weight: 1, arbitrary: fc.string({ maxLength: 12 }) }), { maxLength: 120 })
  .map((parts) => Buffer.from(parts.join(''), 'latin1'));
const bytes = fc.oneof(fc.uint8Array({ maxLength: 1500 }).map((b) => Buffer.from(b)), mimeish);
const cuts = fc.array(fc.nat({ max: 4000 }), { maxLength: 12 });

function chunk(buf, points) {
  const sorted = [...new Set(points.filter((p) => p > 0 && p < buf.length))].sort((a, b) => a - b);
  const out = [];
  let last = 0;
  for (const p of sorted) {
    out.push(buf.subarray(last, p));
    last = p;
  }
  out.push(buf.subarray(last));
  return out;
}

let runs = 0;
try {
  // 1. The streaming parser: never throws, always ends, bounded retention, linear event count.
  fc.assert(
    fc.property(bytes, cuts, fc.integer({ min: 1, max: 2048 }), (input, points, slice) => {
      runs++;
      let events = 0;
      let ended = null;
      const parser = new MimeParser((e) => {
        events++;
        if (e.type === 'end') ended = e.stats;
      }, { maxDepth: 12, sliceBytes: slice });
      for (const c of chunk(input, points)) parser.write(c);
      parser.end();
      if (ended === null) throw new Error('no end event');
      if (ended.bytesIn !== input.length) throw new Error(`bytesIn ${ended.bytesIn} != ${input.length}`);
      if (ended.maxRetainedBytes > ended.retainedBound) throw new Error(`retained ${ended.maxRetainedBytes} > bound ${ended.retainedBound}`);
      // Every event is caused by some input byte, a slice, or a part boundary: generous linear cap.
      if (events > 8 * (input.length + 1) + 64) throw new Error(`${events} events for ${input.length} bytes`);
    }),
    { numRuns: 1200, seed },
  );

  // 2. The structured header parsers on arbitrary strings.
  fc.assert(
    fc.property(fc.oneof(fc.string({ maxLength: 300 }), mimeish.map((b) => b.toString('latin1'))), (s) => {
      runs++;
      parseAddressList(s);
      parseContentType(s);
      parseContentDisposition(s);
      parseDate(s);
      parseMessageIdList(s);
      decodeEncodedWords(s);
      parseHeaderBlock(Buffer.from(s, 'latin1'));
    }),
    { numRuns: 600, seed },
  );

  // 3. The summary API end to end.
  await fc.assert(
    fc.asyncProperty(mimeish, cuts, async (input, points) => {
      runs++;
      const summary = await collectMessage(chunk(input, points), { maxDepth: 12, maxTextBytes: 4096 });
      if (summary.stats === null) throw new Error('no stats');
    }),
    { numRuns: 300, seed },
  );
} catch (err) {
  console.error(`fuzz/mime/smoke: FAILED after ${String(runs)} runs (seed=${String(seed)})`);
  console.error(err);
  process.exit(1);
}

console.log(`fuzz/mime/smoke: ok (${String(runs)} runs, seed=${String(seed)}, ${String(Date.now() - started)} ms)`);
process.exit(0);
