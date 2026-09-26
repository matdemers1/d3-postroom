// The golden replay gate (PST-T-5.5): CI runs fixtures/golden/holdout through the classifier and
// fails if any bucket's precision or recall drops below the floor recorded in
// fixtures/golden/thresholds.json (PST-REQ-107). fixtures/golden/tune is reported for visibility —
// developers may look at it while changing heuristics — but never gates: `tune` and `holdout` are
// generated from disjoint template pools precisely so a heuristic cannot be quietly shaped to fit
// the messages this test reads. See docs/runbooks/calibration.md for the discipline that makes that
// split meaningful (never edit heuristics while looking at a holdout failure).
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
}

interface HoldoutBucketResult extends BucketResult {
  thresholdPrecision: number | null;
  thresholdRecall: number | null;
  precisionOk: boolean;
  recallOk: boolean;
}

interface ReplaySummary {
  ok: boolean;
  holdout: { buckets: HoldoutBucketResult[]; total: number };
  tune: { buckets: BucketResult[]; total: number };
}

function runReplay(): ReplaySummary {
  // replay.mjs exits 1 when a holdout bucket is below threshold; execFileSync would throw on that
  // exit code, so run it and read stdout off the result whichever way it exits, then assert in-test
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
  it('holdout meets every bucket\'s recorded precision/recall threshold', () => {
    let summary: ReplaySummary;
    try {
      summary = runReplay();
    } catch (err) {
      // execFileSync throws when the child exits non-zero; its stdout is still on the error object.
      const stdout = (err as { stdout?: string }).stdout;
      if (stdout === undefined) throw err;
      summary = JSON.parse(stdout.trim().split('\n').pop() as string) as ReplaySummary;
    }

    const tuneTable = summary.tune.buckets.map((b) => `${b.bucket}: precision ${pct(b.precision)}, recall ${pct(b.recall)}`).join('\n');
    console.log(`golden replay — tune, informational only (${summary.tune.total} messages):\n${tuneTable}`);

    const holdoutTable = summary.holdout.buckets
      .map((b) => `${b.bucket}: precision ${pct(b.precision)} (>= ${pct(b.thresholdPrecision ?? 0)}), recall ${pct(b.recall)} (>= ${pct(b.thresholdRecall ?? 0)})`)
      .join('\n');
    console.log(`golden replay — holdout, gates CI (${summary.holdout.total} messages):\n${holdoutTable}`);

    const failing = summary.holdout.buckets.filter((b) => !b.precisionOk || !b.recallOk);
    expect(failing, `holdout bucket(s) below threshold:\n${failing.map((b) => `  ${b.bucket}: precision ${pct(b.precision)}, recall ${pct(b.recall)}`).join('\n')}`).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(summary.holdout.total).toBeGreaterThan(0);
    expect(summary.tune.total).toBeGreaterThan(0);
  });
});
