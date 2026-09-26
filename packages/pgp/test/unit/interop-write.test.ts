// PST-T-12.2, PST-REQ-161: interop proof for what Postroom WRITES, against the reference tools.
//   gpg --decrypt   (a throwaway GNUPGHOME holding the recipient's TEST key) opens a Postroom-encrypted message
//   gpg --verify    accepts a Postroom-signed PGP/MIME part
//   gpg --import    reads a Postroom-generated key, secret half included (unprotected and S2K-protected),
//                   and a Postroom revocation; Postroom unlocks a gpg-exported passphrase-protected key
//   openssl cms -verify / -decrypt  accept Postroom's S/MIME
// The binaries are looked up at /opt/homebrew/bin, then on PATH. Where they are absent (a CI runner
// without gpg) the suite is skipped with a message saying so — on a developer machine it runs.
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  analyzeMessage,
  certificatesFromPem,
  decodeArmor,
  encodeArmor,
  entityBytes,
  generateKey,
  parseKeys,
  pgpMimeEncrypt,
  pgpMimeSign,
  protectSecretKeyBlock,
  revocationSignature,
  RevocationReason,
  signDetached,
  smimeEncrypt,
  smimeSign,
  unlockSecretKeyBlock,
  withKeySignature,
  type KnownKey,
} from '../../src/index.js';
import { FIXTURES, text } from './fixtures.js';
import { forgeCert } from './forge.js';

function tool(name: string): string | null {
  const brew = `/opt/homebrew/bin/${name}`;
  if (existsSync(brew)) return brew;
  const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  const path = found.status === 0 ? found.stdout.trim() : '';
  if (path === '') return null;
  // macOS's /usr/bin/openssl is LibreSSL, whose `cms` is not the one these tests mean.
  return name === 'openssl' && !spawnSync(path, ['version'], { encoding: 'utf8' }).stdout.startsWith('OpenSSL 3') ? null : path;
}

const GPG = tool('gpg');
const OPENSSL = tool('openssl');
if (GPG === null) process.stderr.write('interop-write: gpg not found — skipping the gpg interop tests (install GnuPG 2.4+ to run them)\n');
if (OPENSSL === null) process.stderr.write('interop-write: OpenSSL 3 not found — skipping the openssl cms interop tests\n');

const dirs: string[] = [];
afterAll(() => {
  // Each GNUPGHOME started its own gpg-agent: stop them before the directories go.
  const gpgconf = GPG === null ? null : join(GPG, '..', 'gpgconf');
  for (const d of dirs) {
    if (gpgconf !== null && existsSync(gpgconf)) spawnSync(gpgconf, ['--homedir', d, '--kill', 'all']);
    rmSync(d, { recursive: true, force: true });
  }
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'pst-t122-'));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

const ENTITY = Buffer.from('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nHello from Postroom,\r\nthis part is protected.\r\n', 'latin1');
const HEAD = 'From: Zoe <zoe@example.test>\r\nTo: Alice <alice@example.test>\r\nSubject: interop\r\nDate: Sat, 26 Sep 2026 10:00:00 +0000\r\nMessage-ID: <i@example.test>\r\nMIME-Version: 1.0\r\n';

/** The parts of a multipart body, split on its boundary (test-side, for handing to the tools). */
function parts(entity: { headers: string[]; body: Buffer }): Buffer[] {
  const b = /boundary="([^"]+)"/.exec(entity.headers.join(''))?.[1];
  if (b === undefined) throw new Error('no boundary');
  const s = entity.body.toString('latin1');
  return s
    .split(`--${b}`)
    .slice(1, -1)
    .map((p) => Buffer.from(p.replace(/^\r\n/, '').replace(/\r\n$/, ''), 'latin1'));
}

const bodyOf = (part: Buffer): Buffer => part.subarray(part.indexOf('\r\n\r\n') + 4);

