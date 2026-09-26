// Jazzer.js coverage-guided target for @postroom/dns (PST-T-4.2 / PST-REQ-088).
//
// Feeds the raw fuzzer bytes into the wire decoder for a whole DNS message and, at an arbitrary
// offset, into the compression-pointer name decoder — the same invariants as fuzz/dns/smoke.mjs:
// both always return a typed `{ ok }` result and never throw. A crasher here becomes a fixture
// under fuzz/dns/fixtures before dns is fixed — see docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FuzzedDataProvider } from '@jazzer.js/core';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'dns');
const entry = join(pkg, 'dist', 'wire.js');
const nameEntry = join(pkg, 'dist', 'name.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('dns fuzz target: build failed');
}
const { decodeMessage } = await import(pathToFileURL(entry).href);
const { decodeName } = await import(pathToFileURL(nameEntry).href);

/** @param {Buffer} data */
export function fuzz(data) {
  const fdp = new FuzzedDataProvider(data);
  const start = fdp.consumeIntegralInRange(0, 600);
  const rest = Buffer.from(fdp.consumeRemainingAsBytes());

  const result = decodeMessage(rest);
  if (typeof result.ok !== 'boolean') throw new Error('decodeMessage must always return a typed result');

  const nameResult = decodeName(rest, start);
  if (typeof nameResult.ok !== 'boolean') throw new Error('decodeName must always return a typed result');
}
