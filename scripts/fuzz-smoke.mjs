#!/usr/bin/env node
// CI's fuzz-smoke stage: run every harness under fuzz/<name>/smoke.mjs for a short, seeded burst,
// replay every regression fixture (PST-T-4.2) through its jazzer target, and check the fuzz
// registry (fuzz/targets.json) hasn't drifted from the packages that actually exist. The nightly
// job (fuzz.yml) runs the jazzer targets themselves, coverage-guided, for real.
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { checkPendingTargetsHaveNoUnharnessedSource } from '../fuzz/registry.mjs';

const projectRoot = join(import.meta.dirname, '..');
const root = join(projectRoot, 'fuzz');
const harnesses = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'smoke.mjs')))
  .map((d) => d.name);

let failed = 0;

if (harnesses.length === 0) {
  console.log('fuzz-smoke: no fast-check harnesses yet (the first parser arrives in PST-T-1.1)');
} else {
  for (const name of harnesses) {
    const run = spawnSync(process.execPath, [join(root, name, 'smoke.mjs')], {
      stdio: 'inherit',
      env: { ...process.env, FUZZ_SEED: process.env.FUZZ_SEED ?? '424242' },
    });
    if (run.status !== 0) {
      failed++;
      console.error(`fuzz-smoke: ${name} failed`);
    }
  }
}

// Every fixture left by a past crasher must stay fixed.
const replay = spawnSync(process.execPath, [join(projectRoot, 'scripts', 'fuzz-replay.mjs')], { stdio: 'inherit' });
if (replay.status !== 0) {
  failed++;
  console.error('fuzz-smoke: fuzz-replay failed');
}

// The registry must not silently fall behind: a pending parser that grew a src/ needs a harness.
const problems = checkPendingTargetsHaveNoUnharnessedSource(projectRoot);
if (problems.length > 0) {
  failed++;
  console.error('fuzz-smoke: fuzz registry check failed:');
  for (const p of problems) console.error(`  - ${p}`);
} else {
  console.log('fuzz-smoke: registry check ok (no pending parser has grown an unharnessed src/)');
}

process.exit(failed === 0 ? 0 : 1);