describe.skipIf(GPG === null)('gpg reads what Postroom writes', () => {
  const gpg = (home: string, args: string[], input?: Buffer | string) =>
    spawnSync(GPG ?? 'gpg', ['--homedir', home, '--batch', '--no-tty', '--pinentry-mode', 'loopback', ...args], { input, maxBuffer: 16 * 1024 * 1024 });

  it('gpg --decrypt opens a Postroom-encrypted PGP/MIME message with the recipient TEST key (alice, Curve25519)', () => {
    const home = scratch();
    expect(gpg(home, ['--import', join(FIXTURES, 'alice-ed25519.TEST-ONLY.sec.asc')]).status).toBe(0);
    const [alice] = parseKeys(decodeArmor(text('alice-ed25519.pub.asc'))?.data ?? Buffer.alloc(0));
    if (alice === undefined) throw new Error('alice');
    const enc = pgpMimeEncrypt(ENTITY, [alice]);
    const armored = bodyOf(parts(enc)[1] ?? Buffer.alloc(0));
    const out = gpg(home, ['--decrypt'], armored);
    expect(out.stderr.toString()).not.toMatch(/WARNING: message was not integrity protected/);
    expect(out.status).toBe(0);
    expect(out.stdout.equals(ENTITY)).toBe(true);
  });

  it('gpg --decrypt with bob (RSA-3072): EME-PKCS1-v1_5 written here', () => {
    const home = scratch();
    expect(gpg(home, ['--import', join(FIXTURES, 'bob-rsa3072.TEST-ONLY.sec.asc')]).status).toBe(0);
    const [bob] = parseKeys(decodeArmor(text('bob-rsa3072.pub.asc'))?.data ?? Buffer.alloc(0));
    if (bob === undefined) throw new Error('bob');
    const armored = bodyOf(parts(pgpMimeEncrypt(ENTITY, [bob]))[1] ?? Buffer.alloc(0));
    const out = gpg(home, ['--decrypt'], armored);
    expect(out.status).toBe(0);
    expect(out.stdout.equals(ENTITY)).toBe(true);
  });

  it('gpg imports a Postroom-generated secret key, decrypts to it, and --verify accepts its PGP/MIME signature', () => {
    const home = scratch();
    const g = generateKey({ userId: 'Zoe Test <zoe@example.test>' });
    const imp = gpg(home, ['--import'], g.secretArmored);
    expect(imp.status, imp.stderr.toString()).toBe(0);
    const listed = execFileSync(GPG ?? 'gpg', ['--homedir', home, '--batch', '--with-colons', '--list-secret-keys'], { encoding: 'utf8' });
    expect(listed).toContain(`fpr:::::::::${g.fingerprint}:`);
    expect(listed).toMatch(/^ssb:.*:.*:18:/m);

    const armored = bodyOf(parts(pgpMimeEncrypt(ENTITY, [g.key]))[1] ?? Buffer.alloc(0));
    const dec = gpg(home, ['--decrypt'], armored);
    expect(dec.status, dec.stderr.toString()).toBe(0);
    expect(dec.stdout.equals(ENTITY)).toBe(true);

    const signed = pgpMimeSign(ENTITY, g.key);
    const [signedPart, sigPart] = parts(signed);
    if (signedPart === undefined || sigPart === undefined) throw new Error('parts');
    expect(signedPart.equals(ENTITY)).toBe(true);
    const dir = scratch();
    writeFileSync(join(dir, 'part'), signedPart);
    writeFileSync(join(dir, 'part.asc'), bodyOf(sigPart));
    const v = gpg(home, ['--status-fd', '1', '--verify', join(dir, 'part.asc'), join(dir, 'part')]);
    expect(v.status, v.stderr.toString()).toBe(0);
    expect(v.stdout.toString()).toContain(`VALIDSIG ${g.fingerprint}`);
    expect(v.stdout.toString()).toContain('GOODSIG');
    // One changed byte: gpg says BAD.
    writeFileSync(join(dir, 'part'), Buffer.concat([signedPart, Buffer.from('x')]));
    const bad = gpg(home, ['--status-fd', '1', '--verify', join(dir, 'part.asc'), join(dir, 'part')]);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout.toString()).toContain('BADSIG');
  });

  it('gpg imports a Postroom S2K-protected secret key with its passphrase, and a Postroom revocation', () => {
    const home = scratch();
    const g = generateKey({ userId: 'Pat Test <pat@example.test>' });
    const locked = encodeArmor('PGP PRIVATE KEY BLOCK', protectSecretKeyBlock(g.secretBinary, 'correct horse'));
    const imp = gpg(home, ['--passphrase', 'correct horse', '--import'], locked);
    expect(imp.status, imp.stderr.toString()).toBe(0);
    // It really is locked under that passphrase: gpg refuses a wrong one (asked first, before the
    // agent caches the right one), then signs with the right one.
    const w = gpg(home, ['--passphrase', 'wrong', '--local-user', g.fingerprint, '--detach-sign', '--armor', '--output', '-'], 'hello');
    expect(w.status).not.toBe(0);
    const s = gpg(home, ['--passphrase', 'correct horse', '--local-user', g.fingerprint, '--detach-sign', '--armor'], 'hello');
    expect(s.status, s.stderr.toString()).toBe(0);

    const rev = encodeArmor('PGP PUBLIC KEY BLOCK', withKeySignature(g.publicBinary, revocationSignature(g.key, { reason: RevocationReason.retired })));
    expect(gpg(home, ['--import'], rev).status).toBe(0);
    const listed = execFileSync(GPG ?? 'gpg', ['--homedir', home, '--batch', '--with-colons', '--list-keys', g.fingerprint], { encoding: 'utf8' });
    expect(listed).toMatch(/^pub:r:/m);
  });

  it('Postroom unlocks a gpg-exported, passphrase-protected secret key, then signs with it for gpg', async () => {
    const home = scratch();
    const uid = 'Gus Test <gus@example.test>';
    const gen = gpg(home, ['--passphrase', 'tr0ub4dor', '--quick-gen-key', uid, 'ed25519', 'sign,cert', 'never']);
    expect(gen.status, gen.stderr.toString()).toBe(0);
    const fpr = /^fpr:+([0-9A-F]{40}):/m.exec(execFileSync(GPG ?? 'gpg', ['--homedir', home, '--batch', '--with-colons', '--list-keys', uid], { encoding: 'utf8' }))?.[1] ?? '';
    expect(gpg(home, ['--passphrase', 'tr0ub4dor', '--quick-add-key', fpr, 'cv25519', 'encr', 'never']).status).toBe(0);
    const exported = gpg(home, ['--passphrase', 'tr0ub4dor', '--armor', '--export-secret-keys', fpr]);
    expect(exported.status).toBe(0);
    const block = decodeArmor(exported.stdout.toString())?.data ?? Buffer.alloc(0);
    expect(() => parseKeys(block)).toThrow();
    const [key] = parseKeys(unlockSecretKeyBlock(block, 'tr0ub4dor'));
    if (key === undefined) throw new Error('no key');
    expect(key.primary.fingerprint).toBe(fpr);
    expect(key.primary.secretKey).not.toBeNull();
    expect(key.subkeys[0]?.secretKey).not.toBeNull();

    const dir = scratch();
    writeFileSync(join(dir, 'data'), ENTITY);
    writeFileSync(join(dir, 'data.asc'), signDetached(key, ENTITY));
    const v = gpg(home, ['--status-fd', '1', '--verify', join(dir, 'data.asc'), join(dir, 'data')]);
    expect(v.status, v.stderr.toString()).toBe(0);
    expect(v.stdout.toString()).toContain(`VALIDSIG ${fpr}`);

    // And the verifier (PST-T-12.1) opens mail gpg encrypts to that key, once unlocked and stored.
    const pub = gpg(home, ['--armor', '--export', fpr]).stdout.toString();
    const enc = gpg(home, ['--trust-model', 'always', '--armor', '--encrypt', '--recipient', fpr], ENTITY);
    expect(enc.status).toBe(0);
    const msg = Buffer.from(`${HEAD}Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"\r\n\r\n--b\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--b\r\nContent-Type: application/octet-stream\r\n\r\n${enc.stdout.toString().replace(/\r?\n/g, '\r\n')}\r\n--b--\r\n`, 'latin1');
    const known: KnownKey = { id: 'gus', kind: 'pgp', owner: 'own', address: 'gus@example.test', fingerprint: fpr, publicKey: pub, openPrivate: () => Promise.resolve(encodeArmor('PGP PRIVATE KEY BLOCK', unlockSecretKeyBlock(block, 'tr0ub4dor'))) };
    const r = await analyzeMessage([msg], [known]);
    // gpg 2.5 may choose SEIPD v2 for a key that advertises it; ours never does, gpg's own keys may.
    expect(['decrypted', 'failed:unsupported-seipd-v2', 'failed:unsupported-librepgp-ocb']).toContain(r.encryption.status);
  });
});

