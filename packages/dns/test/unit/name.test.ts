import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeName, encodeName, normalizeName } from '../../src/name.js';

const labelArb = fc
  .stringMatching(/^[a-zA-Z0-9-]{1,63}$/)
  .filter((s) => s.length > 0 && s.length <= 63);

describe('encodeName / decodeName round trip', () => {
  it('round-trips arbitrary label sequences within the 255-octet limit', () => {
    fc.assert(
      fc.property(fc.array(labelArb, { minLength: 1, maxLength: 20 }), (labels) => {
        const totalOctets = labels.reduce((sum, l) => sum + l.length + 1, 0) + 1;
        fc.pre(totalOctets <= 255);
        const name = labels.join('.');
        const encoded = encodeName(name);
        const buf = Buffer.concat([Buffer.from(encoded), Buffer.from([0])]).subarray(0, encoded.length);
        const result = decodeName(buf, 0);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.name.toLowerCase()).toBe(name.toLowerCase());
          expect(result.end).toBe(encoded.length);
        }
      }),
    );
  });

  it('round-trips a maximal 63-octet label', () => {
    const label = 'a'.repeat(63);
    const encoded = encodeName(label);
    const result = decodeName(encoded, 0);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.name).toBe(label);
  });

  it('rejects a label over 63 octets', () => {
    expect(() => encodeName('a'.repeat(64))).toThrow(RangeError);
  });

  it('rejects a name over 255 octets', () => {
    const labels = Array.from({ length: 10 }, () => 'a'.repeat(25));
    expect(() => encodeName(labels.join('.'))).toThrow(RangeError);
  });

  it('decodes the root name as "."', () => {
    const result = decodeName(Uint8Array.from([0]), 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe('.');
      expect(result.end).toBe(1);
    }
  });

  it('follows a single compression pointer', () => {
    // Message: [root name at 0][pointer at 1 -> offset 0]
    const buf = Buffer.from([0, 0xc0, 0x00]);
    const result = decodeName(buf, 1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe('.');
      expect(result.end).toBe(3); // consumed the 2-byte pointer, not the target
    }
  });

  it('rejects a self-referencing compression pointer loop', () => {
    // Pointer at offset 0 pointing to itself.
    const buf = Buffer.from([0xc0, 0x00]);
    const result = decodeName(buf, 0);
    expect(result.ok).toBe(false);
  });

  it('rejects a two-hop compression pointer loop (A -> B -> A)', () => {
    // offset 0: pointer -> 2; offset 2: pointer -> 0
    const buf = Buffer.from([0xc0, 0x02, 0xc0, 0x00]);
    const result = decodeName(buf, 0);
    expect(result.ok).toBe(false);
  });

  it('never throws and never hangs on truncated or garbage input', () => {
    const cases = [
      Uint8Array.from([]),
      Uint8Array.from([5]), // claims a 5-byte label but nothing follows
      Uint8Array.from([5, 1, 2, 3]), // truncated label
      Uint8Array.from([0xc0]), // truncated pointer
      Uint8Array.from([0x40, 0, 0, 0]), // reserved label-length prefix (01xxxxxx no, 0x40 = 01000000)
    ];
    for (const buf of cases) {
      const result = decodeName(buf, 0);
      expect(typeof result.ok).toBe('boolean');
    }
  });

  it('rejects an out-of-bounds starting offset', () => {
    const result = decodeName(Uint8Array.from([0]), 5);
    expect(result.ok).toBe(false);
  });
});

describe('normalizeName', () => {
  it('lower-cases and strips a trailing dot', () => {
    expect(normalizeName('Example.COM.')).toBe('example.com');
    expect(normalizeName('example.com')).toBe('example.com');
    expect(normalizeName('.')).toBe('');
  });
});
