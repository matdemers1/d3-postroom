// PST-T-12.1, PST-REQ-160 — the adversarial verifier's findings, each as a test:
//   1. a certification signature (0x13) replayed as a message signature is never verified;
//   2. analyzeMessage is total (see properties.test.ts for the fixed counterexample);
//   3. revoked / expired keys, expired and future-dated signatures are never verified-known-key;
//   4. S/MIME: SHA-1, a certificate outside its validity window, or not for e-mail, never either;
//   5. strict DER for signed bytes: non-DER signed attributes are refused by name (BER wrappers are
//      read since PST-T-12.4 — see smime-ber.test.ts); two literals are malformed.
import { describe, expect, it } from 'vitest';
import { analyzeMessage, children, decodeArmor, derSetOf, encodePacket, parseContentInfo, parseSignedData, readPackets, Tag, type KnownKey } from '../../src/index.js';
import { readMessagePackets } from '../../src/decrypt.js';
import { PgpError } from '../../src/errors.js';
import { alice, bob, fixture, text } from './fixtures.js';
import { canonicalText, clearsigned, encryptedToBob, forgeCert, forgeKey, literalPacket, pgpMimeSigned, SIGNED_PART, signedData, smimeSigned } from './forge.js';

const NOW = new Date('2026-06-01T00:00:00Z');
const T0 = new Date('2026-01-01T00:00:00Z');
const at = (iso: string): Date => new Date(iso);

