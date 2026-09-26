// Shared registry loader for PST-T-4.2 / PST-REQ-088 (fuzz-nightly, fuzz-replay, fuzz-smoke).
// fuzz/targets.json is the one list of every parser: `active` rows are fuzzed for real, `pending`
// rows name the package that has not been built yet so the registry-check step in fuzz-smoke can
// notice the day it grows a src/ without also growing a harness here.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function loadRegistry(root) {
  const raw = JSON.parse(readFileSync(join(root, 'fuzz', 'targets.json'), 'utf8'));
  return raw.targets;
}

export function activeTargets(root) {
  return loadRegistry(root).filter((t) => t.status === 'active');
}

export function pendingTargets(root) {
  return loadRegistry(root).filter((t) => t.status !== 'active');
}

/**
 * Returns a human message for every pending target whose package now has a non-empty `src/` but
 * no harness registered — the trap the check exists to catch.
 */
export function checkPendingTargetsHaveNoUnharnessedSource(root) {
  const problems = [];
  for (const t of pendingTargets(root)) {
    const srcDir = join(root, t.package, 'src');
    if (!existsSync(srcDir)) continue;
    const files = readdirSync(srcDir, { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.ts'));
    if (files.length === 0) continue;
    problems.push(
      `${t.name}: ${t.package}/src now has ${files.length} file(s) but fuzz/targets.json still lists it as "${t.status}" with no harness — add fuzz/${t.name}/target.mjs, a corpus and a fixtures dir, and flip the status to "active"`,
    );
  }
  return problems;
}
