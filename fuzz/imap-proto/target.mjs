// Jazzer.js coverage-guided target for @postroom/imap-proto (PST-T-4.2 / PST-REQ-088).
//
// Splits the raw fuzzer bytes into arbitrary chunks and drives them through CommandReader (literals,
// LITERAL+/-, APPEND prefixes, IDLE/AUTHENTICATE raw-line mode) and ResponseReader, the same
// invariants as fuzz/imap-proto/smoke.mjs: nothing throws, every event is well-formed, and neither
// reader ever retains more than its documented bound. Shares fuzz/imap-proto/corpus with the
// fast-check smoke harness as jazzer's seed corpus. A crasher here becomes a fixture under
// fuzz/imap-proto/fixtures before imap-proto is fixed — see docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FuzzedDataProvider } from '@jazzer.js/core';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'imap-proto');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('imap-proto fuzz target: build failed');
}
const { CommandReader, parseCommand, parseAppendPrefix, ResponseReader, parseResponse, isIdleDone, parseSaslResponse } = await import(
  pathToFileURL(entry).href
);

function chunksFrom(fdp, max) {
  const chunkCount = fdp.consumeIntegralInRange(1, 10);
  const chunks = [];
  for (let i = 0; i < chunkCount; i++) {
    const len = fdp.consumeIntegralInRange(0, max);
    chunks.push(Buffer.from(fdp.consumeBytes(len)));
  }
  return chunks;
}

/** @param {Buffer} data */
export function fuzz(data) {
  const fdp = new FuzzedDataProvider(data);
  const chunks = chunksFrom(fdp, 400);

  const reader = new CommandReader({});
  const maxLine = reader.maxLineLength;
  const maxCmd = reader.maxCommandSize;
  for (const c of chunks) {
    reader.push(c);
    for (let ev = reader.next(); ev; ev = reader.next()) {
      switch (ev.type) {
        case 'command': {
          if (ev.bytes.length > maxCmd) throw new Error(`command of ${ev.bytes.length} octets over ${maxCmd}`);
          for (const utf8 of [false, true]) {
            const r = parseCommand(ev.bytes, { utf8 });
            if (r === undefined || r === null || typeof r !== 'object') throw new Error('parseCommand returned a non-object');
            if (r.ok && (r.command.name === 'IDLE' || (r.command.name === 'AUTHENTICATE' && r.command.initialResponse === null))) {
              reader.expectRawLine();
            }
          }
          break;
        }
        case 'continue':
          if (ev.size % 2 === 1) reader.rejectLiteral();
          break;
        case 'append-begin':
          if (ev.size > reader.maxAppendSize) throw new Error('append literal over the limit');
          parseAppendPrefix(ev.prefix);
          break;
        case 'append-data':
          if (ev.chunk.length === 0) throw new Error('empty append-data event');
          break;
        case 'raw-line':
          isIdleDone(ev.line);
          parseSaslResponse(ev.line);
          break;
        case 'error':
          if (typeof ev.error.code !== 'string' || typeof ev.error.fatal !== 'boolean') throw new Error('malformed error event');
          break;
        case 'append-end':
          break;
        default:
          throw new Error(`unknown event ${ev.type}`);
      }
    }
    if (reader.bufferedBytes > maxLine + 1 + maxCmd) throw new Error(`holding ${reader.bufferedBytes} octets`);
  }

  const respReader = new ResponseReader({ maxLineLength: 256, maxLiteralSize: 512, maxResponseSize: 2048, maxNesting: 8 });
  for (const c of chunks) {
    respReader.push(c);
    for (let r = respReader.next(); r; r = respReader.next()) {
      if (typeof r.kind !== 'string') throw new Error('malformed response result');
    }
    if (respReader.bufferedBytes > 2048 + 257) throw new Error(`response reader holding ${respReader.bufferedBytes}`);
  }
  parseResponse(data);
}
