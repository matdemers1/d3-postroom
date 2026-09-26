// Modified UTF-7 (RFC 3501 §5.1.3) and sequence sets (normalisation, compaction).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeMailboxName,
  encodeMailboxName,
  formatSequenceSet,
  normalizeSequenceSet,
  parseSequenceSet,
  sequenceSetFromNumbers,
  sequenceSetHas,
} from '../../src/index.js';
import { sequenceSet } from './arbitraries.js';

describe('modified UTF-7', () => {
  it('encodes and decodes the RFC 3501 example', () => {
    expect(encodeMailboxName('~peter/mail/台北/日本語')).toBe('~peter/mail/&U,BTFw-/&ZeVnLIqe-');
    expect(decodeMailboxName('~peter/mail/&U,BTFw-/&ZeVnLIqe-')).toBe('~peter/mail/台北/日本語');
    expect(encodeMailboxName('Tom & Jerry')).toBe('Tom &- Jerry');
    expect(encodeMailboxName('Entwürfe')).toBe('Entw&APw-rfe');
    expect(encodeMailboxName('😀')).toBe('&2D3eAA-');
  });

  it('round-trips arbitrary Unicode, including astral characters', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 30 }), (name) => {
        const wire = encodeMailboxName(name);
        expect(wire).toMatch(/^[\x20-\x7e]*$/);
        expect(decodeMailboxName(wire)).toBe(name);
      }),
      { numRuns: 3000 },
    );
  });

  it('round-trips arbitrary UTF-16 code units, lone surrogates included', () => {
    const unit = fc.integer({ min: 0, max: 0xffff }).map((u) => String.fromCharCode(u));
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 20 }), (name) => {
        expect(decodeMailboxName(encodeMailboxName(name))).toBe(name);
      }),
      { numRuns: 3000 },
    );
  });

  it('has exactly one spelling per name: decode(x) = n implies encode(n) = x', () => {
    const wireChar = fc.constantFrom(...'&-ABCZaz09+,/ .'.split(''));
    fc.assert(
      fc.property(fc.string({ unit: wireChar, maxLength: 16 }), (wire) => {
        const name = decodeMailboxName(wire);
        if (name !== null) expect(encodeMailboxName(name)).toBe(wire);
      }),
      { numRuns: 5000 },
    );
  });

  it.each([
    ['&', 'unterminated shift'],
    ['&Jjo', 'unterminated shift'],
    ['&AGE-', 'shifted printable ASCII'],
    ['&U,BTFw-&ZeVnLIqe-', 'two adjacent shifted runs'],
    ['&U,BTFx-', 'non-zero leftover bits'],
    ['&AA-', 'odd octet count'],
    ['a\tb', 'raw control character'],
    ['café', 'raw 8-bit character'],
    ['&U/BTFw-', '"/" instead of ","'],
  ])('refuses %j (%s)', (wire) => {
    expect(decodeMailboxName(wire)).toBeNull();
  });
});

describe('sequence sets', () => {
  const max = fc.integer({ min: 0, max: 60 });
  const smallSet = fc
    .array(
      fc.record({
        from: fc.oneof(fc.integer({ min: 1, max: 70 }), fc.constant('*' as const)),
        to: fc.oneof(fc.integer({ min: 1, max: 70 }), fc.constant('*' as const)),
      }),
      { minLength: 1, maxLength: 6 },
    )
    .map((ranges) => ({ type: 'set' as const, ranges }));

  it('normalisation names exactly the members, sorted, merged and disjoint', () => {
    fc.assert(
      fc.property(smallSet, max, (set, m) => {
        const norm = normalizeSequenceSet(set, m);
        const expanded = new Set<number>();
        for (const [lo, hi] of norm) for (let n = lo; n <= hi; n++) expanded.add(n);
        for (let n = 1; n <= 80; n++) expect(expanded.has(n)).toBe(sequenceSetHas(set, n, m));
        for (let i = 1; i < norm.length; i++) {
          const prev = norm[i - 1];
          const cur = norm[i];
          if (prev && cur) expect(cur[0]).toBeGreaterThan(prev[1] + 1);
        }
        for (const [lo, hi] of norm) expect(lo).toBeLessThanOrEqual(hi);
      }),
      { numRuns: 2000 },
    );
  });

  it('"*" in an empty mailbox names nothing; "n:*" includes the largest even when below n', () => {
    expect(normalizeSequenceSet({ type: 'set', ranges: [{ from: '*', to: '*' }] }, 0)).toEqual([]);
    expect(normalizeSequenceSet({ type: 'set', ranges: [{ from: 50, to: '*' }] }, 10)).toEqual([[10, 50]]);
    expect(normalizeSequenceSet({ type: 'set', ranges: [{ from: 4, to: 2 }, { from: 3, to: 7 }, { from: 9, to: 9 }] }, 20)).toEqual([
      [2, 7],
      [9, 9],
    ]);
  });

  it('formats and parses back', () => {
    fc.assert(
      fc.property(sequenceSet, (set) => {
        expect(parseSequenceSet(formatSequenceSet(set))).toEqual(set);
      }),
    );
    expect(parseSequenceSet('0')).toBeNull();
    expect(parseSequenceSet('1:2:3')).toBeNull();
    expect(parseSequenceSet('1,,2')).toBeNull();
    expect(parseSequenceSet('01')).toBeNull();
  });

  it('compacts a list of numbers into the smallest set naming exactly them', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 200 }), { maxLength: 40 }), (nums) => {
        const set = sequenceSetFromNumbers(nums);
        const norm = normalizeSequenceSet(set, 0);
        const back = norm.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
        expect(back).toEqual([...new Set(nums)].sort((a, b) => a - b));
        expect(set.type === 'set' && set.ranges.length).toBe(norm.length);
      }),
    );
    expect(formatSequenceSet(sequenceSetFromNumbers([5, 1, 2, 3, 9, 10]))).toBe('1:3,5,9:10');
  });
});
