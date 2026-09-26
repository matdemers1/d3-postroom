#!/usr/bin/env node
// The nightly coverage-guided fuzz run (PST-T-4.2 / PST-REQ-088): runs `jazzer` against
// fuzz/<name>/target.mjs, seeded from fuzz/<name>/corpus, for a bounded time per target. Interesting
// inputs are written back into corpus/; any crash is left as `crash-*` in the working directory for
// the caller (CI's fuzz.yml, or a person running this locally) to turn into a fixture — see
// docs/runbooks/fuzz-crasher.md. Never fuzzes a pending target: there is nothing built yet to call.
//
// Usage:
//   node scripts/fuzz-nightly.mjs                    # every active target, FUZZ_SECONDS each
//   node scripts/fuzz-nightly.mjs smtp-proto          # just one target
//   node scripts/fuzz-nightly.mjs smtp-proto --seconds=600
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeTargets } from '../fuzz/registry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));
const secondsArg = args.find((a) => a.startsWith('--seconds='));
const seconds = secondsArg ? Number(secondsArg.slice('--seconds='.length)) : Number(process.env.FUZZ_SECONDS ?? 600);

const targets = activeTargets(root).filter((t) => !only || t.name === only);
if (targets.length === 0) {
  console.error(`fuzz-nightly: no active target matches "${only ?? '(all)'}" — see fuzz/targets.json`);
  process.exit(1);
}

let failed = 0;
for (const t of targets) {
  const corpusDir = join(root, t.corpus);
  mkdirSync(corpusDir, { recursive: true });
  const targetPath = join(root, t.target);
  console.log(`fuzz-nightly: ${t.name} for ${seconds}s (corpus: ${t.corpus})`);
  const started = Date.now();
  const run = spawnSync('npx', ['jazzer', targetPath, corpusDir, '--', `-max_total_time=${seconds}`], {
    stdio: 'inherit',
    cwd: root,
    env: process.env,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (run.status !== 0) {
    failed++;
    console.error(`fuzz-nightly: ${t.name} found a crash or failed after ${elapsed}s (exit ${run.status})`);
  } else {
    console.log(`fuzz-nightly: ${t.name} ok after ${elapsed}s`);
  }
}
process.exit(failed === 0 ? 0 : 1);
