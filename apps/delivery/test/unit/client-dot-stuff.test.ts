// The streaming DATA encoder: CRLF normalisation, dot-stuffing across chunk boundaries, termination.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DotStuffer } from '../../src/client/dot-stuff.js';

function encode(chunks: string[]): string {
  const s = new DotStuffer();
  let out = '';
  for (const c of chunks) out += s.push(Buffer.from(c, 'latin1')).toString('latin1');
  return out + s.end().toString('latin1');
}

/** What a receiving MX does: split on CRLF, stop at '.', strip one leading dot. */
function unstuff(wire: string): string {
  const lines = wire.split('\r\n');
  const out: string[] = [];
  for (const line of lines) {
    if (line === '.') break;
    out.push(line.startsWith('.') ? line.slice(1) : line);
  }
  return out.map((l) => `${l}\r\n`).join('');
}

describe('DotStuffer', () => {
  it('stuffs a leading dot and terminates with CRLF.CRLF', () => {
    expect(encode(['a\r\n.b\r\n..c\r\n'])).toBe('a\r\n..b\r\n...c\r\n.\r\n');
  });

  it('stuffs a dot that starts a line across a chunk boundary', () => {
    expect(encode(['a\r', '\n', '.', 'b\r\n'])).toBe('a\r\n..b\r\n.\r\n');
    expect(encode(['a\r\n', '.\r\n'])).toBe('a\r\n..\r\n.\r\n');
  });

  it('turns bare LF and bare CR into CRLF (no smuggled <LF>.<LF>)', () => {
    expect(encode(['a\n.\nb\rc'])).toBe('a\r\n..\r\nb\r\nc\r\n.\r\n');
  });

  it('adds the missing final line end, and handles an empty body', () => {
    expect(encode(['no newline'])).toBe('no newline\r\n.\r\n');
    expect(encode(['ends in CR\r'])).toBe('ends in CR\r\n.\r\n');
    expect(encode([])).toBe('.\r\n');
  });

  it('round-trips any CRLF body through a receiver, however it is chunked', () => {
    const line = fc.stringMatching(/^[.a-z ]{0,12}$/);
    fc.assert(fc.property(fc.array(line, { maxLength: 20 }), fc.array(fc.nat(40), { maxLength: 8 }), (lines, cuts) => {
      const body = lines.map((l) => `${l}\r\n`).join('');
      const points = [...new Set(cuts.map((c) => c % (body.length + 1)))].sort((a, b) => a - b);
      const chunks: string[] = [];
      let prev = 0;
      for (const p of points) { chunks.push(body.slice(prev, p)); prev = p; }
      chunks.push(body.slice(prev));
      const wire = encode(chunks);
      expect(wire.endsWith('\r\n.\r\n') || wire === '.\r\n').toBe(true);
      expect(wire.slice(0, -3).split('\r\n').includes('.')).toBe(false);
      expect(unstuff(wire)).toBe(body);
    }));
  });
});
