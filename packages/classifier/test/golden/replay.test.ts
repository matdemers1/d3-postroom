// The golden replay gate (PST-T-5.5): CI runs the ~200-message synthetic set in fixtures/golden/
// through the classifier and fails if any bucket's precision or recall drops below the floor
// recorded in fixtures/golden/thresholds.json (PST-REQ-107). This is what makes `pnpm test` fail on
// a real regression, not just on the doneWhen check run by hand.
//
// The actual classify/parse/metrics engine lives in scripts/golden/lib.mjs and is invoked here via
// scripts/golden/replay.mjs, so `pnpm --filter @postroom/classifier test` (CI's unit stage) and a
// manual `node scripts/golden/replay.mjs` run the exact same code — there is no second copy of the
// scoring logic to drift out of sync with the one CI gates on.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const replayScript = fileURLToPath(new URL('../../../../scripts/golden/replay.mjs', import.meta.url));

interface BucketResult {
  bucket: string;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  thresholdPrecision: number | null;
  thresholdRecall: number | null;
  precisionOk: boolean;
  recallOk: boolean;
}

interface ReplaySummary {
  ok: boolean;
  buckets: BucketResult[];
  total: number;
}

function runReplay(): ReplaySummary {
  // replay.mjs exits 1 when a bucket is below threshold; execFileSync would throw on that exit
  // code, so run it and read stdout off the result whichever way it exits, then assert in-test
  // (a thrown exit code without a message would tell the test "it failed" without saying why).
  const result = execFileSync(process.execPath, [replayScript, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(result.trim().split('\n').pop() as string) as ReplaySummary;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

describe('golden replay (PST-REQ-107)', () => {
  it('meets every bucket\'s recorded precision/recall threshold', () => {
    let summary: ReplaySummary;
    try {
      summary = runReplay();
    } catch (err) {
      // execFileSync throws when the child exits non-zero; its stdout is still on the error object.
      const stdout = (err as { stdout?: string }).stdout;
      if (stdout === undefined) throw err;
      summary = JSON.parse(stdout.trim().split('\n').pop() as string) as ReplaySummary;
    }

    const table = summary.buckets
      .map((b) => `${b.bucket}: precision ${pct(b.precision)} (>= ${pct(b.thresholdPrecision ?? 0)}), recall ${pct(b.recall)} (>= ${pct(b.thresholdRecall ?? 0)})`)
      .join('\n');
    console.log(`golden replay (${summary.total} messages):\n${table}`);

    const failing = summary.buckets.filter((b) => !b.precisionOk || !b.recallOk);
    expect(failing, `bucket(s) below threshold:\n${failing.map((b) => `  ${b.bucket}: precision ${pct(b.precision)}, recall ${pct(b.recall)}`).join('\n')}`).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(summary.total).toBeGreaterThanOrEqual(200);
  });
});
