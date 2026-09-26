// The streaming command reader: literals, LITERAL+/LITERAL- (RFC 7888), limits, and the literal
// abuse cases the adversarial suite (PST-T-4.1) builds on.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CommandReader,
  LITERAL_MINUS_MAX,
  isIdleDone,
  parseAppendPrefix,
  parseCommand,
  parseSaslResponse,
  type CommandReaderOptions,
  type ReaderEvent,
} from '../../src/index.js';
import { chunked } from './arbitraries.js';

function events(input: string | Buffer | readonly (string | Buffer)[], options: CommandReaderOptions = {}): ReaderEvent[] {
  const reader = new CommandReader(options);
  const out: ReaderEvent[] = [];
  const chunks = typeof input === 'string' || Buffer.isBuffer(input) ? [input] : input;
  for (const c of chunks) {
    reader.push(typeof c === 'string' ? Buffer.from(c, 'latin1') : c);
    for (let ev = reader.next(); ev; ev = reader.next()) out.push(ev);
  }
  return out;
}

function summary(evs: readonly ReaderEvent[]): string[] {
  return evs.map((e) => {
    switch (e.type) {
      case 'command':
        return `command ${JSON.stringify(e.bytes.toString('latin1'))}`;
      case 'continue':
        return `continue ${e.size}`;
      case 'append-begin':
        return `append-begin ${JSON.stringify(e.prefix.toString('latin1'))} ${e.size}${e.synchronizing ? ' sync' : ''}${e.binary ? ' binary' : ''}`;
      case 'append-data':
        return `data ${JSON.stringify(e.chunk.toString('latin1'))}`;
      case 'append-end':
        return `append-end ${JSON.stringify(e.trailing.toString('latin1'))}`;
      case 'raw-line':
        return `raw ${JSON.stringify(e.line.toString('latin1'))}`;
      case 'error':
        return `error ${e.error.code} ${e.error.tag ?? '-'}${e.error.fatal ? ' fatal' : ''}`;
    }
  });
}

