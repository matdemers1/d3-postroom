// Jazzer.js coverage-guided target for @postroom/pgp (PST-T-12.1, PST-REQ-160).
//
// The same bytes go through every hand-written format reader in the package: OpenPGP packet
// framing (old/new format, partial lengths), transferable keys, v4 signature packets, the whole
// decrypt path with no keys (PKESK and SEIPD framing), secret-key unlocking (PST-T-12.2), ASCII armor and the cleartext framework,
// the DER reader in both modes (strict DER, and BER with indefinite lengths, padded lengths and
// segmented OCTET STRINGs — PST-T-12.4), and the CMS ContentInfo / SignedData / EnvelopedData /
// certificate readers (BER wrappers by default, and strict DER).
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
    for (const t of pgp.readAll(buf, 0, 100_000, 'ber')) if (t.constructed) for (const c of pgp.children(t)) if (c.constructed) pgp.definiteForm(c);
  });
  own(() => {
    const t = pgp.readTlv(buf, 0, 0, 'ber');
    if (t.constructed) pgp.octets(t);
  });
  own(() => {
    const ci = pgp.parseContentInfo(buf);
    const sd = pgp.parseSignedData(ci.content);
    // The strict re-read of each SignerInfo's signed attributes (verifySigner's first step).
    for (const si of sd.signers) if (si.signedAttrs !== null) pgp.children(pgp.readTlv(Buffer.from(si.signedAttrs.raw), 0, 0, 'der'));
  });
  own(() => {
    const ci = pgp.parseContentInfo(buf, 'der');
    pgp.parseSignedData(ci.content);
  });
  own(() => {
    const ci = pgp.parseContentInfo(buf);
    pgp.parseEnvelopedData(ci.content);
  });
  // A certificate as the drawer reports it: chainOf renders every link's validity window, which
  // once threw RangeError on a certificate node:crypto parsed but whose dates it could not print
  // (fixtures/crash-cert-invalid-validity.der).
  own(() => {
    const cert = pgp.parseCertificate(buf);
    pgp.chainOf(cert, [cert]);
  });
  // PST-T-12.2: what the Keys screen runs on an imported key block — the secret-key protection
  // reader (S2K usage, cipher, specifier, IV), and the secret → public conversion.
  own(() => pgp.isProtectedSecretBlock(buf));
  own(() => pgp.publicKeyBlock(buf));
  own(() => pgp.unlockSecretKeyBlock(buf, 'fuzz'));
  const text = buf.toString('latin1');
  own(() => pgp.decodeArmors(text));
  own(() => pgp.parseCleartext(text));
}

/** @param {Buffer} data */
export function fuzz(data) {
  exercise(data);
}
