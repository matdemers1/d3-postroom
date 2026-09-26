// Jazzer.js coverage-guided target for @postroom/pgp (PST-T-12.1, PST-REQ-160).
//
// The same bytes go through every hand-written format reader in the package: OpenPGP packet
// framing (old/new format, partial lengths), transferable keys, v4 signature packets, the whole
// decrypt path with no keys (PKESK and SEIPD framing), ASCII armor and the cleartext framework,
// the DER/BER reader, and the CMS ContentInfo / SignedData / EnvelopedData / certificate readers.
// The invariant: each fails only with the package's own error types (PgpError and its subclasses,
// DerError, CmsError) and decryptMessage never throws at all. A crasher becomes a fixture under
// fuzz/pgp/fixtures before the parser is fixed — see docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'pgp');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });
  if (built.status !== 0) throw new Error('pgp fuzz target: build failed');
}
const pgp = await import(pathToFileURL(entry).href);
const { PgpError, DerError, CmsError } = pgp;

function own(fn) {
  try {
    fn();
  } catch (err) {
    if (err instanceof PgpError || err instanceof DerError || err instanceof CmsError) return;
    throw err;
  }
}

/** Every reader on the same bytes. Throws only on a real bug. */
export function exercise(bytes) {
  const buf = Buffer.from(bytes);
  own(() => pgp.readPackets(buf));
  own(() => pgp.parseKeys(buf));
  own(() => pgp.parseSignaturePacket(buf));
  const d = pgp.decryptMessage(buf, []);
  if (typeof d.status !== 'string') throw new Error('decryptMessage must return a status');
  own(() => {
    for (const t of pgp.readAll(buf)) if (t.constructed) pgp.readAll(t.content);
  });
  own(() => {
    const ci = pgp.parseContentInfo(buf);
    pgp.parseSignedData(ci.content);
  });
  own(() => {
    const ci = pgp.parseContentInfo(buf);
    pgp.parseEnvelopedData(ci.content);
  });
  own(() => pgp.parseCertificate(buf));
  const text = buf.toString('latin1');
  own(() => pgp.decodeArmors(text));
  own(() => pgp.parseCleartext(text));
}

/** @param {Buffer} data */
export function fuzz(data) {
  exercise(data);
}
