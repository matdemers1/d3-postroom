// Jazzer.js coverage-guided target for @postroom/smtp-proto (PST-T-4.2 / PST-REQ-088).
//
// Feeds the raw fuzzer bytes through the line reader, the command parser and the reply parser, the
// same invariants as fuzz/smtp-proto/smoke.mjs (fast-check, seeded, run in CI on every push):
// nothing throws but SmtpReplyError out of the reply parser, a parse error is always a 5xx reply,
// only <CRLF>.<CRLF> ends DATA, and the reader never retains more than one buffered line. A crasher
// here becomes a fixture under fuzz/smtp-proto/fixtures before smtp-proto is fixed — see
// docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FuzzedDataProvider } from '@jazzer.js/core';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'smtp-proto');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('smtp-proto fuzz target: build failed');
}
const { SmtpLineReader, parseCommand, ReplyParser, SmtpReplyError } = await import(pathToFileURL(entry).href);

const MAX_LINE = 128;

function chunksFrom(fdp) {
  const chunkCount = fdp.consumeIntegralInRange(1, 8);
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    const len = fdp.consumeIntegralInRange(0, 256);
    chunks.push(Buffer.from(fdp.consumeBytes(len)));
  }
  return chunks;
}

/** @param {Buffer} data */
export function fuzz(data) {
  const fdp = new FuzzedDataProvider(data);
  const startInData = fdp.consumeBoolean();
  const chunks = chunksFrom(fdp);

  const reader = new SmtpLineReader({ maxLineLength: MAX_LINE });
  if (startInData) reader.startData({ maxSize: 1000 });
  for (const c of chunks) {
    reader.push(c);
    if (reader.bufferedBytes > c.length + MAX_LINE) {
      throw new Error(`SmtpLineReader holding ${reader.bufferedBytes} octets`);
    }
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

  const replyParser = new ReplyParser({ maxLineLength: 256 });
  try {
    replyParser.push(data);
  } catch (err) {
    if (!(err instanceof SmtpReplyError)) throw err;
  }
}
