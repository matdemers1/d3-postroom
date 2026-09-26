// Shared engine for the golden replay (PST-T-5.5, PST-REQ-107) and the private calibration harness
// (PST-REQ-108): parse a synthetic `.eml` into the shape `@postroom/classifier` needs, classify it,
// and score the result against a manifest's expected bucket. `scripts/golden/replay.mjs` (CI, the
// committed fixtures/golden set) and `scripts/golden/calibrate.mjs` (a local operator, a gitignored
// real corpus) both import this file so the two never drift apart.
//
// Builds `@postroom/mime` and `@postroom/classifier` from source if `dist/` is missing, the same
// pattern `fuzz/mime/target.mjs` uses, so this runs straight after `pnpm install` with no separate
// build step required first.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

async function loadPackage(name) {
  const pkgDir = join(repoRoot, 'packages', name);
  const entry = join(pkgDir, 'dist', 'index.js');
  if (!existsSync(entry)) {
    const tsc = createRequire(join(pkgDir, 'package.json')).resolve('typescript/bin/tsc');
    const built = spawnSync(process.execPath, [tsc, '-p', join(pkgDir, 'tsconfig.build.json')], { stdio: 'inherit' });
    if (built.status !== 0) throw new Error(`golden harness: failed to build @postroom/${name}`);
  }
  return import(pathToFileURL(entry).href);
}

const mime = await loadPackage('mime');
const classifier = await loadPackage('classifier');

const { parseHeaderBlock } = mime;
const { extractSignals, decide } = classifier;

/** Split a raw RFC 5322 message (CRLF-terminated) into its header block and body, and parse the
 * headers into the `HeaderLike[]` shape `extractSignals` reads. Tolerant of a bare-LF body (some
 * generators emit CRLF headers and a plain-text body); the header block itself must be CRLF per
 * PST-REQ-049, matching what the SMTP/IMAP daemons actually hand the classifier. */
export function parseEml(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  const sepIndex = buf.indexOf('\r\n\r\n');
  const headerBlock = sepIndex === -1 ? buf : buf.subarray(0, sepIndex + 2);
  const headerList = parseHeaderBlock(headerBlock);
  const headers = headerList.fields.map((f) => ({ name: f.name, value: f.value }));
  return { headers };
}

/**
 * The one place this harness turns a classifier decision into a golden bucket label. Today it maps
 * `decide()`'s three rule-pass buckets ('priority' | 'people' | 'other') onto the golden manifest's
 * `expectedRuleBucket` field. PST-T-5.1 is adding a pure `bucketFor(signals, bayes?)` in
 * `packages/classifier/src` that maps all the way to the six real buckets (inbox-priority,
 * inbox-people, newsletters, updates, receipts, notifications, junk); once that lands, this
 * function is the only place that needs to change — swap the body for
 * `bucketFor(signals).toLowerCase()` or similar, and switch the manifest/thresholds comparison over
 * to `expectedFinalBucket` (already recorded on every entry) instead of `expectedRuleBucket`. See
 * `needsOutside` in PST-T-5.5's handback.
 */
export function classifyForGolden(headers, account, authVerdicts, envelopeFrom = null) {
  const signals = extractSignals({ headers, envelopeFrom, authVerdicts, account });
  const decision = decide(signals);
  return decision.bucket; // <-- SWITCH POINT: replace with bucketFor(...) once PST-T-5.1 lands.
}

/** Precision/recall per bucket over a set of {expected, actual} pairs, plus micro totals. */
export function computeMetrics(pairs, buckets) {
  const perBucket = {};
  for (const bucket of buckets) perBucket[bucket] = { tp: 0, fp: 0, fn: 0 };

  for (const { expected, actual } of pairs) {
    if (expected === actual) {
      if (perBucket[actual] !== undefined) perBucket[actual].tp++;
    } else {
      if (perBucket[actual] !== undefined) perBucket[actual].fp++;
      if (perBucket[expected] !== undefined) perBucket[expected].fn++;
    }
  }

  const result = {};
  for (const bucket of buckets) {
    const { tp, fp, fn } = perBucket[bucket];
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
    result[bucket] = { tp, fp, fn, precision, recall };
  }
  return result;
}

/** Run every manifest entry in `manifest` (already parsed) through the classifier, reading each
 * entry's `.eml` from `fixturesDir`. Returns per-message results and per-bucket metrics. */
export async function runGolden(fixturesDir, manifest) {
  const { readFile } = await import('node:fs/promises');
  const buckets = [...new Set(manifest.map((e) => e.expectedRuleBucket))];
  const perMessage = [];

  for (const entry of manifest) {
    const raw = await readFile(join(fixturesDir, entry.file));
    const { headers } = parseEml(raw);
    const actual = classifyForGolden(headers, entry.account, entry.authVerdicts, entry.envelopeFrom ?? null);
    perMessage.push({ file: entry.file, expected: entry.expectedRuleBucket, actual, tags: entry.tags ?? [] });
  }

  const metrics = computeMetrics(
    perMessage.map((m) => ({ expected: m.expected, actual: m.actual })),
    buckets,
  );

  return { perMessage, metrics, buckets };
}
