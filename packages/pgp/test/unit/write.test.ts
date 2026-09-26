// PST-T-12.2, PST-REQ-161: the writing side, round-tripped through this package's own readers —
// key generation, detached signatures, revocation, S2K protection, PKESK + SEIPD v1 encryption,
// CMS SignedData / EnvelopedData, and the PGP/MIME and S/MIME framing — ending, every time, in
// analyzeMessage (the PST-T-12.1 verifier) saying verified-known-key or decrypted.
import { createHash, createPrivateKey } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  analyzeMessage,
  canonicalText,
  certificatesFromPem,
  decodeArmor,
  decryptEnvelopedData,
  decryptMessage,
  digestFor,
  encodeArmor,
  encodeMpi,
  encryptCmsEnveloped,
  encryptionMaterials,
  encryptMessage,
  entityBytes,
  generateKey,
  isProtectedSecretBlock,
  keyState,
  parseContentInfo,
  parseEnvelopedData,
  parseKeys,
  parseSignaturePacket,
  parseSignedData,
  pgpMimeEncrypt,
  pgpMimeSign,
  PgpError,
  protectSecretKeyBlock,
  publicKeyBlock,
  readPackets,
  revocationSignature,
  RevocationReason,
  s2kCount,
  signCmsDetached,
  signDetachedPacket,
  signingAuthority,
  smimeEncrypt,
  smimeSign,
  unlockSecretKeyBlock,
  verifyDigest,
  withKeySignature,
  type KnownKey,
  type OpenPgpKey,
} from '../../src/index.js';
import { verifySigner } from '../../src/cms.js';
import { alice, bob, carol, tamper, text } from './fixtures.js';
import { forgeCert } from './forge.js';

const ENTITY = Buffer.from('Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nHello Alice,\r\nthis is from Postroom.\r\n', 'latin1');
const HEAD = 'From: Zoe <zoe@d3cloud.io>\r\nTo: Alice <alice@example.test>\r\nSubject: crypto\r\nDate: Sat, 26 Sep 2026 10:00:00 +0000\r\nMessage-ID: <w@d3cloud.io>\r\nMIME-Version: 1.0\r\n';
const message = (e: { headers: string[]; body: Buffer }): Buffer => Buffer.concat([Buffer.from(HEAD, 'latin1'), entityBytes(e)]);

const zoe = generateKey({ userId: 'Zoe <zoe@d3cloud.io>' });
const zoeKnown = (owner: 'own' | 'contact' = 'own', withPrivate = true): KnownKey => ({
  id: `zoe-${owner}`,
  kind: 'pgp',
  owner,
  address: 'zoe@d3cloud.io',
  fingerprint: zoe.fingerprint,
  publicKey: zoe.publicArmored,
  openPrivate: withPrivate ? () => Promise.resolve(zoe.secretArmored) : undefined,
});
const aliceKey = (): OpenPgpKey => {
  const [k] = parseKeys(decodeArmor(text('alice-ed25519.pub.asc'))?.data ?? Buffer.alloc(0));
  if (k === undefined) throw new Error('alice');
  return k;
};
const bobKey = (secret = false): OpenPgpKey => {
  const [k] = parseKeys(decodeArmor(text(secret ? 'bob-rsa3072.TEST-ONLY.sec.asc' : 'bob-rsa3072.pub.asc'))?.data ?? Buffer.alloc(0));
  if (k === undefined) throw new Error('bob');
  return k;
};

