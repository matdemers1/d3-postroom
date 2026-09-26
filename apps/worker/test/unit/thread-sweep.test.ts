// PST-T-3.14: the sweep's bounds are named constants, not magic numbers scattered where it's
// scheduled, so a review of this file alone confirms the defaults doneWhen implies (a small grace
// period, a bounded batch).
import { describe, expect, it } from 'vitest';
import { DEFAULT_SWEEP_GRACE_MS, DEFAULT_SWEEP_LIMIT } from '../../src/sweep/thread-sweep.js';

describe('thread sweep defaults (PST-T-3.14)', () => {
  it('is bounded per run', () => {
    expect(DEFAULT_SWEEP_LIMIT).toBe(200);
  });

  it('waits a small grace period before touching a freshly filed row', () => {
    expect(DEFAULT_SWEEP_GRACE_MS).toBe(30_000);
  });
});