describe('finding 1: only document signatures (0x00, 0x01) are checked', () => {
  it("the verifier's attack: alice's public 0x13 self-certification over key || uid, sent as a PGP/MIME signature, is never verified-known-key", async () => {
    const armored = decodeArmor(text('alice-ed25519.pub.asc'));
    if (armored === null) throw new Error('alice key');
    const packets = readPackets(armored.data);
    const key = packets.find((p) => p.tag === Tag.PublicKey);
    const uidIndex = packets.findIndex((p) => p.tag === Tag.UserId);
    const uid = packets[uidIndex];
    const cert = packets.slice(uidIndex + 1).find((p) => p.tag === Tag.Signature && p.body[1] === 0x13);
    if (key === undefined || uid === undefined || cert === undefined) throw new Error('alice key shape');
    const len4 = Buffer.alloc(4);
    len4.writeUInt32BE(uid.body.length, 0);
    const signedBytes = Buffer.concat([Buffer.of(0x99, key.body.length >> 8, key.body.length & 0xff), key.body, Buffer.of(0xb4), len4, uid.body]);
    // The attack needs the signed part to reach the hash unchanged: no line breaks inside.
    expect(signedBytes.includes(0x0a) || signedBytes.includes(0x0d)).toBe(false);
    const certPacket = encodePacket(Tag.Signature, cert.body);
    const eml = pgpMimeSigned(signedBytes, certPacket, 'Alice Test <alice@example.test>');
    const r = await analyzeMessage([eml], [alice('contact')]);
    expect(r.signature.status).not.toBe('verified-known-key');
    expect(r.signature.status).not.toBe('valid-signature-unknown-key');
    expect(r.signature.status).toBe('unsupported:signature-type-0x13');
    expect(r.signature.reasons.join(' ')).toMatch(/not a signature over a message/);
  });

  const dave = forgeKey();
  const lines = ['Hello Bob,', 'trailing space here   ', '-- dash-escaped', 'end'];

  it('PGP/MIME: a mathematically valid 0x13 by the key over the part is refused; 0x00 and 0x01 verify', async () => {
    for (const type of [0x10, 0x13, 0x18, 0x1f, 0x20, 0x02, 0x40]) {
      const r = await analyzeMessage([pgpMimeSigned(SIGNED_PART, dave.sign(SIGNED_PART, { type, created: at('2026-03-01T00:00:00Z') }))], [dave.known()], { now: NOW });
      expect(r.signature.status).toBe(`unsupported:signature-type-0x${type.toString(16).padStart(2, '0')}`);
    }
    for (const type of [0x00, 0x01]) {
      const r = await analyzeMessage([pgpMimeSigned(SIGNED_PART, dave.sign(SIGNED_PART, { type, created: at('2026-03-01T00:00:00Z') }))], [dave.known()], { now: NOW });
      expect(r.signature.status).toBe('verified-known-key');
    }
  });

  it('a wrong-type signature does not hide a genuine one beside it, and does not stand in for one', async () => {
    const created = at('2026-03-01T00:00:00Z');
    const both = Buffer.concat([dave.sign(SIGNED_PART, { type: 0x13, created }), dave.sign(SIGNED_PART, { created })]);
    expect((await analyzeMessage([pgpMimeSigned(SIGNED_PART, both)], [dave.known()], { now: NOW })).signature.status).toBe('verified-known-key');
    const tampered = Buffer.from(SIGNED_PART);
    tampered[tampered.length - 5] = 0x21;
    expect((await analyzeMessage([pgpMimeSigned(tampered, both)], [dave.known()], { now: NOW })).signature.status).toBe('bad-signature');
  });

  it('cleartext: 0x01 over the canonical text (trailing whitespace stripped, CRLF) verifies; 0x13 is refused', async () => {
    const data = canonicalText(lines);
    const ok = await analyzeMessage([clearsigned(lines, dave.sign(data, { type: 0x01, created: at('2026-03-01T00:00:00Z') }))], [dave.known()], { now: NOW });
    expect(ok.signature).toMatchObject({ status: 'verified-known-key', format: 'pgp-inline' });
    const bad = await analyzeMessage([clearsigned(lines, dave.sign(data, { type: 0x13, created: at('2026-03-01T00:00:00Z') }))], [dave.known()], { now: NOW });
    expect(bad.signature.status).toBe('unsupported:signature-type-0x13');
  });

  it('signed then encrypted: the inner signature is held to the same rule, and 0x01 is canonicalized to CRLF', async () => {
    const lf = Buffer.from('line one\nline two\n', 'latin1');
    const crlfData = Buffer.from('line one\r\nline two\r\n', 'latin1');
    const created = at('2026-03-01T00:00:00Z');
    const keys = [bob('own', true), dave.known()];
    const text01 = await analyzeMessage([encryptedToBob(Buffer.concat([literalPacket(lf, 't'), dave.sign(crlfData, { type: 0x01, created })]))], keys, { now: NOW });
    expect(text01.encryption.status).toBe('decrypted');
    expect(text01.signature).toMatchObject({ status: 'verified-known-key', format: 'pgp-encrypted' });
    const bin00 = await analyzeMessage([encryptedToBob(Buffer.concat([literalPacket(lf), dave.sign(lf, { created })]))], keys, { now: NOW });
    expect(bin00.signature.status).toBe('verified-known-key');
    const cert13 = await analyzeMessage([encryptedToBob(Buffer.concat([literalPacket(lf), dave.sign(lf, { type: 0x13, created })]))], keys, { now: NOW });
    expect(cert13.encryption.status).toBe('decrypted');
    expect(cert13.signature.status).toBe('unsupported:signature-type-0x13');
  });
});