describe('generateKey: v4 Ed25519 primary + X25519 subkey', () => {
  it('parses back as one key with the fingerprint it reports, both halves usable', () => {
    const pub = parseKeys(zoe.publicBinary);
    expect(pub).toHaveLength(1);
    const [k] = pub;
    expect(k?.primary.fingerprint).toBe(zoe.fingerprint);
    expect(zoe.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(k?.primary.algorithmName).toBe('Ed25519 (EdDSALegacy)');
    expect(k?.subkeys.map((s) => s.algorithmName)).toEqual(['ECDH Curve25519']);
    expect(k?.subkeys[0]?.kdf).toEqual({ hash: 8, cipher: 9 });
    expect(k?.userIds).toEqual(['Zoe <zoe@d3cloud.io>']);
    // Secret block: both secret halves load, and the secret key block's public form is the public block.
    expect(zoe.key.primary.secretKey).not.toBeNull();
    expect(zoe.key.subkeys[0]?.secretKey).not.toBeNull();
    expect(publicKeyBlock(zoe.secretBinary).equals(zoe.publicBinary)).toBe(true);
  });

  it('self-certification 0x13 with flags 0x03 and a 0x18 binding with flags 0x0C, both verifying', () => {
    const [k] = parseKeys(zoe.publicBinary);
    if (k === undefined) throw new Error('no key');
    const types = k.signatures.map((s) => s.sig.type);
    expect(types).toEqual([0x13, 0x18]);
    const flagsOf = (i: number) => k.signatures[i]?.sig.hashed.find((s) => s.type === 27)?.body[0];
    expect(flagsOf(0)).toBe(0x03);
    expect(flagsOf(1)).toBe(0x0c);
    const prefs = k.signatures[0]?.sig.hashed.find((s) => s.type === 11)?.body;
    expect([...(prefs ?? [])]).toEqual([9, 8, 7]);
    expect(signingAuthority(k, k.primary)).toBeNull();
    expect(encryptionMaterials(k).materials.map((m) => m.fingerprint)).toEqual([k.subkeys[0]?.fingerprint]);
    expect(keyState(k, k.primary)).toMatchObject({ revocations: [], expiresAt: null });
  });

  it('a key expiry is written on both self-signatures', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const g = generateKey({ userId: 'x@example.test', created, expiresSeconds: 86_400 });
    const [k] = parseKeys(g.publicBinary);
    if (k === undefined) throw new Error('no key');
    expect(keyState(k, k.primary).expiresAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(encryptionMaterials(k, new Date('2026-01-03T00:00:00Z')).materials).toEqual([]);
  });

  it('MPIs carry exact bit counts', () => {
    expect([...encodeMpi(Buffer.of(0, 0, 1))]).toEqual([0, 1, 1]);
    expect([...encodeMpi(Buffer.of(0x40, 1)).subarray(0, 2)]).toEqual([0, 15]);
    expect([...encodeMpi(Buffer.alloc(3))]).toEqual([0, 0]);
  });
});

describe('detached document signatures', () => {
  it('fast-check: any data, signed canonical-text (0x01), verifies over the CRLF form and not over another', () => {
    const [pub] = parseKeys(zoe.publicBinary);
    if (pub === undefined) throw new Error('no key');
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), fc.string({ minLength: 1, maxLength: 5 }), (body, extra) => {
        const data = Buffer.from(body, 'utf8');
        const [p] = readPackets(signDetachedPacket(zoe.key, data));
        if (p === undefined) throw new Error('no packet');
        const sig = parseSignaturePacket(p.body);
        expect(sig.type).toBe(0x01);
        expect(sig.issuerFingerprint).toBe(zoe.fingerprint);
        expect(verifyDigest(sig, digestFor(sig, canonicalText(data)), pub.primary)).toBe(true);
        expect(verifyDigest(sig, digestFor(sig, canonicalText(Buffer.concat([data, Buffer.from(extra, 'utf8')]))), pub.primary)).toBe(false);
      }),
      { numRuns: 40 },
    );
  });

  it('an imported RSA key signs too (EMSA-PKCS1-v1_5 written here)', () => {
    const bobSec = bobKey(true);
    const [p] = readPackets(signDetachedPacket(bobSec, ENTITY, { type: 0x00 }));
    const sig = parseSignaturePacket(p?.body ?? Buffer.alloc(0));
    expect(sig.publicKeyAlgorithm).toBe(1);
    expect(verifyDigest(sig, digestFor(sig, ENTITY), bobKey().primary)).toBe(true);
  });

  it('PGP/MIME signed → analyzeMessage: verified-known-key; a changed byte → bad-signature', async () => {
    const msg = message(pgpMimeSign(ENTITY, zoe.key));
    const r = await analyzeMessage([msg], [zoeKnown('contact', false)]);
    expect(r.signature.status).toBe('verified-known-key');
    expect(r.signature.format).toBe('pgp-mime');
    expect(r.signature.signer).toMatchObject({ fingerprint: zoe.fingerprint, fromMatches: true, hash: 'sha256' });
    expect((await analyzeMessage([tamper(msg, 'Hello Alice')], [zoeKnown()])).signature.status).toBe('bad-signature');
    expect((await analyzeMessage([msg], [])).signature.status).toBe('unsupported:signer-key-unavailable');
  });
});

describe('revocation (0x20)', () => {
  it('a revocation stored with the key makes keyState report it, verified and hard for "compromised"', async () => {
    const g = generateKey({ userId: 'Rev <rev@example.test>' });
    const rev = revocationSignature(g.key, { reason: RevocationReason.compromised, text: 'lost laptop' });
    const block = withKeySignature(g.publicBinary, rev);
    const [k] = parseKeys(block);
    if (k === undefined) throw new Error('no key');
    const state = keyState(k, k.primary);
    expect(state.revocations).toEqual([expect.objectContaining({ of: 'primary', hard: true, reason: 2, verified: true })]);
    expect(encryptionMaterials(k).materials).toEqual([]);
    // A message it signed earlier is no longer trusted.
    const msg = message(pgpMimeSign(ENTITY, g.key));
    const known: KnownKey = { id: 'rev', kind: 'pgp', owner: 'contact', address: 'rev@example.test', fingerprint: g.fingerprint, publicKey: encodeArmor('PGP PUBLIC KEY BLOCK', block) };
    expect((await analyzeMessage([msg], [known])).signature.status).toBe('unsupported:key-revoked');
  });
});

