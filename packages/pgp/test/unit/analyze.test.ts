// PST-T-12.1, PST-REQ-160: real interop fixtures (gpg 2.5, openssl 3.6 — see make-fixtures.sh)
// verify and decrypt; a tampered body is a bad signature; trust comes only from the account's keys.
import { describe, expect, it } from 'vitest';
import { analyzeMessage } from '../../src/index.js';
import { ALICE_FPR, BOB_FPR, alice, bob, carol, chunked, fixture, tamper } from './fixtures.js';

describe('PGP/MIME signed (RFC 3156 §5)', () => {
  it('Ed25519 v4 (as Proton sends) verifies against a matching CryptoKey row', async () => {
    const r = await analyzeMessage(chunked(fixture('pgp-mime-signed-ed25519.eml')), [alice('contact')]);
    expect(r.signature.status).toBe('verified-known-key');
    expect(r.signature.format).toBe('pgp-mime');
    expect(r.signature.signer).toMatchObject({ fingerprint: ALICE_FPR, algorithm: 'Ed25519 (EdDSALegacy)', hash: 'sha256', keySource: 'account', knownKeyId: 'alice-contact', owner: 'contact', fromMatches: true });
    expect(r.signature.signer?.addresses).toContain('alice@example.test');
    expect(r.encryption.status).toBe('not-encrypted');
  });

  it('the same message with one body byte changed is a bad signature', async () => {
    const r = await analyzeMessage([tamper(fixture('pgp-mime-signed-ed25519.eml'), 'Hello Bob')], [alice()]);
    expect(r.signature.status).toBe('bad-signature');
  });

  it('a key attached to the message is never trusted on its own', async () => {
    const r = await analyzeMessage([fixture('pgp-mime-signed-ed25519.eml')], []);
    expect(r.signature.status).toBe('valid-signature-unknown-key');
    expect(r.signature.signer?.keySource).toBe('message');
    const bad = await analyzeMessage([tamper(fixture('pgp-mime-signed-ed25519.eml'), 'Hello Bob')], []);
    expect(bad.signature.status).toBe('bad-signature');
  });

  it('RSA-3072 verifies (SHA-512)', async () => {
    const r = await analyzeMessage(chunked(fixture('pgp-mime-signed-rsa.eml'), 5), [bob('own')]);
    expect(r.signature.status).toBe('verified-known-key');
    expect(r.signature.signer).toMatchObject({ fingerprint: BOB_FPR, algorithm: 'RSA', hash: 'sha512', owner: 'own' });
    const bad = await analyzeMessage([tamper(fixture('pgp-mime-signed-rsa.eml'), 'signed with RSA')], [bob()]);
    expect(bad.signature.status).toBe('bad-signature');
  });

  it('an unknown signer with no attached key cannot be checked, and says why', async () => {
    const r = await analyzeMessage([fixture('pgp-mime-signed-rsa.eml')], [alice()]);
    expect(r.signature.status).toBe('unsupported:signer-key-unavailable');
    expect(r.signature.signer?.fingerprint).toBe(BOB_FPR);
  });

  it('is the same with LF line endings (the signed part is canonicalized to CRLF)', async () => {
    const lf = Buffer.from(fixture('pgp-mime-signed-ed25519.eml').toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    const r = await analyzeMessage(chunked(lf, 64), [alice()]);
    expect(r.signature.status).toBe('verified-known-key');
  });
});

describe('inline cleartext signature (RFC 9580 §7)', () => {
  it('verifies, with dash-escaping and trailing whitespace', async () => {
    const r = await analyzeMessage([fixture('pgp-clearsigned.eml')], [alice()]);
    expect(r.signature.status).toBe('verified-known-key');
    expect(r.signature.format).toBe('pgp-inline');
  });

  it('a changed word is a bad signature', async () => {
    const r = await analyzeMessage([tamper(fixture('pgp-clearsigned.eml'), 'Hello Bob')], [alice()]);
    expect(r.signature.status).toBe('bad-signature');
  });
});

describe('PGP/MIME encrypted (RFC 3156 §4)', () => {
  it('decrypts to Curve25519 (ECDH, RFC 6637) with the account key, and not without it', async () => {
    const ok = await analyzeMessage([fixture('pgp-mime-encrypted-x25519.eml')], [alice('own', true)]);
    expect(ok.encryption).toMatchObject({ status: 'decrypted', format: 'pgp-mime', cipher: 'AES-256', integrity: 'MDC (SEIPD v1)', openedWithKeyId: 'alice-own' });
    expect(ok.encryption.recipients[0]?.matchedKeyId).toBe('alice-own');

    const none = await analyzeMessage([fixture('pgp-mime-encrypted-x25519.eml')], [bob('own', true)]);
    expect(none.encryption.status).toBe('no-key');

    const publicOnly = await analyzeMessage([fixture('pgp-mime-encrypted-x25519.eml')], [alice('own', false)]);
    expect(publicOnly.encryption.status).toBe('failed:private-key-unavailable');

    const contact = await analyzeMessage([fixture('pgp-mime-encrypted-x25519.eml')], [alice('contact', true)]);
    expect(contact.encryption.status).toBe('no-key');
  });

  it('decrypts to RSA-3072', async () => {
    const r = await analyzeMessage([fixture('pgp-mime-encrypted-rsa.eml')], [bob('own', true)]);
    expect(r.encryption.status).toBe('decrypted');
  });

  it('checks the one-pass signature inside a signed-and-encrypted message', async () => {
    const r = await analyzeMessage([fixture('pgp-mime-signed-encrypted.eml')], [alice('own', true), bob('contact')]);
    expect(r.encryption.status).toBe('decrypted');
    expect(r.signature).toMatchObject({ status: 'verified-known-key', format: 'pgp-encrypted' });
    expect(r.signature.signer?.fingerprint).toBe(BOB_FPR);
  });

  it('refuses LibrePGP OCB by name', async () => {
    const r = await analyzeMessage([fixture('pgp-mime-encrypted-ocb.eml')], [alice('own', true)]);
    expect(r.encryption.status).toBe('failed:unsupported-librepgp-ocb');
  });

  it('a flipped ciphertext byte fails the MDC or the session key, never decrypts', async () => {
    const eml = fixture('pgp-mime-encrypted-x25519.eml').toString('latin1');
    const start = eml.indexOf('-----BEGIN PGP MESSAGE-----');
    const lines = eml.slice(start).split('\r\n');
    // Change one radix-64 character in the middle of the body and drop the (now wrong) checksum.
    const bodyLine = lines.findIndex((l, i) => i > 2 && l.length > 40);
    const l = lines[bodyLine] ?? '';
    lines[bodyLine] = `${l.slice(0, 20)}${l[20] === 'A' ? 'B' : 'A'}${l.slice(21)}`;
    const noCrc = lines.filter((x) => !/^=[A-Za-z0-9+/]{4}$/.test(x));
    const r = await analyzeMessage([Buffer.from(eml.slice(0, start) + noCrc.join('\r\n'), 'latin1')], [alice('own', true)]);
    expect(r.encryption.status).toMatch(/^failed:/);
  });
});

describe('S/MIME (RFC 8551)', () => {
  it('smime -sign verifies, with the chain as presented up to the embedded intermediate', async () => {
    const r = await analyzeMessage(chunked(fixture('smime-signed.eml')), []);
    expect(r.signature.status).toBe('valid-signature-unknown-key');
    expect(r.signature.format).toBe('smime');
    expect(r.signature.signer?.addresses).toEqual(['carol@example.test']);
    expect(r.signature.signer?.fromMatches).toBe(true);
    expect(r.signature.certificates.map((c) => c.subject)).toEqual([expect.stringContaining('Carol Test'), expect.stringContaining('Intermediate')]);
    expect(r.signature.chain).toMatchObject({ verified: true, endsAtSelfSigned: false });
    expect(r.signature.chain?.reason).toContain('embedded intermediates');
  });

  it('is verified-known-key when the certificate is one of the account\'s', async () => {
    const r = await analyzeMessage([fixture('smime-signed.eml')], [carol('contact')]);
    expect(r.signature.status).toBe('verified-known-key');
    expect(r.signature.signer?.knownKeyId).toBe('carol-contact');
  });

  it('cms -sign (application/pkcs7-signature) verifies too', async () => {
    const r = await analyzeMessage([fixture('smime-cms-signed.eml')], []);
    expect(r.signature.status).toBe('valid-signature-unknown-key');
  });

  it('a tampered body is a bad signature', async () => {
    const r = await analyzeMessage([tamper(fixture('smime-signed.eml'), 'Hello from Carol')], [carol()]);
    expect(r.signature.status).toBe('bad-signature');
    expect(r.signature.reasons.join(' ')).toContain('messageDigest');
  });

  it('smime -encrypt decrypts with the RSA test key, and not without it', async () => {
    const r = await analyzeMessage([fixture('smime-encrypted.eml')], [carol('own', true)]);
    expect(r.encryption).toMatchObject({ status: 'decrypted', format: 'smime', cipher: 'AES-256-CBC', openedWithKeyId: 'carol-own' });
    const none = await analyzeMessage([fixture('smime-encrypted.eml')], []);
    expect(none.encryption.status).toBe('no-key');
  });
});

describe('not signed, not encrypted, and malformed', () => {
  it('a plain message is neither', async () => {
    const r = await analyzeMessage([Buffer.from('From: a@b.test\r\nSubject: hi\r\n\r\nhello\r\n')], []);
    expect(r.signature.status).toBe('not-signed');
    expect(r.encryption.status).toBe('not-encrypted');
  });

  it('a garbled signature part is unsupported with a reason, never a throw', async () => {
    const eml = fixture('pgp-mime-signed-rsa.eml').toString('latin1').replace(/-----BEGIN PGP SIGNATURE-----\r\n\r\n/, '-----BEGIN PGP SIGNATURE-----\r\n\r\n!!');
    const r = await analyzeMessage([Buffer.from(eml, 'latin1')], [bob()]);
    expect(r.signature.status).toMatch(/^unsupported:malformed-/);
  });

  it('an unknown multipart/signed protocol is named', async () => {
    const r = await analyzeMessage([Buffer.from('Content-Type: multipart/signed; protocol="application/x-foo"; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b--\r\n')], []);
    expect(r.signature.status).toBe('unsupported:signature-protocol-application/x-foo');
  });
});