describe.skipIf(OPENSSL === null)('openssl cms reads what Postroom writes', () => {
  const openssl = (args: string[], input?: Buffer) => spawnSync(OPENSSL ?? 'openssl', args, { input, maxBuffer: 16 * 1024 * 1024 });
  const [carolCert] = certificatesFromPem(text('carol-smime.pem'));
  const [intermediate] = certificatesFromPem(text('smime-intermediate.pem'));
  const carolKey = createPrivateKey(text('carol-smime.TEST-ONLY.key.pem'));

  it('openssl cms -verify accepts a Postroom S/MIME signature (RSA, chained to the test root), and refuses a changed one', () => {
    if (carolCert === undefined || intermediate === undefined) throw new Error('fixtures');
    const dir = scratch();
    const e = smimeSign(ENTITY, { certificate: carolCert, privateKey: carolKey, chain: [intermediate] });
    const file = join(dir, 'signed.eml');
    writeFileSync(file, Buffer.concat([Buffer.from(HEAD), entityBytes(e)]));
    const v = openssl(['cms', '-verify', '-in', file, '-CAfile', join(FIXTURES, 'smime-root.pem'), '-purpose', 'smimesign', '-out', join(dir, 'out')]);
    expect(v.status, v.stderr.toString()).toBe(0);
    expect(v.stderr.toString()).toContain('Verification successful');
    expect(readFileSync(join(dir, 'out')).toString('latin1').replace(/\r\n/g, '\n')).toBe(ENTITY.toString('latin1').replace(/\r\n/g, '\n'));
    writeFileSync(file, Buffer.from(Buffer.concat([Buffer.from(HEAD), entityBytes(e)]).toString('latin1').replace('Hello from', 'Hullo from'), 'latin1'));
    expect(openssl(['cms', '-verify', '-in', file, '-noverify', '-out', join(dir, 'out')]).status).not.toBe(0);
  });

  it('openssl cms -verify -noverify accepts ECDSA P-256 and Ed25519 signatures', () => {
    for (const keyType of ['p256', 'ed25519'] as const) {
      const f = forgeCert({ keyType });
      const [cert] = certificatesFromPem(f.pem);
      if (cert === undefined) throw new Error('cert');
      const dir = scratch();
      const file = join(dir, 'signed.eml');
      writeFileSync(file, Buffer.concat([Buffer.from(HEAD), entityBytes(smimeSign(ENTITY, { certificate: cert, privateKey: f.priv }))]));
      const v = openssl(['cms', '-verify', '-in', file, '-noverify', '-out', join(dir, 'out')]);
      expect(v.status, `${keyType}: ${v.stderr.toString()}`).toBe(0);
    }
  });

  it('openssl cms -decrypt opens a Postroom S/MIME enveloped message with the recipient TEST key (carol)', () => {
    if (carolCert === undefined) throw new Error('fixtures');
    const dir = scratch();
    const file = join(dir, 'enc.eml');
    writeFileSync(file, Buffer.concat([Buffer.from(HEAD), entityBytes(smimeEncrypt(ENTITY, [carolCert]))]));
    const d = openssl(['cms', '-decrypt', '-in', file, '-recip', join(FIXTURES, 'carol-smime.pem'), '-inkey', join(FIXTURES, 'carol-smime.TEST-ONLY.key.pem'), '-binary']);
    expect(d.status, d.stderr.toString()).toBe(0);
    expect(d.stdout.equals(ENTITY)).toBe(true);
  });
});

