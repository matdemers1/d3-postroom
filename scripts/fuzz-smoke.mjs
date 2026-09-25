#!/usr/bin/env node
// CI's fuzz-smoke stage: run every harness under fuzz/<name>/smoke.mjs for a short, seeded burst.
// The nightly job (PST-T-4.2) runs the same harnesses coverage-guided for real.
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'fuzz');
const harnesses = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'smoke.mjs')))
  .map((d) => d.name);
if (harnesses.length === 0) {
  console.log('fuzz-smoke: no harnesses yet (the first parser arrives in PST-T-1.1)');
  process.exit(0);
}
let failed = 0;
for (const name of harnesses) {
  const run = spawnSync(process.execPath, [join(root, name, 'smoke.mjs')], { stdio: 'inherit', env: { ...process.env, FUZZ_SEED: '424242' } });
  if (run.status !== 0) { failed++; console.error(`fuzz-smoke: ${name} failed`); }
}
process.exit(failed === 0 ? 0 : 1);
