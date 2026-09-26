#!/usr/bin/env node
// Replays fixtures/golden/{tune,holdout} through the classifier (PST-T-5.5, PST-REQ-107).
//
// `tune` is reported for visibility only — developers may look at it while changing heuristics, so
// it is never allowed to gate anything. `holdout` is generated from a disjoint template pool (see
// scripts/golden/generate.mjs and docs/runbooks/calibration.md) and is the only split checked
// against fixtures/golden/thresholds.json.
//
//   node scripts/golden/replay.mjs                    — print both tables, exit 1 if holdout regresses
//   node scripts/golden/replay.mjs --json              — print one JSON summary line instead, same exit code
//   node scripts/golden/replay.mjs --write-thresholds  — overwrite thresholds.json with today's
//                                                         measured HOLDOUT metrics only (bootstrapping —
//                                                         lowering a threshold this way is still a
//                                                         reviewed diff, since the file is committed;
//                                                         see docs/runbooks/calibration.md for the
//                                                         rule against doing this while staring at a
//                                                         holdout failure)
//
// packages/classifier/test/golden/replay.test.ts shells out to this script with --json so CI's
// normal `pnpm test` fails the same way a manual run would.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGolden } from './lib.mjs';

const goldenRoot = fileURLToPath(new URL('../../fixtures/golden/', import.meta.url));
const thresholdsPath = join(goldenRoot, 'thresholds.json');

async function loadManifest(split) {
  const raw = await readFile(join(goldenRoot, split, 'manifest.json'), 'utf8');
  return JSON.parse(raw).entries;
}

async function loadThresholds() {
  try {
    const raw = await readFile(thresholdsPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { buckets: {} };
    throw err;
  }
}

function fmt(n) {
  return (n * 100).toFixed(1) + '%';
}

// Round DOWN, not to nearest: a threshold bootstrapped from today's measurement must never end up
// numerically above the very value it was bootstrapped from (a `>=` comparison against a value
// rounded *up* would fail on the same run that just produced it).
function floorTo4(n) {
  return Math.floor(n * 10000) / 10000;
}

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const writeThresholds = args.includes('--write-thresholds');

  const tuneManifest = await loadManifest('tune');
  const holdoutManifest = await loadManifest('holdout');
  const tuneRun = await runGolden(join(goldenRoot, 'tune'), tuneManifest);
  const holdoutRun = await runGolden(join(goldenRoot, 'holdout'), holdoutManifest);
  const thresholds = await loadThresholds();

  if (writeThresholds) {
    const out = {
      note:
        'Per-bucket precision/recall floors for the fixtures/golden/holdout replay (PST-REQ-107). ' +
        'Bootstrapped from the current classifier by `node scripts/golden/replay.mjs --write-thresholds`. ' +
        'Recorded from `holdout` only — `tune` is informational and never gates. Lowering any value ' +
        'here is a reviewed change made because the classifier changed, never to make a failing PR ' +
        'pass while looking at which holdout messages are failing — see docs/runbooks/calibration.md.',
      buckets: {},
    };
    for (const bucket of holdoutRun.buckets) {
      out.buckets[bucket] = { precision: floorTo4(holdoutRun.metrics[bucket].precision), recall: floorTo4(holdoutRun.metrics[bucket].recall) };
    }
    await writeFile(thresholdsPath, JSON.stringify(out, null, 2) + '\n');
    console.log(`replay: wrote holdout thresholds for ${holdoutRun.buckets.length} bucket(s) to ${thresholdsPath}`);
    return;
  }

  function scoreRows(run) {
    const rows = [];
    let ok = true;
    for (const bucket of run.buckets) {
      const m = run.metrics[bucket];
      const floor = thresholds.buckets?.[bucket] ?? null;
      const precisionOk = floor !== null && m.precision >= floor.precision;
      const recallOk = floor !== null && m.recall >= floor.recall;
      if (!precisionOk || !recallOk) ok = false;
      rows.push({
        bucket,
        tp: m.tp,
        fp: m.fp,
        fn: m.fn,
        precision: m.precision,
        recall: m.recall,
        thresholdPrecision: floor?.precision ?? null,
        thresholdRecall: floor?.recall ?? null,
        precisionOk,
        recallOk,
      });
    }
    return { rows, ok };
  }

  // holdout is gated (a missing threshold fails, per the earlier fix — an unmeasured bucket must
  // never pass silently); tune is reported with the same table shape but never gates, so its rows
  // carry no threshold at all.
  const { rows: holdoutRows, ok: holdoutOk } = scoreRows(holdoutRun);
  const tuneRows = tuneRun.buckets.map((bucket) => {
    const m = tuneRun.metrics[bucket];
    return { bucket, tp: m.tp, fp: m.fp, fn: m.fn, precision: m.precision, recall: m.recall };
  });

  if (asJson) {
    console.log(
      JSON.stringify({
        ok: holdoutOk,
        holdout: { buckets: holdoutRows, total: holdoutManifest.length },
        tune: { buckets: tuneRows, total: tuneManifest.length },
      }),
    );
  } else {
    console.log(`golden replay — tune (informational only, ${tuneManifest.length} messages):\n`);
    console.log('bucket'.padEnd(16) + 'precision'.padEnd(12) + 'recall'.padEnd(12));
    for (const r of tuneRows) console.log(r.bucket.padEnd(16) + fmt(r.precision).padEnd(12) + fmt(r.recall).padEnd(12));

    console.log(`\ngolden replay — holdout (gates CI, ${holdoutManifest.length} messages):\n`);
    console.log('bucket'.padEnd(16) + 'precision'.padEnd(22) + 'recall'.padEnd(22) + 'status');
    for (const r of holdoutRows) {
      const precisionCell = `${fmt(r.precision)}${r.thresholdPrecision !== null ? ` (>= ${fmt(r.thresholdPrecision)})` : ' (no threshold)'}`;
      const recallCell = `${fmt(r.recall)}${r.thresholdRecall !== null ? ` (>= ${fmt(r.thresholdRecall)})` : ' (no threshold)'}`;
      const status = r.precisionOk && r.recallOk ? 'pass' : 'FAIL';
      console.log(r.bucket.padEnd(16) + precisionCell.padEnd(22) + recallCell.padEnd(22) + status);
    }
    console.log(holdoutOk ? '\ngolden replay: holdout meets every threshold' : '\ngolden replay: holdout fell below at least one threshold');
  }

  process.exit(holdoutOk ? 0 : 1);
}

await main();
