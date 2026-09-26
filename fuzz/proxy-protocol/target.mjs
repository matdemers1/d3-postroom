// Jazzer.js coverage-guided target for @postroom/proxy-protocol (PST-T-4.2 / PST-REQ-088).
//
// Feeds the raw fuzzer bytes into decodeProxyV2, the pure buffer-in decoder behind the socket-level
// readProxyHeader — asserts it always returns one of its three documented result kinds (`ok`,
// `error`, `incomplete`) and never throws. A crasher here becomes a fixture under
// fuzz/proxy-protocol/fixtures before proxy-protocol is fixed — see docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'proxy-protocol');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('proxy-protocol fuzz target: build failed');
}
const { decodeProxyV2 } = await import(pathToFileURL(entry).href);

const KINDS = new Set(['ok', 'error', 'incomplete']);

/** @param {Buffer} data */
export function fuzz(data) {
  const result = decodeProxyV2(data);
  if (result === undefined || result === null || typeof result !== 'object' || !KINDS.has(result.kind)) {
    throw new Error(`decodeProxyV2 returned an unrecognized result: ${JSON.stringify(result)}`);
  }
  if (result.kind === 'ok' && result.bytesConsumed > data.length) {
    throw new Error(`decodeProxyV2 claimed to consume ${result.bytesConsumed} of ${data.length} bytes`);
  }
}
