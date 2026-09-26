#!/usr/bin/env node
// Replays every regression fixture through its target's fuzz() function and asserts none of them
// crash it again (PST-T-4.2 / PST-REQ-088). Run as part of `pnpm fuzz:smoke`, so a fixed crasher
// that regresses fails CI on the very next push, not only on the next nightly run.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { activeTargets } from '../fuzz/registry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

let total = 0;
let failed = 0;
for (const t of activeTargets(root)) {
  const fixturesDir = join(root, t.fixtures);
  if (!existsSync(fixturesDir)) continue;
  const files = readdirSync(fixturesDir).filter((f) => f !== 'README.md' && f !== '.gitkeep');
  if (files.length === 0) continue;

  const mod = await import(pathToFileURL(join(root, t.target)).href);
  if (typeof mod.fuzz !== 'function') {
    console.error(`fuzz-replay: ${t.target} does not export fuzz()`);
    failed++;
    continue;
  }
  for (const f of files) {
    total++;
    const data = readFileSync(join(fixturesDir, f));
    try {
      mod.fuzz(data);
    } catch (err) {
      failed++;
      console.error(`fuzz-replay: ${t.name}/${f} still crashes`);
      console.error(err);
    }
  }
}

console.log(`fuzz-replay: ${total} fixture(s) replayed, ${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
