#!/usr/bin/env node
// Fuzz smoke for @postroom/imap-proto: a short, seeded fast-check burst over the command reader,
// the command parser, the APPEND prefix parser and the client-side response reader.
//
// Inputs are the seed corpus in corpus/*.txt (real and tricky commands: literals, LITERAL+/-,
// literal8 APPEND, depth bombs, huge literal announcements, literal floods, bare LF/CR) mutated by
// fast-check — byte flips, insertions of protocol-significant tokens, deletions, duplications and
// splices between seeds — plus plain arbitrary bytes, all fed at arbitrary chunk boundaries under
// arbitrary limits. Asserts nothing throws, every limit holds, and the reader never holds more than
// one line plus one command. Exits non-zero on any failure. Seed: FUZZ_SEED (CI pins 424242).
//
// Imports the built package (dist/), building it first if needed.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import fc from 'fast-check';

const pkg = join(import.meta.dirname, '..', '..', 'packages', 'imap-proto');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) {
    console.error('imap-proto fuzz: build failed');
    process.exit(1);
  }
}
const { CommandReader, parseCommand, parseAppendPrefix, ResponseReader, parseResponse, isIdleDone, parseSaslResponse } = await import(
  pathToFileURL(entry).href
);

const corpusDir = join(import.meta.dirname, 'corpus');
const corpus = readdirSync(corpusDir)
  .filter((f) => f.endsWith('.txt'))
  .sort()
  .map((f) => readFileSync(join(corpusDir, f)));
if (corpus.length < 30) {
  console.error(`imap-proto fuzz: corpus has ${corpus.length} seeds, expected at least 30`);
  process.exit(1);
}

const seed = Number(process.env.FUZZ_SEED ?? Date.now() % 2 ** 31);
const started = Date.now();

const tokens = [
  '{4097+}\r\n', '{5}\r\n', '{0+}\r\n', '~{3}\r\n', '{99999999999}\r\n', '\r\n', '\n', '\r', '(', ')', '((((', '"', '\\',
  ' ', '*', '$', '%', '[', ']', '<0.10>', 'NOT ', 'OR ', 'UID ', 'APPEND ', ' INBOX ', '&', '&-', '\0', '\xff',
].map((t) => Buffer.from(t, 'latin1'));

const mutation = fc.oneof(
  fc.record({ op: fc.constant('flip'), at: fc.nat(), byte: fc.integer({ min: 0, max: 255 }) }),
  fc.record({ op: fc.constant('insert'), at: fc.nat(), bytes: fc.oneof(fc.constantFrom(...tokens), fc.uint8Array({ maxLength: 8 }).map((b) => Buffer.from(b))) }),
  fc.record({ op: fc.constant('delete'), at: fc.nat(), len: fc.integer({ min: 1, max: 16 }) }),
  fc.record({ op: fc.constant('dup'), at: fc.nat(), len: fc.integer({ min: 1, max: 64 }), times: fc.integer({ min: 1, max: 20 }) }),
  fc.record({ op: fc.constant('splice'), other: fc.nat(), at: fc.nat(), from: fc.nat() }),
);

function mutate(input, mutations) {
  let b = input;
  for (const m of mutations) {
    const at = b.length === 0 ? 0 : m.at % (b.length + 1);
    switch (m.op) {
      case 'flip':
        if (b.length > 0) {
          b = Buffer.from(b);
          b[m.at % b.length] = m.byte;
        }
        break;
      case 'insert':
        b = Buffer.concat([b.subarray(0, at), m.bytes, b.subarray(at)]);
        break;
      case 'delete':
        b = Buffer.concat([b.subarray(0, at), b.subarray(at + m.len)]);
        break;
      case 'dup': {
        const piece = b.subarray(at, at + m.len);
        b = Buffer.concat([b.subarray(0, at), ...Array(m.times).fill(piece), b.subarray(at)]);
        break;
      }
      case 'splice': {
        const other = corpus[m.other % corpus.length];
        b = Buffer.concat([b.subarray(0, at), other.subarray(m.from % (other.length + 1))]);
        break;
      }
    }
  }
  return b;
}

function chunk(bytes, cuts) {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const p of points) {
    if (p > prev) out.push(bytes.subarray(prev, p));
    prev = Math.max(prev, p);
  }
  if (prev < bytes.length) out.push(bytes.subarray(prev));
  return out;
}

const readerOptions = fc.oneof(
  fc.constant({}),
  fc.record({
    maxLineLength: fc.integer({ min: 8, max: 4096 }),
    maxCommandSize: fc.integer({ min: 16, max: 16384 }),
    maxLiterals: fc.integer({ min: 1, max: 100 }),
    maxAppendSize: fc.integer({ min: 0, max: 2000 }),
    literalMode: fc.constantFrom('literal-', 'literal+', 'none'),
  }),
);