describe('hardening (a): revoked and expired keys, expired and future signatures', () => {
  const created = at('2026-03-01T00:00:00Z');
  const check = async (key: ReturnType<typeof forgeKey>, known: KnownKey, sig: Buffer, now = NOW): Promise<string> =>
    (await analyzeMessage([pgpMimeSigned(SIGNED_PART, sig)], [known], { now })).signature.status;

  it('a key the account marked revoked (CryptoKey.revokedAt) → unsupported:key-revoked, whenever the signature claims to be from', async () => {
    const k = forgeKey();
    expect(await check(k, k.known({ revokedAt: at('2026-02-01T00:00:00Z') }), k.sign(SIGNED_PART, { created }))).toBe('unsupported:key-revoked');
    expect(await check(k, k.known({ revokedAt: created }), k.sign(SIGNED_PART, { created }))).toBe('unsupported:key-revoked');
    // A row has no reason for revocation, and a stolen key can backdate: an earlier signature is not spared.
    expect(await check(k, k.known({ revokedAt: at('2026-04-01T00:00:00Z') }), k.sign(SIGNED_PART, { created }))).toBe('unsupported:key-revoked');
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created }))).toBe('verified-known-key');
  });

  it('a hard revocation signature (no reason, or compromised) on the key withdraws every signature, even earlier ones', async () => {
    for (const reason of [undefined, 0, 2]) {
      const k = forgeKey({ revocation: { created: at('2026-05-01T00:00:00Z'), ...(reason === undefined ? {} : { reason }) } });
      const r = await analyzeMessage([pgpMimeSigned(SIGNED_PART, k.sign(SIGNED_PART, { created }))], [k.known()], { now: NOW });
      expect(r.signature.status).toBe('unsupported:key-revoked');
      expect(r.signature.reasons.join(' ')).toMatch(/revocation signature/);
    }
  });

  it('a soft revocation (superseded, retired) only withdraws signatures made after it', async () => {
    for (const reason of [1, 3]) {
      const k = forgeKey({ revocation: { created: at('2026-04-01T00:00:00Z'), reason } });
      expect(await check(k, k.known(), k.sign(SIGNED_PART, { created }))).toBe('verified-known-key');
      expect(await check(k, k.known(), k.sign(SIGNED_PART, { created: at('2026-04-02T00:00:00Z') }))).toBe('unsupported:key-revoked');
    }
  });

  it('a revocation signature that does not verify (made by another key) is ignored', async () => {
    const k = forgeKey({ revocation: { created: at('2026-02-01T00:00:00Z'), forged: true } });
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created }))).toBe('verified-known-key');
  });

  it('a revoked signing subkey (0x28) → unsupported:key-revoked; the unrevoked one verifies', async () => {
    const good = forgeKey({ subkey: {} });
    expect(await check(good, good.known(), good.signWithSubkey(SIGNED_PART, { created }))).toBe('verified-known-key');
    const revoked = forgeKey({ subkey: { revocation: { created: at('2026-02-01T00:00:00Z'), reason: 2 } } });
    expect(await check(revoked, revoked.known(), revoked.signWithSubkey(SIGNED_PART, { created }))).toBe('unsupported:key-revoked');
    // The primary itself is not revoked.
    expect(await check(revoked, revoked.known(), revoked.sign(SIGNED_PART, { created }))).toBe('verified-known-key');
  });

  it('a key past its expiration (self-signature subpacket 9) when it signed → unsupported:key-expired', async () => {
    const k = forgeKey({ created: T0, keyExpiresSeconds: 30 * 86400 });
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created: at('2026-01-15T00:00:00Z') }))).toBe('verified-known-key');
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created }))).toBe('unsupported:key-expired');
  });

  it('a key past CryptoKey.expiresAt when it signed → unsupported:key-expired', async () => {
    const k = forgeKey();
    expect(await check(k, k.known({ expiresAt: at('2026-02-01T00:00:00Z') }), k.sign(SIGNED_PART, { created }))).toBe('unsupported:key-expired');
    expect(await check(k, k.known({ expiresAt: at('2026-04-01T00:00:00Z') }), k.sign(SIGNED_PART, { created }))).toBe('verified-known-key');
  });

  it('a signature past its own expiration time → unsupported:signature-expired', async () => {
    const k = forgeKey();
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created, expiresSeconds: 86400 }))).toBe('unsupported:signature-expired');
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created, expiresSeconds: 365 * 86400 }))).toBe('verified-known-key');
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created, expiresSeconds: 0 }))).toBe('verified-known-key');
  });

  it('a signature from more than five minutes in the future → unsupported:signature-from-future', async () => {
    const k = forgeKey();
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created: new Date(NOW.getTime() + 60 * 60 * 1000) }))).toBe('unsupported:signature-from-future');
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created: new Date(NOW.getTime() + 60 * 1000) }))).toBe('verified-known-key');
  });

  it('a signature with no creation time → unsupported:signature-no-creation-time', async () => {
    const k = forgeKey();
    expect(await check(k, k.known(), k.sign(SIGNED_PART, { created: null }))).toBe('unsupported:signature-no-creation-time');
  });

  it('the checks apply to a key that came with the message too (never valid-signature-unknown-key)', async () => {
    const k = forgeKey({ revocation: { created: at('2026-02-01T00:00:00Z') } });
    const part = Buffer.from(`Content-Type: text/plain\r\n\r\n${k.armored.replace(/\r?\n/g, '\r\n')}`, 'latin1');
    const r = await analyzeMessage([pgpMimeSigned(part, k.sign(part, { created }))], [], { now: NOW });
    expect(r.signature.signer?.keySource).toBe('message');
    expect(r.signature.status).toBe('unsupported:key-revoked');
  });

  it("the real fixtures (gpg keys with no expiry) still verify under today's clock", async () => {
    expect((await analyzeMessage([fixture('pgp-mime-signed-ed25519.eml')], [alice()])).signature.status).toBe('verified-known-key');
  });
});

