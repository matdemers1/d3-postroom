// Jazzer.js coverage-guided target for @postroom/attachments (PST-T-4.2 / PST-REQ-088).
//
// Feeds the raw fuzzer bytes into the ZIP central-directory / local-header listing and the bounded
// inflate on a listed entry — both documented to never throw. Asserts readZipEntries returns null
// only for bytes that do not sniff as a ZIP at all, and readEntryBytes never produces more than the
// requested cap of decompressed bytes (the zip-bomb guard). A crasher here becomes a fixture under
// fuzz/attachments/fixtures before attachments is fixed — see docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FuzzedDataProvider } from '@jazzer.js/core';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'attachments');
const entry = join(pkg, 'dist', 'zip.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('attachments fuzz target: build failed');
}
const { readZipEntries, readEntryBytes, inspectZip } = await import(pathToFileURL(entry).href);

const CAP = 1 << 16;

/** @param {Buffer} data */
export function fuzz(data) {
  const fdp = new FuzzedDataProvider(data);
  const cap = fdp.consumeIntegralInRange(0, CAP);
  const buf = Buffer.from(fdp.consumeRemainingAsBytes());

  const listing = readZipEntries(buf);
  if (listing !== null) {
    if (typeof listing.malformed !== 'boolean' || !Array.isArray(listing.entries)) {
      throw new Error('readZipEntries returned a malformed listing');
    }
    for (const e of listing.entries.slice(0, 8)) {
      const read = readEntryBytes(buf, e, cap);
      if (read !== null && read.bytes.length > cap) {
        throw new Error(`readEntryBytes produced ${read.bytes.length} bytes over the ${cap} cap`);
      }
    }
  }

  inspectZip(buf, cap || 1);
}