describe('CommandReader: lines and literals', () => {
  it('splits commands at CRLF', () => {
    expect(summary(events('a1 NOOP\r\na2 CAPABILITY\r\n'))).toEqual(['command "a1 NOOP"', 'command "a2 CAPABILITY"']);
  });

  it('asks for continuation on a synchronizing literal and inlines its bytes', () => {
    expect(summary(events('A001 LOGIN {11}\r\nFRED FOOBAR {7}\r\nfat man\r\n'))).toEqual([
      'continue 11',
      'continue 7',
      'command "A001 LOGIN {11}\\r\\nFRED FOOBAR {7}\\r\\nfat man"',
    ]);
  });

  it('does not ask for continuation on LITERAL+ / LITERAL- literals', () => {
    const evs = events('A001 LOGIN {11+}\r\nFRED FOOBAR {7+}\r\nfat man\r\n');
    expect(summary(evs)).toEqual(['command "A001 LOGIN {11+}\\r\\nFRED FOOBAR {7+}\\r\\nfat man"']);
    const cmd = evs[0]?.type === 'command' ? parseCommand(evs[0].bytes) : null;
    expect(cmd?.ok && cmd.command).toEqual({ tag: 'A001', name: 'LOGIN', username: 'FRED FOOBAR', password: 'fat man' });
  });

  it('accepts a non-synchronizing literal of exactly 4096 octets under LITERAL-', () => {
    const body = 'x'.repeat(LITERAL_MINUS_MAX);
    expect(summary(events(`a LOGIN u {4096+}\r\n${body}\r\n`))[0]).toMatch(/^command /);
  });

  it('refuses a 4097-octet non-synchronizing literal under LITERAL- as fatal (the stream is desynchronised)', () => {
    const reader = new CommandReader();
    reader.push(Buffer.from(`a LOGIN u {4097+}\r\n${'x'.repeat(4097)}\r\nb NOOP\r\n`));
    expect(summary([reader.next()].filter((e) => e !== null))).toEqual(['error non-sync-literal-too-large a fatal']);
    expect(reader.next()).toBeNull();
    expect(reader.dead).toBe(true);
    reader.push(Buffer.from('c NOOP\r\n'));
    expect(reader.next()).toBeNull();
  });

  it('accepts a large non-synchronizing literal under LITERAL+', () => {
    const body = 'y'.repeat(10_000);
    expect(summary(events(`a LOGIN u {10000+}\r\n${body}\r\n`, { literalMode: 'literal+' }))[0]).toMatch(/^command /);
  });

  it('refuses every non-synchronizing literal when neither extension is advertised', () => {
    expect(summary(events('a LOGIN u {1+}\r\nx\r\n', { literalMode: 'none' }))).toEqual(['error non-sync-literal-refused a fatal']);
  });

  it('handles an empty literal', () => {
    expect(summary(events('a LOGIN {0}\r\n {0}\r\n\r\n'))).toEqual(['continue 0', 'continue 0', 'command "a LOGIN {0}\\r\\n {0}\\r\\n"']);
    const r = parseCommand(Buffer.from('a LOGIN {0}\r\n {0}\r\n'));
    expect(r.ok && r.command).toEqual({ tag: 'a', name: 'LOGIN', username: '', password: '' });
  });

  it('carries CRLF and marker look-alikes inside literals verbatim', () => {
    const evs = events('a LOGIN {9}\r\nx {3}\r\nyy {2}\r\n\r\n\r\n');
    expect(summary(evs)).toEqual(['continue 9', 'continue 2', 'command "a LOGIN {9}\\r\\nx {3}\\r\\nyy {2}\\r\\n\\r\\n"']);
  });

  it('lets the daemon refuse a synchronizing literal; the command is dropped and reading resumes', () => {
    const reader = new CommandReader();
    reader.push(Buffer.from('a LOGIN {5}\r\nb NOOP\r\n'));
    expect(reader.next()).toEqual({ type: 'continue', tag: 'a', size: 5 });
    expect(reader.rejectLiteral()).toBe(true);
    expect(summary([reader.next()].filter((e) => e !== null))).toEqual(['command "b NOOP"']);
    expect(reader.rejectLiteral()).toBe(false);
  });

  it('rejects bare LF and bare CR with the tag, then resynchronises', () => {
    expect(summary(events('a NOOP\nb NOOP\r\nc NO\rOP\r\nd NOOP\r\n'))).toEqual([
      'error bare-lf a',
      'command "b NOOP"',
      'error bare-cr c',
      'command "d NOOP"',
    ]);
  });

  it('reads raw lines for IDLE and SASL continuations', () => {
    const reader = new CommandReader();
    reader.push(Buffer.from('a IDLE\r\n'));
    expect(reader.next()?.type).toBe('command');
    reader.expectRawLine();
    reader.push(Buffer.from('DONE {5}\r\n'));
    const ev = reader.next();
    expect(ev?.type === 'raw-line' && ev.line.toString()).toBe('DONE {5}');
    expect(isIdleDone(Buffer.from('done'))).toBe(true);
    expect(isIdleDone(Buffer.from('DONE '))).toBe(false);
    expect(parseSaslResponse(Buffer.from('*'))).toEqual({ type: 'cancel' });
    expect(parseSaslResponse(Buffer.from('AGZyZWQAcGFzcw=='))).toEqual({ type: 'data', data: Buffer.from('\0fred\0pass') });
    expect(parseSaslResponse(Buffer.from('not base64!'))).toEqual({ type: 'invalid' });
  });
});