describe('S2K protection of a transferable secret key', () => {
  it('protect → refused by the parser → unlock with the passphrase → the same key; a wrong one is refused', () => {
    const g = generateKey({ userId: 'S2K <s2k@example.test>' });
    const locked = protectSecretKeyBlock(g.secretBinary, 'correct horse');
    expect(isProtectedSecretBlock(locked)).toBe(true);
    expect(isProtectedSecretBlock(g.secretBinary)).toBe(false);
    expect(() => parseKeys(locked)).toThrow(PgpError);
    const open = unlockSecretKeyBlock(locked, 'correct horse');
    expect(open.equals(g.secretBinary)).toBe(true);
    expect(() => unlockSecretKeyBlock(locked, 'wrong')).toThrow(expect.objectContaining({ reason: 'bad-passphrase' }) as Error);
    expect(s2kCount(0xff)).toBe(65_011_712);
    expect(s2kCount(0x60)).toBe(65_536);
  });
});

describe('encryption: PKESK v3 + SEIPD v1 (MDC, AES-256)', () => {
  it('fast-check: any bytes, encrypted to a generated key, decrypt back exactly', () => {
    const keys = [zoe.key.primary, ...zoe.key.subkeys].map((material) => ({ material, ref: 'zoe' }));
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (bytes) => {
        const enc = encryptMessage([zoe.key], bytes);
        const r = decryptMessage(enc.binary, keys);
        expect(r.status).toBe('decrypted');
        expect(r.integrity).toBe('mdc');
        expect(r.cipher).toBe('AES-256');
        expect(Buffer.compare(r.plaintext ?? Buffer.alloc(0), Buffer.from(bytes))).toBe(0);
      }),
      { numRuns: 30 },
    );
  });

  it('to the gpg fixtures: ECDH Curve25519 (alice) and RSA-3072 with EME-PKCS1-v1_5 (bob)', async () => {
    const enc = encryptMessage([aliceKey(), bobKey()], ENTITY);
    expect(enc.recipients.map((r) => r.algorithm).sort()).toEqual(['ECDH Curve25519', 'RSA']);
    const asAlice = await analyzeMessage([message(pgpMimeEncryptWith(enc.armored))], [alice('own', true)]);
    expect(asAlice.encryption.status).toBe('decrypted');
    const asBob = await analyzeMessage([message(pgpMimeEncryptWith(enc.armored))], [bob('own', true)]);
    expect(asBob.encryption.status).toBe('decrypted');
  });

  it('a key with nothing to encrypt to is refused by name, never dropped', () => {
    const g = generateKey({ userId: 'x@example.test' });
    const [k] = parseKeys(withKeySignature(g.publicBinary, revocationSignature(g.key)));
    if (k === undefined) throw new Error('no key');
    expect(() => encryptMessage([aliceKey(), k], ENTITY)).toThrow(expect.objectContaining({ reason: 'recipient-cannot-encrypt' }) as Error);
  });

  it('PGP/MIME encrypted → each recipient decrypts; sign-then-encrypt → decrypted AND verified-known-key', async () => {
    const enc = pgpMimeEncrypt(ENTITY, [aliceKey(), zoe.key]);
    expect(enc.recipients).toHaveLength(2);
    const msg = message(enc);
    const r = await analyzeMessage([msg], [alice('own', true)]);
    expect(r.encryption).toMatchObject({ status: 'decrypted', format: 'pgp-mime', cipher: 'AES-256', integrity: 'MDC (SEIPD v1)' });
    expect((await analyzeMessage([msg], [zoeKnown('own')])).encryption.status).toBe('decrypted');

    const both = message(pgpMimeEncrypt(entityBytes(pgpMimeSign(ENTITY, zoe.key)), [aliceKey(), zoe.key]));
    const rb = await analyzeMessage([both], [alice('own', true), zoeKnown('contact', false)]);
    expect(rb.encryption.status).toBe('decrypted');
    expect(rb.signature.status).toBe('verified-known-key');
    expect(rb.signature.signer?.fingerprint).toBe(zoe.fingerprint);
  });
});

/** The multipart/encrypted framing around an armored message made elsewhere in the test. */
function pgpMimeEncryptWith(armored: string): { headers: string[]; body: Buffer } {
  const b = 'B0UND';
  return {
    headers: [`Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`],
    body: Buffer.from(`--${b}\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n${armored.replace(/\n/g, '\r\n')}\r\n--${b}--\r\n`, 'latin1'),
  };
}

