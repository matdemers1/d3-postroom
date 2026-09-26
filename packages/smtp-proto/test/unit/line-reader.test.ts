import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SmtpLineReader, type LineReaderEvent } from '../../src/index.js';
import { SMUGGLING_CASES, smugglingBody } from './fixtures/smuggling.js';

const b = (s: string): Buffer => Buffer.from(s, 'latin1');

/** Feed `chunks` one at a time, draining events after each; starts DATA after any line `DATA`. */
function run(chunks: readonly Buffer[], opts: { dataAfter?: string; maxSize?: number; maxLine?: number } = {}) {
  const reader = new SmtpLineReader(opts.maxLine === undefined ? {} : { maxLineLength: opts.maxLine });
  const events: LineReaderEvent[] = [];
  let maxHeld = 0;
  for (const c of chunks) {
    reader.push(c);
    maxHeld = Math.max(maxHeld, reader.bufferedBytes);
    for (let ev = reader.next(); ev; ev = reader.next()) {
      events.push(ev);
      if (ev.type === 'line' && ev.line.toString('latin1') === (opts.dataAfter ?? 'DATA')) {
        reader.startData(opts.maxSize === undefined ? {} : { maxSize: opts.maxSize });
      }
    }
  }
  return { events, reader, maxHeld };
}

/** Collapse events to a comparable summary: lines, errors, joined data, end markers. */
function summarize(events: readonly LineReaderEvent[]): string[] {
  const out: string[] = [];
  let data: Buffer[] = [];
  for (const ev of events) {
    if (ev.type === 'data') {
      data.push(ev.chunk);
      continue;
    }
    if (data.length > 0) {
      out.push(`data:${Buffer.concat(data).toString('latin1')}`);
      data = [];
    }
    if (ev.type === 'line') out.push(`line:${ev.line.toString('latin1')}`);
    else if (ev.type === 'line-error') out.push(`err:${ev.error}`);
    else if (ev.type === 'data-rejected') out.push(`rejected:${ev.reason}`);
    else out.push(`end:${String(ev.size)}:${ev.rejection ?? 'ok'}`);
  }
  if (data.length > 0) out.push(`data:${Buffer.concat(data).toString('latin1')}`);
  return out;
}

function splitAt(buf: Buffer, cuts: number[]): Buffer[] {
  const points = [...new Set(cuts.map((c) => c % (buf.length + 1)))].sort((x, y) => x - y);
  const out: Buffer[] = [];
  let prev = 0;
  for (const p of points) {
    out.push(buf.subarray(prev, p));
    prev = p;
  }
  out.push(buf.subarray(prev));
  return out;
}

describe('SmtpLineReader — command mode', () => {
  it('yields lines only at CRLF', () => {
    const { events } = run([b('EHLO a\r\nMAIL FROM:<x@y>\r\nRC'), b('PT TO:<z@y>\r\n')]);
    expect(summarize(events)).toEqual(['line:EHLO a', 'line:MAIL FROM:<x@y>', 'line:RCPT TO:<z@y>']);
  });

  it('reports a bare LF and drains the rest of the line', () => {
    const { events } = run([b('EHLO a\nMAIL FROM:<x@y>\r\nNOOP\r\n')]);
    expect(summarize(events)).toEqual(['err:bare-lf', 'line:NOOP']);
  });

  it('reports a bare CR, even split across chunks', () => {
    const { events } = run([b('EHLO a\r'), b('X\r\nNOOP\r\n')]);
    expect(summarize(events)).toEqual(['err:bare-cr', 'line:NOOP']);
  });

  it('treats CR CR LF as a bare CR followed by a line end', () => {
    const { events } = run([b('NOOP\r\r\nQUIT\r\n')]);
    expect(summarize(events)).toEqual(['err:bare-cr', 'line:QUIT']);
  });

  it('refuses lines longer than the limit without buffering them', () => {
    const long = b(`NOOP ${'x'.repeat(100_000)}\r\nQUIT\r\n`);
    const chunks = splitAt(long, [1000, 5000, 20_000, 60_000]);
    const reader = new SmtpLineReader({ maxLineLength: 512 });
    const events: LineReaderEvent[] = [];
    for (const c of chunks) {
      reader.push(c);
      for (let ev = reader.next(); ev; ev = reader.next()) events.push(ev);
      // Nothing is retained between pushes except at most one partial line.
      expect(reader.bufferedBytes).toBeLessThanOrEqual(512);
    }
    expect(summarize(events)).toEqual(['err:line-too-long', 'line:QUIT']);
  });

  it('accepts a line of exactly the limit', () => {
    const { events } = run([b(`${'x'.repeat(16)}\r\n`)], { maxLine: 16 });
    expect(summarize(events)).toEqual([`line:${'x'.repeat(16)}`]);
  });

  it('discardPending drops unconsumed bytes (STARTTLS)', () => {
    const reader = new SmtpLineReader();
    reader.push(b('STARTTLS\r\nMAIL FROM:<a@evil>\r\n'));
    const first = reader.next();
    expect(first?.type === 'line' && first.line.toString()).toBe('STARTTLS');
    expect(reader.discardPending()).toBe('MAIL FROM:<a@evil>\r\n'.length);
    expect(reader.next()).toBeNull();
  });
});

