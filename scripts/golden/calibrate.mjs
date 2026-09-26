#!/usr/bin/env node
// Runs the same classify-and-score engine as scripts/golden/replay.mjs against a local, gitignored
// calibration corpus of real mail (PST-REQ-108). Never touches the repository: it only reads the
// corpus directory and prints a table, the same shape replay.mjs prints for fixtures/golden. There
// is no `--write-thresholds` here on purpose — a real inbox's precision/recall is a data point for
// the operator, never a number that gets written back into the committed fixtures/golden thresholds.
//
// Usage:
//   node scripts/golden/calibrate.mjs [corpusDir]
//   POSTROOM_CORPUS=/path/to/corpus node scripts/golden/calibrate.mjs
//
// Corpus layout (default `corpus/`, relative to the repo root):
//   corpus/
//     labels.json         — [{ file, expectedRuleBucket, account, authVerdicts, envelopeFrom? }, ...]
//                            same shape as a fixtures/golden/manifest.json entry, minus the seed
//                            metadata; expectedRuleBucket is one of 'priority' | 'people' | 'other'
//     *.eml                — the messages labels.json refers to by `file`
//
// See docs/runbooks/calibration.md for how to build labels.json from a real mailbox without ever
// committing the messages themselves.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runGolden } from './lib.mjs';

function fmt(n) {
  return (n * 100).toFixed(1) + '%';
}

async function main() {
  const corpusDir = resolve(process.argv[2] ?? process.env.POSTROOM_CORPUS ?? 'corpus');
  const labelsPath = join(corpusDir, 'labels.json');

  if (!existsSync(corpusDir) || !existsSync(labelsPath)) {
    console.error(`calibrate: no corpus found at ${corpusDir} (expected ${labelsPath}).`);
    console.error('See docs/runbooks/calibration.md — this reads a local, gitignored corpus only; nothing here is committed.');
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(labelsPath, 'utf8'));
  const { metrics, buckets, perMessage } = await runGolden(corpusDir, manifest);

  console.log(`calibrate: ${manifest.length} message(s) from ${corpusDir}, ${buckets.length} bucket(s)\n`);
  console.log('bucket'.padEnd(14) + 'precision'.padEnd(14) + 'recall'.padEnd(14) + 'tp/fp/fn');
  for (const bucket of buckets) {
    const m = metrics[bucket];
    console.log(bucket.padEnd(14) + fmt(m.precision).padEnd(14) + fmt(m.recall).padEnd(14) + `${m.tp}/${m.fp}/${m.fn}`);
  }

  const mismatches = perMessage.filter((m) => m.expected !== m.actual);
  if (mismatches.length > 0) {
    console.log(`\n${mismatches.length} mismatch(es):`);
    for (const m of mismatches) console.log(`  ${m.file}: expected ${m.expected}, got ${m.actual}`);
  }

  // Informational only — calibration against a real mailbox never fails a build.
  process.exit(0);
}

await main();