describe('CMS writers (RFC 5652)', () => {
  const [carolCert] = certificatesFromPem(text('carol-smime.pem'));
  const [intermediate] = certificatesFromPem(text('smime-intermediate.pem'));
  const carolKey = createPrivateKey(text('carol-smime.TEST-ONLY.key.pem'));
  if (carolCert === undefined || intermediate === undefined) throw new Error('fixtures');

  it('SignedData (RSA, sha256WithRSAEncryption) reads back and its SignerInfo verifies', () => {
    const der = signCmsDetached(ENTITY, { certificate: carolCert, privateKey: carolKey, chain: [intermediate] });
    const ci = parseContentInfo(der, 'der');
    const sd = parseSignedData(ci.content);
    expect(sd.eContent).toBeNull();
    expect(sd.certificates.map((c) => c.fingerprint)).toContain(carolCert.fingerprint);
    const si = sd.signers[0];
    if (si === undefined) throw new Error('no signer');
    expect(verifySigner(si, carolCert, sd.eContentType, createHash('sha256').update(ENTITY).digest()).valid).toBe(true);
    expect(verifySigner(si, carolCert, sd.eContentType, createHash('sha256').update('other').digest()).valid).toBe(false);
  });

  it('fast-check: EnvelopedData (RSA-OAEP, AES-256-CBC) decrypts back exactly', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 1500 }), (bytes) => {
        const env = parseEnvelopedData(parseContentInfo(encryptCmsEnveloped(bytes, [carolCert]), 'der').content);
        const r = decryptEnvelopedData(env, [{ certificate: carolCert, privateKey: carolKey, ref: 'carol' }]);
        expect(r.status).toBe('decrypted');
        if (r.status === 'decrypted') expect(Buffer.compare(r.plaintext, Buffer.from(bytes))).toBe(0);
      }),
      { numRuns: 20 },
    );
  });

  it('S/MIME signed (RSA, ECDSA P-256, Ed25519) → analyzeMessage: verified-known-key', async () => {
    const r = await analyzeMessage([message(smimeSign(ENTITY, { certificate: carolCert, privateKey: carolKey, chain: [intermediate] }))], [carol('own')]);
    expect(r.signature.status).toBe('verified-known-key');
    expect(r.signature.format).toBe('smime');
    for (const keyType of ['p256', 'ed25519'] as const) {
      const f = forgeCert({ keyType, email: 'zoe@d3cloud.io' });
      const [cert] = certificatesFromPem(f.pem);
      if (cert === undefined) throw new Error('cert');
      const msg = message(smimeSign(ENTITY, { certificate: cert, privateKey: f.priv }));
      const rr = await analyzeMessage([msg], [f.known({ owner: 'own' })]);
      expect(rr.signature.status).toBe('verified-known-key');
      expect((await analyzeMessage([tamper(msg, 'Hello Alice')], [f.known()])).signature.status).toBe('bad-signature');
    }
  });

  it('S/MIME enveloped → analyzeMessage: decrypted; sign-then-encrypt: decrypted and verified', async () => {
    const other = forgeCert({ keyType: 'rsa', email: 'zoe@d3cloud.io' });
    const [otherCert] = certificatesFromPem(other.pem);
    if (otherCert === undefined) throw new Error('cert');
    const msg = message(smimeEncrypt(ENTITY, [carolCert, otherCert]));
    const r = await analyzeMessage([msg], [carol('own', true)]);
    expect(r.encryption).toMatchObject({ status: 'decrypted', format: 'smime', cipher: 'AES-256-CBC' });
    const asOther = await analyzeMessage([msg], [{ ...other.known({ owner: 'own' }), openPrivate: () => Promise.resolve(other.priv.export({ type: 'pkcs8', format: 'pem' }).toString()) }]);
    expect(asOther.encryption.status).toBe('decrypted');

    const both = message(smimeEncrypt(entityBytes(smimeSign(ENTITY, { certificate: carolCert, privateKey: carolKey })), [carolCert]));
    const rb = await analyzeMessage([both], [carol('own', true)]);
    expect(rb.encryption.status).toBe('decrypted');
    expect(rb.signature.status).toBe('verified-known-key');
  });

  it('an EC certificate cannot be a key-transport recipient: refused by name', () => {
    const f = forgeCert({ keyType: 'p256' });
    const [cert] = certificatesFromPem(f.pem);
    if (cert === undefined) throw new Error('cert');
    expect(() => encryptCmsEnveloped(ENTITY, [cert])).toThrow(expect.objectContaining({ reason: 'unsupported-recipient-key' }) as Error);
  });
});