function expectNoThrow(label, fn) {
  const r = fn();
  if (r === undefined || r === null || typeof r !== 'object') throw new Error(`${label} returned ${String(r)}`);
  return r;
}

/** Feed the reader; answer IDLE/AUTHENTICATE with raw lines, reject some literals; check invariants. */
function drive(chunks, options, rejectOdd) {
  const reader = new CommandReader(options);
  const maxLine = reader.maxLineLength;
  const maxCmd = reader.maxCommandSize;
  for (const c of chunks) {
    reader.push(c);
    for (let ev = reader.next(); ev; ev = reader.next()) {
      switch (ev.type) {
        case 'command': {
          if (ev.bytes.length > maxCmd) throw new Error(`command of ${ev.bytes.length} octets over ${maxCmd}`);
          for (const utf8 of [false, true]) {
            const r = expectNoThrow('parseCommand', () => parseCommand(ev.bytes, { utf8 }));
            if (r.ok && (r.command.name === 'IDLE' || (r.command.name === 'AUTHENTICATE' && r.command.initialResponse === null))) {
              reader.expectRawLine();
            }
          }
          break;
        }
        case 'continue':
          if (rejectOdd && ev.size % 2 === 1) reader.rejectLiteral();
          break;
        case 'append-begin':
          if (ev.size > reader.maxAppendSize) throw new Error('append literal over the limit');
          expectNoThrow('parseAppendPrefix', () => parseAppendPrefix(ev.prefix));
          break;
        case 'append-data':
          if (ev.chunk.length === 0) throw new Error('empty append-data event');
          break;
        case 'raw-line':
          isIdleDone(ev.line);
          expectNoThrow('parseSaslResponse', () => parseSaslResponse(ev.line));
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
}

function check(name, property, numRuns) {
  const out = fc.check(property, { seed, numRuns });
  if (out.failed) {
    console.error(`imap-proto fuzz: ${name} FAILED (seed ${seed})`);
    console.error(fc.defaultReportMessage(out));
    return false;
  }
  console.log(`imap-proto fuzz: ${name} ok (${out.numRuns} runs)`);
  return true;
}

const seedIndex = fc.integer({ min: 0, max: corpus.length - 1 });
const cuts = fc.array(fc.nat(), { maxLength: 24 });

const results = [
  check(
    'corpus seeds, unmutated, through reader and parser',
    fc.property(seedIndex, cuts, readerOptions, (i, c, o) => drive(chunk(corpus[i], c), o, false)),
    300,
  ),
  check(
    'mutated corpus through reader and parser at arbitrary chunk boundaries',
    fc.property(seedIndex, fc.array(mutation, { minLength: 1, maxLength: 6 }), cuts, readerOptions, fc.boolean(), (i, muts, c, o, rej) =>
      drive(chunk(mutate(corpus[i], muts), c), o, rej),
    ),
    3000,
  ),
  check(
    'mutated corpus straight into parseCommand and parseAppendPrefix',
    fc.property(seedIndex, fc.array(mutation, { maxLength: 6 }), fc.boolean(), (i, muts, utf8) => {
      const b = mutate(corpus[i], muts);
      const line = b.subarray(0, Math.max(0, b.length - 2));
      expectNoThrow('parseCommand', () => parseCommand(line, { utf8 }));
      expectNoThrow('parseAppendPrefix', () => parseAppendPrefix(line, { utf8 }));
    }),
    3000,
  ),
  check(
    'arbitrary bytes through reader and parser',
    fc.property(fc.array(fc.uint8Array({ maxLength: 400 }), { maxLength: 10 }), readerOptions, (chunks, o) => drive(chunks, o, true)),
    1500,
  ),
  check(
    'response reader and parser never throw',
    fc.property(fc.array(fc.uint8Array({ maxLength: 300 }), { maxLength: 8 }), seedIndex, fc.array(mutation, { maxLength: 4 }), (chunks, i, muts) => {
      const reader = new ResponseReader({ maxLineLength: 256, maxLiteralSize: 512, maxResponseSize: 2048, maxNesting: 8 });
      for (const c of [...chunks, mutate(Buffer.from(`* 1 FETCH (BODY[] ${corpus[i].length > 0 ? `{${corpus[i].length}}\r\n` : '""'}`), muts), corpus[i], Buffer.from(')\r\n')]) {
        reader.push(c);
        for (let r = reader.next(); r; r = reader.next()) if (typeof r.kind !== 'string') throw new Error('malformed response result');
        if (reader.bufferedBytes > 2048 + 257) throw new Error(`response reader holding ${reader.bufferedBytes}`);
      }
      expectNoThrow('parseResponse', () => parseResponse(mutate(corpus[i], muts)));
    }),
    1500,
  ),
];

console.log(`imap-proto fuzz: seed ${seed}, ${corpus.length} corpus seeds, ${Date.now() - started} ms`);
process.exit(results.every(Boolean) ? 0 : 1);