describe('hardening (b)(c): S/MIME hash, validity window and purpose', () => {
  const part = SIGNED_PART;

  it('a well-formed forged S/MIME signature verifies (the builder is sound)', async () => {
    const cert = forgeCert();
    const r = await analyzeMessage([smimeSigned(part, signedData(cert, part))], [cert.known()], { now: NOW });
    expect(r.signature).toMatchObject({ status: 'verified-known-key', format: 'smime' });
    const unknown = await analyzeMessage([smimeSigned(part, signedData(cert, part))], [], { now: NOW });
    expect(unknown.signature.status).toBe('valid-signature-unknown-key');
  });

  it('SHA-1 as the digest, or sha1WithRSAEncryption as the signature algorithm → unsupported:weak-hash-sha1', async () => {
    const cert = forgeCert();
    expect((await analyzeMessage([smimeSigned(part, signedData(cert, part, { digest: 'sha1' }))], [cert.known()], { now: NOW })).signature.status).toBe('unsupported:weak-hash-sha1');
    expect((await analyzeMessage([smimeSigned(part, signedData(cert, part, { signatureAlgorithm: '1.2.840.113549.1.1.5' }))], [cert.known()], { now: NOW })).signature.status).toBe('unsupported:weak-hash-sha1');
  });

  it('a signer certificate outside its validity window at signingTime (or now, without one) → unsupported:certificate-expired', async () => {
    const old = forgeCert({ notBefore: at('2020-01-01T00:00:00Z'), notAfter: at('2021-01-01T00:00:00Z') });
    expect((await analyzeMessage([smimeSigned(part, signedData(old, part))], [old.known()], { now: NOW })).signature.status).toBe('unsupported:certificate-expired');
    // Signed while it was valid: fine.
    expect((await analyzeMessage([smimeSigned(part, signedData(old, part, { signingTime: at('2020-06-01T00:00:00Z') }))], [old.known()], { now: NOW })).signature.status).toBe('verified-known-key');
    // No signingTime: judged at now.
    expect((await analyzeMessage([smimeSigned(part, signedData(old, part, { signingTime: null }))], [old.known()], { now: NOW })).signature.status).toBe('unsupported:certificate-expired');
    const future = forgeCert({ notBefore: at('2027-01-01T00:00:00Z') });
    expect((await analyzeMessage([smimeSigned(part, signedData(future, part, { signingTime: null }))], [future.known()], { now: NOW })).signature.status).toBe('unsupported:certificate-expired');
  });

  it('keyUsage without digitalSignature/nonRepudiation, or an EKU without emailProtection → unsupported:certificate-not-for-email', async () => {
    const encOnly = forgeCert({ keyUsage: 0x20 });
    expect((await analyzeMessage([smimeSigned(part, signedData(encOnly, part))], [encOnly.known()], { now: NOW })).signature.status).toBe('unsupported:certificate-not-for-email');
    const server = forgeCert({ eku: [ '1.3.6.1.5.5.7.3.1' ] });
    expect((await analyzeMessage([smimeSigned(part, signedData(server, part))], [server.known()], { now: NOW })).signature.status).toBe('unsupported:certificate-not-for-email');
    // nonRepudiation alone is enough; no EKU extension at all is fine (RFC 8550 §4.4.4).
    const nr = forgeCert({ keyUsage: 0x40, eku: null });
    expect((await analyzeMessage([smimeSigned(part, signedData(nr, part))], [nr.known()], { now: NOW })).signature.status).toBe('verified-known-key');
    const none = forgeCert({ keyUsage: null, eku: null });
    expect((await analyzeMessage([smimeSigned(part, signedData(none, part))], [none.known()], { now: NOW })).signature.status).toBe('verified-known-key');
  });

  it('a certificate the account marked revoked or expired → unsupported:key-revoked / key-expired', async () => {
    const cert = forgeCert();
    expect((await analyzeMessage([smimeSigned(part, signedData(cert, part))], [cert.known({ revokedAt: at('2026-05-01T00:00:00Z') })], { now: NOW })).signature.status).toBe('unsupported:key-revoked');
    expect((await analyzeMessage([smimeSigned(part, signedData(cert, part))], [cert.known({ expiresAt: at('2026-05-01T00:00:00Z') })], { now: NOW })).signature.status).toBe('unsupported:key-expired');
  });

  it('a tampered part is still bad-signature before any of these', async () => {
    const old = forgeCert({ notBefore: at('2020-01-01T00:00:00Z'), notAfter: at('2021-01-01T00:00:00Z') });
    const tampered = Buffer.from(part);
    tampered[tampered.length - 5] = 0x21;
    expect((await analyzeMessage([smimeSigned(tampered, signedData(old, part))], [old.known()], { now: NOW })).signature.status).toBe('bad-signature');
  });
});