describe('CommandReader: APPEND streams its message', () => {
  it('emits append-begin, data slices and append-end; the prefix parses', () => {
    const evs = events(['A003 APPEND saved-messages (\\Seen) {27}\r\nDate: Mon, 7 Feb', ' 1994\r\n\r\nhi\r\n']);
    expect(summary(evs)).toEqual([
      'append-begin "A003 APPEND saved-messages (\\\\Seen) {27}" 27 sync',
      'data "Date: Mon, 7 Feb"',
      'data " 1994\\r\\n\\r\\nhi"',
      'append-end ""',
    ]);
    const begin = evs[0];
    const prefix = begin?.type === 'append-begin' ? parseAppendPrefix(begin.prefix) : null;
    expect(prefix).toEqual({ ok: true, tag: 'A003', mailbox: 'saved-messages', flags: ['\\Seen'], date: null, size: 27, binary: false, synchronizing: true });
  });

  it('buffers a mailbox given as a literal and streams only the message', () => {
    const evs = events('a APPEND {5}\r\nINBOX ~{3+}\r\n\0\x01\x02\r\n');
    expect(summary(evs)).toEqual([
      'continue 5',
      'append-begin "a APPEND {5}\\r\\nINBOX ~{3+}" 3 binary',
      'data "\\u0000\\u0001\\u0002"',
      'append-end ""',
    ]);
    const begin = evs[1];
    const prefix = begin?.type === 'append-begin' ? parseAppendPrefix(begin.prefix) : null;
    expect(prefix?.ok && prefix.mailbox).toBe('INBOX');
    expect(prefix?.ok && prefix.binary).toBe(true);
  });

  it('refuses a message over maxAppendSize before any byte is sent (synchronizing)', () => {
    const reader = new CommandReader({ maxAppendSize: 1000 });
    reader.push(Buffer.from('a APPEND INBOX {1001}\r\nb NOOP\r\n'));
    expect(summary([reader.next(), reader.next()].filter((e) => e !== null))).toEqual(['error literal-too-large a', 'command "b NOOP"']);
  });

  it('skips an oversized non-synchronizing message under LITERAL+ without keeping it', () => {
    const reader = new CommandReader({ maxAppendSize: 1000, literalMode: 'literal+' });
    reader.push(Buffer.from(`a APPEND INBOX {2000+}\r\n${'z'.repeat(2000)}\r\nb NOOP\r\n`));
    expect(summary([reader.next(), reader.next()].filter((e) => e !== null))).toEqual(['error literal-too-large a', 'command "b NOOP"']);
  });

  it('streams a 50 MB APPEND literal with bounded memory', () => {
    const MB = 1024 * 1024;
    const size = 50 * MB;
    const block = Buffer.alloc(64 * 1024, 0x61);
    const reader = new CommandReader();
    reader.push(Buffer.from(`A1 APPEND INBOX {${size}}\r\n`));
    expect(reader.next()?.type).toBe('append-begin');
    const baseline = process.memoryUsage().heapUsed;
    let received = 0;
    let peakBuffered = 0;
    let peakHeap = 0;
    for (let sent = 0; sent < size; sent += block.length) {
      reader.push(block);
      peakBuffered = Math.max(peakBuffered, reader.bufferedBytes);
      for (let ev = reader.next(); ev; ev = reader.next()) {
        if (ev.type === 'append-data') received += ev.chunk.length;
      }
      if ((sent / block.length) % 64 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed - baseline);
    }
    reader.push(Buffer.from('\r\n'));
    expect(reader.next()?.type).toBe('append-end');
    expect(received).toBe(size);
    expect(peakBuffered).toBeLessThanOrEqual(block.length);
    expect(peakHeap).toBeLessThan(16 * MB);
  });
});

describe('CommandReader: limits', () => {
  it('rejects a line over maxLineLength and discards the rest of it', () => {
    const evs = events([`a LOGIN ${'x'.repeat(100)}`, `${'y'.repeat(100)}\r\nb NOOP\r\n`], { maxLineLength: 64 });
    expect(summary(evs)).toEqual(['error line-too-long a', 'command "b NOOP"']);
  });

  it('skips the literal a discarded overlong line announces (non-synchronizing) and the rest of that command', () => {
    const evs = events(`a SEARCH ${'x'.repeat(100)} {5+}\r\nhello more {3+}\r\nabc\r\nb NOOP\r\n`, { maxLineLength: 64 });
    expect(summary(evs)).toEqual(['error line-too-long a', 'command "b NOOP"']);
  });

  it('limits literals per command', () => {
    const cmd = `a SEARCH${' TEXT {1+}\r\nx'.repeat(5)}\r\nb NOOP\r\n`;
    expect(summary(events(cmd, { maxLiterals: 4 }))).toEqual(['error too-many-literals a', 'command "b NOOP"']);
  });

  it('limits the total command size, literals included', () => {
    const evs = events('a LOGIN {600}\r\n', { maxCommandSize: 512 });
    expect(summary(evs)).toEqual(['error literal-too-large a']);
    const flood = `a SEARCH${' TEXT {100+}\r\n'.concat('q'.repeat(100)).repeat(10)}\r\nb NOOP\r\n`;
    expect(summary(events(flood, { maxCommandSize: 512 }))).toEqual(['error literal-too-large a', 'command "b NOOP"']);
  });

  it('treats a literal size that cannot be represented as fatal when non-synchronizing', () => {
    expect(summary(events('a LOGIN {99999999999999999999+}\r\n', { literalMode: 'literal+' }))).toEqual([
      'error literal-too-large a',
      'error non-sync-literal-too-large a fatal',
    ]);
    expect(summary(events('a LOGIN {99999999999999999999}\r\nb NOOP\r\n'))).toEqual(['error literal-too-large a', 'command "b NOOP"']);
  });
});