describe('SmtpLineReader — DATA mode', () => {
  it('dot-unstuffs and ends only at CRLF.CRLF', () => {
    const { events } = run([b('DATA\r\nline one\r\n..dotted\r\n.\r\nQUIT\r\n')]);
    expect(summarize(events)).toEqual([
      'line:DATA',
      'data:line one\r\n.dotted\r\n',
      `end:${String('line one\r\n.dotted\r\n'.length)}:ok`,
      'line:QUIT',
    ]);
  });

  it('ends an empty message', () => {
    const { events } = run([b('DATA\r\n.\r\n')]);
    expect(summarize(events)).toEqual(['line:DATA', 'end:0:ok']);
  });

  it('marks oversize, keeps draining to the terminator, and says so at the end', () => {
    const body = `${'a'.repeat(98)}\r\n`.repeat(50); // 5000 octets
    const { events } = run([b(`DATA\r\n${body}.\r\nNOOP\r\n`)], { maxSize: 1000 });
    const s = summarize(events);
    expect(s).toContain('rejected:too-large');
    expect(s).toContain('end:5000:too-large');
    expect(s.at(-1)).toBe('line:NOOP');
  });

  it('never emits more than the limit when oversize', () => {
    const body = 'x'.repeat(5000);
    const { events } = run([b(`DATA\r\n${body}\r\n.\r\n`)], { maxSize: 100 });
    const emitted = events.reduce((n, ev) => n + (ev.type === 'data' ? ev.chunk.length : 0), 0);
    expect(emitted).toBeLessThanOrEqual(100);
  });

  describe.each(SMUGGLING_CASES.map((c) => [c.name, c] as const))('smuggling: %s', (_name, c) => {
    const wire = b(`DATA\r\n${smugglingBody(c.sequence)}\r\n.\r\nQUIT\r\n`);

    it('does not end DATA early, whatever the chunking', () => {
      fc.assert(
        fc.property(fc.array(fc.nat(), { maxLength: 6 }), (cuts) => {
          const s = summarize(run(splitAt(wire, cuts)).events);
          const lines = s.filter((x) => x.startsWith('line:'));
          // Exactly two commands: DATA and the QUIT after the real terminator. The smuggled
          // MAIL/RCPT/DATA never surface as commands.
          expect(lines).toEqual(['line:DATA', 'line:QUIT']);
          const end = s.find((x) => x.startsWith('end:'));
          expect(end?.endsWith(':ok')).toBe(!c.reject);
        }),
        { numRuns: 60 },
      );
    });
  });

  it('only CRLF.CRLF ends DATA: every other two-sided variant stays in DATA', () => {
    for (const c of SMUGGLING_CASES) {
      const { events, reader } = run([b(`DATA\r\nhello${c.sequence}`)]);
      expect(events.some((e) => e.type === 'data-end'), c.name).toBe(false);
      expect(reader.inData, c.name).toBe(true);
    }
  });
});

describe('SmtpLineReader — properties', () => {
  const session = b(
    'EHLO client.example\r\nMAIL FROM:<a@b.example> SIZE=100\r\nRCPT TO:<c@d.example>\r\nDATA\r\n' +
      'Subject: x\r\n\r\n..stuffed\r\nbody line\r\n.\r\nRSET\r\nQUIT\r\n',
  );

  it('arbitrary chunking of a valid session yields the same events', () => {
    const expected = summarize(run([session]).events);
    fc.assert(
      fc.property(fc.array(fc.nat(), { maxLength: 40 }), (cuts) => {
        expect(summarize(run(splitAt(session, cuts)).events)).toEqual(expected);
      }),
      { numRuns: 500 },
    );
  });

  it('never throws and never holds more than one chunk plus one line, on arbitrary bytes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ maxLength: 300 }), { maxLength: 20 }),
        fc.boolean(),
        (chunks, startInData) => {
          const reader = new SmtpLineReader({ maxLineLength: 64 });
          if (startInData) reader.startData({ maxSize: 200 });
          for (const c of chunks) {
            reader.push(c);
            expect(reader.bufferedBytes).toBeLessThanOrEqual(c.length + 64);
            for (let ev = reader.next(); ev; ev = reader.next()) {
              if (ev.type === 'line' && ev.line.toString('latin1') === 'DATA') reader.startData();
            }
            expect(reader.bufferedBytes).toBeLessThanOrEqual(64);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