describe('hardening (d)(f): strict DER, and one literal packet', () => {
  it('signed attributes not in DER order → unsupported:signed-attributes-not-der', async () => {
    const cert = forgeCert();
    const r = await analyzeMessage([smimeSigned(SIGNED_PART, signedData(cert, SIGNED_PART, { unsortedAttributes: true }))], [cert.known()], { now: NOW });
    expect(r.signature.status).toBe('unsupported:signed-attributes-not-der');
  });

  it("the fixtures' signed attributes as received ARE their DER re-encoding (so the byte-exact check costs no interop)", () => {
    for (const name of ['smime-signed.eml', 'smime-cms-signed.eml']) {
      const eml = fixture(name).toString('latin1');
      const b64 = /Content-Type: application\/(?:x-)?pkcs7-signature[^]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(eml)?.[1] ?? '';
      const sd = parseSignedData(parseContentInfo(Buffer.from(b64.replace(/\s+/g, ''), 'base64')).content);
      const attrs = sd.signers[0]?.signedAttrs;
      if (attrs === undefined || attrs === null) throw new Error(`${name}: no signed attributes`);
      const retagged = Buffer.from(attrs.raw);
      retagged[0] = 0x31;
      expect(derSetOf(children(attrs).map((a) => a.raw)).equals(retagged)).toBe(true);
    }
  });

  it('a BER (indefinite-length) outer ContentInfo verifies like its DER twin (PST-T-12.4: BER wrappers are read)', async () => {
    const cert = forgeCert();
    const der = signedData(cert, SIGNED_PART);
    // Re-frame the outer ContentInfo SEQUENCE with an indefinite length.
    const header = der[1] === undefined ? 0 : der[1] < 0x80 ? 2 : 2 + (der[1] & 0x7f);
    const ber = Buffer.concat([Buffer.of(0x30, 0x80), der.subarray(header), Buffer.of(0, 0)]);
    const r = await analyzeMessage([smimeSigned(SIGNED_PART, ber)], [cert.known()], { now: NOW });
    expect(r.signature.status).toBe('verified-known-key');
    // Unterminated, it is malformed BER, named as such.
    const cut = await analyzeMessage([smimeSigned(SIGNED_PART, ber.subarray(0, ber.length - 2))], [cert.known()], { now: NOW });
    expect(cut.signature.status).toBe('unsupported:malformed-ber');
  });

  it('more than one literal packet → failed:malformed-message (readMessagePackets and the drawer)', async () => {
    expect(() => readMessagePackets(Buffer.concat([literalPacket(Buffer.from('a')), literalPacket(Buffer.from('b'))]), 1024)).toThrow(PgpError);
    const r = await analyzeMessage([encryptedToBob(Buffer.concat([literalPacket(Buffer.from('a')), literalPacket(Buffer.from('b'))]))], [bob('own', true)], { now: NOW });
    expect(r.encryption.status).toBe('failed:malformed-message');
  });
});
