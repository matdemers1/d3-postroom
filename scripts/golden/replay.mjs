#!/usr/bin/env node
// Replays fixtures/golden through the classifier and checks each bucket's precision/recall against
// fixtures/golden/thresholds.json (PST-T-5.5, PST-REQ-107). Used two ways:
//
//   node scripts/golden/replay.mjs               — print the table, exit 1 if any bucket regresses
//   node scripts/golden/replay.mjs --json         — print one JSON summary line instead, same exit code
//   node scripts/golden/replay.mjs --write-thresholds  — overwrite thresholds.json with today's
//                                                         measured metrics (bootstrapping only —
//                                                         lowering a threshold this way is still a
//                                                         reviewed diff, since the file is committed)
//
// packages/classifier/test/golden/replay.test.ts shells out to this script with --json so CI's
// normal `pnpm test` fails the same way a manual run would.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGolden } from './lib.mjs';

const goldenDir = fileURLToPath(new URL('../../fixtures/golden/', import.meta.url));
const thresholdsPath = join(goldenDir, 'thresholds.json');

async function loadManifest() {
  const raw = await readFile(join(goldenDir, 'manifest.json'), 'utf8');
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

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const writeThresholds = args.includes('--write-thresholds');

  const manifest = await loadManifest();
  const { metrics, buckets } = await runGolden(goldenDir, manifest);
  const thresholds = await loadThresholds();

  if (writeThresholds) {
    const out = {
      note:
        'Per-bucket precision/recall floors for the fixtures/golden replay (PST-REQ-107). Bootstrapped ' +
        'from the current classifier by `node scripts/golden/replay.mjs --write-thresholds`. Lowering ' +
        'any value here is a reviewed change — see docs/runbooks/calibration.md.',
      buckets: {},
    };
    for (const bucket of buckets) {
      out.buckets[bucket] = { precision: round(metrics[bucket].precision), recall: round(metrics[bucket].recall) };
    }
    await writeFile(thresholdsPath, JSON.stringify(out, null, 2) + '\n');
    console.log(`replay: wrote thresholds for ${buckets.length} bucket(s) to ${thresholdsPath}`);
    return;
  }

  let ok = true;
  const rows = [];
  for (const bucket of buckets) {
    const m = metrics[bucket];
    const floor = thresholds.buckets?.[bucket] ?? null;
    const precisionOk = floor === null || m.precision >= floor.precision;
    const recallOk = floor === null || m.recall >= floor.recall;
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

  if (asJson) {
    console.log(JSON.stringify({ ok, buckets: rows, total: manifest.length }));
  } else {
    console.log(`golden replay: ${manifest.length} message(s), ${buckets.length} bucket(s)\n`);
    console.log('bucket'.padEnd(14) + 'precision'.padEnd(22) + 'recall'.padEnd(22) + 'status');
    for (const r of rows) {
      const precisionCell = `${fmt(r.precision)}${r.thresholdPrecision !== null ? ` (>= ${fmt(r.thresholdPrecision)})` : ''}`;
      const recallCell = `${fmt(r.recall)}${r.thresholdRecall !== null ? ` (>= ${fmt(r.thresholdRecall)})` : ''}`;
      const status = r.precisionOk && r.recallOk ? 'pass' : 'FAIL';
      console.log(r.bucket.padEnd(14) + precisionCell.padEnd(22) + recallCell.padEnd(22) + status);
    }
    console.log(ok ? '\ngolden replay: all buckets meet their threshold' : '\ngolden replay: at least one bucket fell below its threshold');
  }

  process.exit(ok ? 0 : 1);
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}

await main();
