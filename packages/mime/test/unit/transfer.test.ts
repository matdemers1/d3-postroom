import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Base64Decoder,
  Base64Encoder,
  QuotedPrintableDecoder,
  decodeBytes,
  encodeBase64,
  encodeQuotedPrintable,
  type TransferDecoder,
} from '../../src/index.js';
import { split } from './helpers.js';

function decodeChunked(decoder: TransferDecoder, input: Uint8Array, cuts: readonly number[]): Buffer {
  const out: Buffer[] = [];
  for (const c of split(input, cuts)) out.push(Buffer.from(decoder.write(c)));
  out.push(decoder.end());
  return Buffer.concat(out);
}

const cutsFor = (maxLen: number): fc.Arbitrary<number[]> => fc.array(fc.nat({ max: Math.max(1, maxLen) }), { maxLength: 12 });

describe('base64', () => {
  it('decodes with whitespace, missing padding, and concatenated blobs', () => {
    const d = (s: string): string => decodeChunked(new Base64Decoder(), Buffer.from(s), []).toString();
    expect(d('aGVs\r\nbG8=')).toBe('hello');
    expect(d('aGVsbG8')).toBe('hello');
    expect(d('aGk=aGk=')).toBe('hihi');
    const bad = new Base64Decoder();
    expect(decodeChunked(bad, Buffer.from('aG*k='), []).toString()).toBe('hi');
    expect(bad.malformed).toBe(true);
  });

  it('round-trips arbitrary bytes under arbitrary chunking', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), cutsFor(3000), (bytes, cuts) => {
        const encoded = Buffer.from(encodeBase64(bytes), 'latin1');
        expect(encoded.toString('latin1').split('\r\n').every((l) => l.length <= 76)).toBe(true);
        const decoder = new Base64Decoder();
        expect(decodeChunked(decoder, encoded, cuts)).toEqual(Buffer.from(bytes));
        expect(decoder.malformed).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('the streaming encoder matches the one-shot encoder under arbitrary chunking', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 1000 }), cutsFor(1000), (bytes, cuts) => {
        const enc = new Base64Encoder();
        const streamed = split(bytes, cuts).map((c) => enc.write(c)).join('') + enc.end();
        expect(streamed).toBe(encodeBase64(bytes));
      }),
      { numRuns: 300 },
    );
  });
});

describe('quoted-printable', () => {
  it('decodes escapes, soft breaks and drops transport whitespace', () => {
    const d = (s: string): string => decodeChunked(new QuotedPrintableDecoder(), Buffer.from(s, 'latin1'), []).toString('latin1');
    expect(d('caf=E9 =3D ok')).toBe('caf\xe9 = ok');
    expect(d('soft=\r\nbreak')).toBe('softbreak');
    expect(d('soft=  \r\nbreak')).toBe('softbreak');
    expect(d('soft=\nbreak')).toBe('softbreak');
    expect(d('trailing   \r\nnext')).toBe('trailing\r\nnext');
    expect(d('lower=e9')).toBe('lower\xe9');
  });

  it('keeps invalid escapes literally and flags them', () => {
    const decoder = new QuotedPrintableDecoder();
    expect(decodeChunked(decoder, Buffer.from('a=ZZb=4'), []).toString()).toBe('a=ZZb=4');
    expect(decoder.malformed).toBe(true);
  });

  it('round-trips arbitrary bytes under arbitrary chunking, lines within 76', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), cutsFor(6000), (bytes, cuts) => {
        const encoded = encodeQuotedPrintable(bytes);
        expect(encoded.split('\r\n').every((l) => l.length <= 76)).toBe(true);
        const decoder = new QuotedPrintableDecoder();
        expect(decodeChunked(decoder, Buffer.from(encoded, 'latin1'), cuts)).toEqual(Buffer.from(bytes));
        expect(decoder.malformed).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trips text with hard line breaks (text mode)', () => {
    const line = fc.string({ unit: fc.constantFrom('a', ' ', '\t', '=', 'é', '.', 'Z'), maxLength: 200 });
    fc.assert(
      fc.property(fc.array(line, { maxLength: 10 }), cutsFor(3000), (lines, cuts) => {
        const text = Buffer.from(lines.join('\r\n'), 'utf8');
        const encoded = encodeQuotedPrintable(text, { binary: false });
        expect(encoded.split('\r\n').every((l) => l.length <= 76)).toBe(true);
        expect(decodeChunked(new QuotedPrintableDecoder(), Buffer.from(encoded, 'latin1'), cuts)).toEqual(text);
      }),
      { numRuns: 300 },
    );
  });
});

describe('whole-buffer charset decoding', () => {
  it('decodes windows-1252 0x80–0x9F correctly (Node 22.13 non-streaming TextDecoder bug)', () => {
    expect(decodeBytes(Buffer.from([0x93, 0x80, 0x94]), 'windows-1252').text).toBe('“€”');
    expect(decodeBytes(Buffer.from([0x93]), 'iso-8859-1').text).toBe('“'); // WHATWG: latin1 is windows-1252
  });
});
