// PST-T-9.2: a performance regression test for the hand-written Markdown renderer. An adversarial
// verifier reproduced quadratic worst cases in the previous, regex-on-a-shrinking-slice
// implementation — 100 KB of `[` took ~4.0s, with lesser quadratic behaviour on long `*` runs and
// repeated `[text](url)` shapes. renderMarkdown now precomputes O(1) "next occurrence" lookup
// tables once per inline run, so every position is visited a bounded number of times. These cases
// must render in a small, roughly-linear fraction of a second, and the per-size timings must grow
// sub-quadratically (doubling the input size should not come close to quadrupling the time).
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/compose/markdown.js';

/** Wall-clock time (ms) to render `source`. */
function timeRender(source: string): number {
  const start = performance.now();
  renderMarkdown(source);
  return performance.now() - start;
}

describe('renderMarkdown: performance (PST-T-9.2)', () => {
  const adversarial: { name: string; make: (n: number) => string }[] = [
    { name: '100 KB of "["', make: (n) => '['.repeat(n) },
    { name: '100 KB of "*"', make: (n) => '*'.repeat(n) },
    { name: '100 KB of "[a](" repeated', make: (n) => '[a]('.repeat(Math.ceil(n / 4)) },
    { name: '100 KB of "_a" alternating', make: (n) => '_a'.repeat(Math.ceil(n / 2)) },
    { name: '100 KB of "`"', make: (n) => '`'.repeat(n) },
  ];

  for (const c of adversarial) {
    it(`renders ${c.name} in well under the CI budget`, () => {
      const source = c.make(100_000);
      const ms = timeRender(source);
      console.log(`[perf] ${c.name}: ${ms.toFixed(1)}ms for ${source.length} chars`);
      expect(ms).toBeLessThan(500);
    });
  }

  for (const c of adversarial) {
    it(`grows sub-quadratically with input size for ${c.name}`, () => {
      const sizes = [10_000, 20_000, 40_000, 80_000];
      // Repeat and take the best-of-3 per size to smooth out GC/JIT noise on a shared CI runner —
      // real quadratic behaviour (a ~4x cost per doubling) shows up reliably even in a minimum;
      // one-off scheduler hiccups do not.
      const timings = sizes.map((size) => Math.min(timeRender(c.make(size)), timeRender(c.make(size)), timeRender(c.make(size))));
      console.log(`[perf] ${c.name}: ${sizes.map((s, idx) => `${String(s)}=${(timings[idx] ?? 0).toFixed(1)}ms`).join(', ')}`);
      // Doubling the input should cost well under a quadratic 4x — allow generous headroom (3x) for
      // noise, and a floor so sub-millisecond timings don't make the ratio meaningless.
      for (let i = 1; i < timings.length; i += 1) {
        const prev = Math.max(timings[i - 1] ?? 0, 1);
        const curr = timings[i] ?? 0;
        expect(curr / prev).toBeLessThan(3);
      }
    });
  }
});