describe('CommandReader: properties', () => {
  const interesting = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(13, 10, 0x7b, 0x7d, 0x2b, 0x7e, 0x20, 0x30, 0x35, 0x39) },
    { weight: 2, arbitrary: fc.constantFrom(...Buffer.from('a APPEND INBOX LOGIN {5}{5+}~{2}\r\n')) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: 255 }) },
  );
  const chunk = fc.oneof(fc.uint8Array({ maxLength: 300 }), fc.array(interesting, { maxLength: 300 }).map((a) => Uint8Array.from(a)));
  const options = fc.record({
    maxLineLength: fc.integer({ min: 8, max: 200 }),
    maxCommandSize: fc.integer({ min: 16, max: 600 }),
    maxLiterals: fc.integer({ min: 1, max: 6 }),
    maxAppendSize: fc.integer({ min: 0, max: 500 }),
    literalMode: fc.constantFrom('literal-' as const, 'literal+' as const, 'none' as const),
  });

  it('never throws on arbitrary bytes, respects every limit and never holds more than it may', () => {
    fc.assert(
      fc.property(fc.array(chunk, { maxLength: 10 }), options, fc.boolean(), (chunks, o, rejectSome) => {
        const reader = new CommandReader(o);
        for (const c of chunks) {
          reader.push(c);
          for (let ev = reader.next(); ev; ev = reader.next()) {
            if (ev.type === 'command') {
              expect(ev.bytes.length).toBeLessThanOrEqual(o.maxCommandSize);
              // The parser never throws either: a result, ok or not.
              expect(typeof parseCommand(ev.bytes).ok).toBe('boolean');
            }
            if (ev.type === 'append-begin') {
              expect(ev.size).toBeLessThanOrEqual(o.maxAppendSize);
              expect(typeof parseAppendPrefix(ev.prefix).ok).toBe('boolean');
            }
            if (ev.type === 'append-data') expect(ev.chunk.length).toBeGreaterThan(0);
            if (ev.type === 'continue') {
              if (rejectSome && ev.size % 2 === 1) reader.rejectLiteral();
            }
          }
          expect(reader.bufferedBytes).toBeLessThanOrEqual(o.maxLineLength + 1 + o.maxCommandSize);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('chunk boundaries never change the events', () => {
    fc.assert(
      fc.property(fc.array(chunk, { maxLength: 6 }), fc.array(fc.nat(), { maxLength: 30 }), (chunks, cuts) => {
        const whole = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        const norm = (evs: ReaderEvent[]): string[] => {
          // Coalesce append-data, whose slicing legitimately follows the chunking.
          const out: string[] = [];
          for (const s of summary(evs)) {
            const last = out[out.length - 1];
            if (s.startsWith('data ') && last?.startsWith('data ')) {
              out[out.length - 1] = `data ${JSON.stringify(String(JSON.parse(last.slice(5))) + String(JSON.parse(s.slice(5))))}`;
            } else {
              out.push(s);
            }
          }
          return out;
        };
        const a = norm(events([whole], { maxLineLength: 100, maxCommandSize: 400, maxAppendSize: 300 }));
        const b = norm(events(chunked(whole, cuts), { maxLineLength: 100, maxCommandSize: 400, maxAppendSize: 300 }));
        expect(b).toEqual(a);
      }),
      { numRuns: 1500 },
    );
  });
});
