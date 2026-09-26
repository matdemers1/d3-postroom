// Jazzer.js coverage-guided target for @postroom/auth-checks (PST-T-4.2 / PST-REQ-088).
//
// Runs the raw fuzzer bytes (as a string) through the three record/tag-list parsers that read
// attacker-controlled text off the wire: the DKIM-Signature (and key record) tag-list parser, the
// DMARC policy record parser, and the SPF record/term parser. Asserts each throws only its own
// documented error class — DkimError, or SpfPermError/SpfTempError — and never anything else;
// parseDmarcRecord is documented to never throw at all. A crasher here becomes a fixture under
// fuzz/auth-checks/fixtures before auth-checks is fixed — see docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FuzzedDataProvider } from '@jazzer.js/core';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'auth-checks');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('auth-checks fuzz target: build failed');
}
const { parseTagList, DkimError, parseDmarcRecord, parseRecord, parseTerm, SpfPermError, SpfTempError } = await import(pathToFileURL(entry).href);

/** @param {Buffer} data */
export function fuzz(data) {
  const fdp = new FuzzedDataProvider(data);
  const half = Math.floor(data.length / 2);
  const text = fdp.consumeString(half > 0 ? half : data.length);
  const text2 = fdp.consumeRemainingAsString();

  try {
    parseTagList(text);
  } catch (err) {
    if (!(err instanceof DkimError)) throw err;
  }

  const dmarc = parseDmarcRecord(text2);
  if (typeof dmarc.ok !== 'boolean') throw new Error('parseDmarcRecord must always return a typed result');

  try {
    parseRecord(text2);
  } catch (err) {
    if (!(err instanceof SpfPermError) && !(err instanceof SpfTempError)) throw err;
  }
  try {
    parseTerm(text);
  } catch (err) {
    if (!(err instanceof SpfPermError) && !(err instanceof SpfTempError)) throw err;
  }
}
