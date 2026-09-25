import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { backoffMs } from '../../src/index.js';

describe('backoff', () => {
  it('stays within [ceiling/2, ceiling] and never exceeds the cap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (attempt, r) => {
        const ms = backoffMs(attempt, 1000, 60_000, () => r);
        const ceiling = Math.min(60_000, 1000 * 2 ** (attempt - 1));
        expect(ms).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
        expect(ms).toBeLessThanOrEqual(ceiling);
      }),
    );
  });
});
