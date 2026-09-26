// Jazzer.js coverage-guided target for @postroom/mime (PST-T-4.2 / PST-REQ-088).
//
// Splits the raw fuzzer bytes into a slice size and a byte body, chunks the body at pseudo-random
// cut points and streams it through MimeParser, then runs the structured header parsers (which also
// carry the package's RFC 5322 address/date/message-id parsing) on the same bytes as a string. Same
// invariants as fuzz/mime/smoke.mjs: nothing throws, every run ends with an `end` event, retained
// bytes stay within the reported bound, and the event count stays linear in the input. A crasher
// here becomes a fixture under fuzz/mime/fixtures before mime is fixed — see
// docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FuzzedDataProvider } from '@jazzer.js/core';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'mime');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('mime fuzz target: build failed');
}
const { MimeParser, parseAddressList, parseContentType, parseContentDisposition, parseDate, parseMessageIdList, decodeEncodedWords, parseHeaderBlock } =
  await import(pathToFileURL(entry).href);

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

/** @param {Buffer} data */
export function fuzz(data) {
  const fdp = new FuzzedDataProvider(data);
  const slice = fdp.consumeIntegralInRange(1, 2048);
  const cutCount = fdp.consumeIntegralInRange(0, 12);
  const cuts = [];
  for (let i = 0; i < cutCount; i++) cuts.push(fdp.consumeIntegralInRange(0, 4000));
  const body = Buffer.from(fdp.consumeRemainingAsBytes());

  let events = 0;
  let ended = null;
  const parser = new MimeParser(
    (e) => {
      events++;
      if (e.type === 'end') ended = e.stats;
    },
    { maxDepth: 12, sliceBytes: slice },
  );
  for (const c of chunk(body, cuts)) parser.write(c);
  parser.end();
  if (ended === null) throw new Error('no end event');
  if (ended.bytesIn !== body.length) throw new Error(`bytesIn ${ended.bytesIn} != ${body.length}`);
  if (ended.maxRetainedBytes > ended.retainedBound) throw new Error(`retained ${ended.maxRetainedBytes} > bound ${ended.retainedBound}`);
  if (events > 8 * (body.length + 1) + 64) throw new Error(`${events} events for ${body.length} bytes`);

  const s = body.toString('latin1');
  parseAddressList(s);
  parseContentType(s);
  parseContentDisposition(s);
  parseDate(s);
  parseMessageIdList(s);
  decodeEncodedWords(s);
  parseHeaderBlock(body);
}
