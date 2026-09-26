// The OpenPGP WRITING side (PST-T-12.2, PST-REQ-161): v4 key generation, transferable public and
// secret key export (optionally S2K-protected), unlocking a protected secret key on import,
// detached document signatures, key revocation signatures, and encryption — PKESK v3 (ECDH over
// Curve25519Legacy per RFC 6637, or RSA with EME-PKCS1-v1_5) plus SEIPD v1 with the MDC under
// AES-256. Formats are written here; the primitives come from node:crypto only.
//
// Every writer is round-tripped through this package's own readers in the tests, and against gpg.

import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  privateEncrypt,
  publicEncrypt,
  randomBytes,
  sign as cryptoSign,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import { encodeArmor } from './armor.js';
import { stripLeadingZeros } from './bytes.js';
import { SymmetricAlgorithm, ecdhKdf } from './decrypt.js';
import { PgpError, UnsupportedError } from './errors.js';
import { keysFromPackets, OID, parsePublicKeyPacket, publicPartLength, type KeyMaterial, type OpenPgpKey } from './keys.js';
import { encodePacket, readPackets, Tag, type Packet } from './packets.js';
import { hashName, SignatureType } from './signature.js';
import { encryptionMaterials, signingMaterials } from './validity.js';

// ---------------------------------------------------------------------------------------------
// Encoding helpers

const u16 = (n: number): Buffer => Buffer.of((n >> 8) & 0xff, n & 0xff);

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);

/** RFC 9580 §3.2: a two-octet bit count, then the magnitude without leading zeros. */
export function encodeMpi(value: Uint8Array): Buffer {
  const v = stripLeadingZeros(Buffer.from(value));
  if (v.length === 1 && v[0] === 0) return Buffer.of(0, 0);
  const top = v[0] ?? 0;
  const bits = (v.length - 1) * 8 + (32 - Math.clz32(top));
  return Buffer.concat([u16(bits), v]);
}

/** One signature subpacket (RFC 9580 §5.2.3.7): length, type (bit 7 = critical), body. */
export function encodeSubpacket(type: number, body: Uint8Array, critical = false): Buffer {
  const n = body.length + 1;
  let len: Buffer;
  if (n < 192) len = Buffer.of(n);
  else if (n < 16320) len = Buffer.of(((n - 192) >> 8) + 192, (n - 192) & 0xff);
  else len = Buffer.concat([Buffer.of(255), u32(n)]);
  return Buffer.concat([len, Buffer.of((critical ? 0x80 : 0) | type), body]);
}

function checksum16(data: Uint8Array): number {
  let s = 0;
  for (const b of data) s = (s + b) & 0xffff;
  return s;
}

/** The framing a key signature hashes a key under: 0x99 || two-octet length || public body. */
function frame(body: Buffer): Buffer {
  return Buffer.concat([Buffer.of(0x99), u16(body.length), body]);
}

function jwkBytes(key: KeyObject, member: 'x' | 'd'): Buffer {
  const jwk = key.export({ format: 'jwk' });
  const v = jwk[member];
  if (typeof v !== 'string') throw new PgpError('key-export', `the key has no ${member}`);
  return Buffer.from(v, 'base64url');
}

// ---------------------------------------------------------------------------------------------
// Signatures

const DIGEST_INFO: Record<string, string> = {
  sha256: '3031300d060960864801650304020105000420',
  sha384: '3041300d060960864801650304020205000430',
  sha512: '3051300d060960864801650304020305000440',
};

/** Who signs: the public key packet body (for the issuer), and the secret half. */
export interface Signer {
  material: KeyMaterial;
  secretKey: KeyObject;
}

export interface SignatureSpec {
  type: number;
  /** Hash algorithm ID (default 8, SHA-256). */
  hash?: number;
  created?: Date;
  /** Extra hashed subpackets (already encoded), after creation time. */
  hashed?: Buffer[];
}

/**
 * A v4 signature packet body (RFC 9580 §5.2.3) by `signer` over `data` — the bytes the signature
 * type hashes before its trailer (the document, or the key framing for a key signature).
 * Creation time and issuer fingerprint are hashed; the issuer key ID is unhashed.
 */
export function makeSignature(signer: Signer, spec: SignatureSpec, data: Uint8Array): Buffer {
  const m = signer.material;
  const hashId = spec.hash ?? 8;
  const hash = hashName(hashId);
  const created = spec.created ?? new Date();
  const fp = Buffer.from(m.fingerprint, 'hex');
  const hashedArea = Buffer.concat([encodeSubpacket(2, u32(seconds(created))), ...(spec.hashed ?? []), encodeSubpacket(33, Buffer.concat([Buffer.of(4), fp]))]);
  const unhashedArea = encodeSubpacket(16, Buffer.from(m.keyId, 'hex'));
  const prefix = Buffer.concat([Buffer.of(4, spec.type, m.algorithm, hashId), u16(hashedArea.length), hashedArea]);
  const trailer = Buffer.concat([Buffer.of(0x04, 0xff), u32(prefix.length)]);
  const digest = createHash(hash).update(data).update(prefix).update(trailer).digest();
  let values: Buffer;
  switch (m.algorithm) {
    case 22: {
      const raw = cryptoSign(null, digest, signer.secretKey);
      values = Buffer.concat([encodeMpi(raw.subarray(0, 32)), encodeMpi(raw.subarray(32))]);
      break;
    }
    case 27:
      values = cryptoSign(null, digest, signer.secretKey);
      break;
    case 1:
    case 3: {
      const prefixHex = DIGEST_INFO[hash];
      if (prefixHex === undefined) throw new UnsupportedError('rsa-hash');
      const s = privateEncrypt({ key: signer.secretKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([Buffer.from(prefixHex, 'hex'), digest]));
      values = encodeMpi(s);
      break;
    }
    default:
      throw new UnsupportedError(`signature-algorithm-${String(m.algorithm)}`, `signing with ${m.algorithmName} is not supported`);
  }
  return Buffer.concat([prefix, u16(unhashedArea.length), unhashedArea, digest.subarray(0, 2), values]);
}

/** The first key material of `key` that may sign (flag 0x02, bound, secret half loaded). */
export function signerOf(key: OpenPgpKey): Signer {
  const m = signingMaterials(key)[0];
  if (m?.secretKey === null || m === undefined) throw new PgpError('no-signing-key', 'the key has no secret key that may sign');
  return { material: m, secretKey: m.secretKey };
}

/** Canonical text (RFC 9580 §5.2.1.2): every line ending CRLF. */
export function canonicalText(data: Uint8Array): Buffer {
  return Buffer.from(Buffer.from(data).toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
}

export interface DetachedOptions {
  created?: Date;
  /** 0x01 canonical text (default, as RFC 3156 PGP/MIME signs) or 0x00 binary. */
  type?: 0x00 | 0x01;
}

/** A detached document signature packet (binary) over `data` by the key's signing key. */
export function signDetachedPacket(key: OpenPgpKey, data: Uint8Array, opts: DetachedOptions = {}): Buffer {
  const type = opts.type ?? SignatureType.Text;
  const bytes = type === SignatureType.Text ? canonicalText(data) : Buffer.from(data);
  const spec: SignatureSpec = { type, ...(opts.created !== undefined ? { created: opts.created } : {}) };
  return encodePacket(Tag.Signature, makeSignature(signerOf(key), spec, bytes));
}

/** The same, ASCII-armored as a PGP SIGNATURE block. */
export function signDetached(key: OpenPgpKey, data: Uint8Array, opts: DetachedOptions = {}): string {
  return encodeArmor('PGP SIGNATURE', signDetachedPacket(key, data, opts));
}

/** RFC 9580 §5.2.3.31 reason-for-revocation codes. */
export const RevocationReason = { none: 0, superseded: 1, compromised: 2, retired: 3 } as const;

/** A key revocation signature (0x20) packet by the primary over itself. */
export function revocationSignature(key: OpenPgpKey, opts: { reason?: number; text?: string; created?: Date } = {}): Buffer {
  const primary = key.primary;
  if (primary.secretKey === null) throw new PgpError('no-secret-primary', 'revoking needs the primary key\'s secret half');
  const reason = encodeSubpacket(29, Buffer.concat([Buffer.of(opts.reason ?? RevocationReason.none), Buffer.from(opts.text ?? '', 'utf8')]));
  const spec: SignatureSpec = { type: SignatureType.KeyRevocation, hashed: [reason], ...(opts.created !== undefined ? { created: opts.created } : {}) };
  return encodePacket(Tag.Signature, makeSignature({ material: primary, secretKey: primary.secretKey }, spec, frame(primary.body)));
}

// ---------------------------------------------------------------------------------------------
// Key generation

/** PKCS#8 PrivateKeyInfo for X25519 (RFC 8410 §7) up to the 32-octet private key. */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface GeneratedKey {
  /** The transferable public key, armored. */
  publicArmored: string;
  /** The transferable secret key (unprotected secret packets), armored. Seal it at rest. */
  secretArmored: string;
  /** Binary forms of the same. */
  publicBinary: Buffer;
  secretBinary: Buffer;
  /** The parsed secret key, ready to sign and decrypt with. */
  key: OpenPgpKey;
  fingerprint: string;
}

export interface GenerateOptions {
  /** e.g. `Alice <alice@example.test>`. */
  userId: string;
  created?: Date;
  /** Key expiration (subpacket 9), seconds after creation; omitted = never. */
  expiresSeconds?: number;
}

/**
 * A v4 Ed25519 (EdDSALegacy) primary with an X25519 (ECDH Curve25519Legacy, SHA-256 / AES-256 KDF)
 * encryption subkey — what gpg writes for `--quick-gen-key ... future-default` on a v4 key, so every
 * v4 implementation can read it. The primary is self-certified (0x13) with key flags 0x03 (certify,
 * sign), preferred algorithms and the MDC feature; the subkey is bound (0x18) with flags 0x0C.
 */
export function generateKey(opts: GenerateOptions): GeneratedKey {
  const created = new Date(seconds(opts.created ?? new Date()) * 1000);
  const ts = u32(seconds(created));

  const ed = generateKeyPairSync('ed25519');
  const edX = jwkBytes(ed.publicKey, 'x');
  const edD = jwkBytes(ed.privateKey, 'd');
  const edOid = Buffer.from(OID.ed25519Legacy, 'hex');
  const primaryPub = Buffer.concat([Buffer.of(4), ts, Buffer.of(22, edOid.length), edOid, encodeMpi(Buffer.concat([Buffer.of(0x40), edX]))]);
  const edSecret = encodeMpi(edD);
  const primarySec = Buffer.concat([primaryPub, Buffer.of(0), edSecret, u16(checksum16(edSecret))]);

  // X25519: clamp the scalar (RFC 7748 §5) so the stored form is canonical; the public point is the same.
  const xd = jwkBytes(generateKeyPairSync('x25519').privateKey, 'd');
  xd[0] = (xd[0] ?? 0) & 248;
  xd[31] = ((xd[31] ?? 0) & 127) | 64;
  const xPriv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, xd]), format: 'der', type: 'pkcs8' });
  const xX = jwkBytes(createPublicKey(xPriv), 'x');
  const cvOid = Buffer.from(OID.curve25519Legacy, 'hex');
  const subPub = Buffer.concat([Buffer.of(4), ts, Buffer.of(18, cvOid.length), cvOid, encodeMpi(Buffer.concat([Buffer.of(0x40), xX])), Buffer.of(3, 1, 8, 9)]);
  // Curve25519Legacy secrets are stored big-endian: the reverse of the native encoding.
  const subSecret = encodeMpi(Buffer.from(xd).reverse());
  const subSec = Buffer.concat([subPub, Buffer.of(0), subSecret, u16(checksum16(subSecret))]);

  const primary = parsePublicKeyPacket(primaryPub);
  const signer: Signer = { material: primary, secretKey: ed.privateKey };
  const uid = Buffer.from(opts.userId, 'utf8');
  const expiry = opts.expiresSeconds !== undefined && opts.expiresSeconds > 0 ? [encodeSubpacket(9, u32(opts.expiresSeconds))] : [];
  const certification = makeSignature(
    signer,
    {
      type: SignatureType.CertPositive,
      created,
      hashed: [
        encodeSubpacket(27, Buffer.of(0x03)),
        ...expiry,
        encodeSubpacket(11, Buffer.of(9, 8, 7)), // preferred symmetric: AES-256, AES-192, AES-128
        encodeSubpacket(21, Buffer.of(8, 10, 9)), // preferred hash: SHA-256, SHA-512, SHA-384
        encodeSubpacket(22, Buffer.of(2, 1, 0)), // preferred compression: ZLIB, ZIP, none
        encodeSubpacket(30, Buffer.of(0x01)), // features: SEIPD v1 (MDC)
        encodeSubpacket(23, Buffer.of(0x80)), // key server preferences: no-modify
      ],
    },
    Buffer.concat([frame(primaryPub), Buffer.of(0xb4), u32(uid.length), uid]),
  );
  const binding = makeSignature(signer, { type: SignatureType.SubkeyBinding, created, hashed: [encodeSubpacket(27, Buffer.of(0x0c)), ...expiry] }, Buffer.concat([frame(primaryPub), frame(subPub)]));

  const tail = [encodePacket(Tag.UserId, uid), encodePacket(Tag.Signature, certification)];
  const publicBinary = Buffer.concat([encodePacket(Tag.PublicKey, primaryPub), ...tail, encodePacket(Tag.PublicSubkey, subPub), encodePacket(Tag.Signature, binding)]);
  const secretBinary = Buffer.concat([encodePacket(Tag.SecretKey, primarySec), ...tail, encodePacket(Tag.SecretSubkey, subSec), encodePacket(Tag.Signature, binding)]);
  const [key] = keysFromPackets(readPackets(secretBinary));
  if (key === undefined) throw new PgpError('generate-failed');
  return {
    publicArmored: encodeArmor('PGP PUBLIC KEY BLOCK', publicBinary),
    secretArmored: encodeArmor('PGP PRIVATE KEY BLOCK', secretBinary),
    publicBinary,
    secretBinary,
    key,
    fingerprint: primary.fingerprint,
  };
}

// ---------------------------------------------------------------------------------------------
// Transferable keys: public from secret, adding signatures, S2K protection

/** The transferable public key of a (secret or public) key block: secret packets become public ones, trust packets go. */
export function publicKeyBlock(block: Uint8Array): Buffer {
  const out: Buffer[] = [];
  for (const p of readPackets(block)) {
    if (p.tag === Tag.Trust) continue;
    if (p.tag === Tag.SecretKey || p.tag === Tag.SecretSubkey) {
      const body = p.body.subarray(0, publicPartLength(p.body));
      out.push(encodePacket(p.tag === Tag.SecretKey ? Tag.PublicKey : Tag.PublicSubkey, body));
    } else out.push(encodePacket(p.tag, p.body));
  }
  return Buffer.concat(out);
}

/** `block` with a signature packet (a 0x20 revocation) placed right after the primary key packet. */
export function withKeySignature(block: Uint8Array, signaturePacket: Uint8Array): Buffer {
  const packets = readPackets(block);
  const first = packets[0];
  if (first === undefined || (first.tag !== Tag.PublicKey && first.tag !== Tag.SecretKey)) throw new PgpError('key-block-no-primary');
  return Buffer.concat([encodePacket(first.tag, first.body), Buffer.from(signaturePacket), ...packets.slice(1).map((p) => encodePacket(p.tag, p.body))]);
}

/** RFC 9580 §3.7.1.3: the iteration count an S2K count octet encodes. */
export function s2kCount(c: number): number {
  return (16 + (c & 15)) << ((c >> 4) + 6);
}

/** RFC 9580 §3.7.1: simple (0), salted (1) and iterated+salted (3) S2K, stretched to `keyBytes`. */
export function s2kDerive(passphrase: string, spec: { type: number; hash: number; salt: Buffer; count: number }, keyBytes: number): Buffer {
  const pass = Buffer.from(passphrase, 'utf8');
  const name = hashName(spec.hash);
  const input = spec.type === 0 ? pass : Buffer.concat([spec.salt, pass]);
  const total = spec.type === 3 ? Math.max(spec.count, input.length) : input.length;
  const out: Buffer[] = [];
  let have = 0;
  for (let preload = 0; have < keyBytes; preload++) {
    const h = createHash(name);
    if (preload > 0) h.update(Buffer.alloc(preload));
    // `total` octets of input repeated, fed in blocks of whole repetitions, then the remainder.
    const reps = Math.max(1, Math.floor(65_536 / Math.max(1, input.length)));
    const block = Buffer.concat(Array.from({ length: reps }, () => input));
    let left = total;
    while (left >= block.length && block.length > 0) {
      h.update(block);
      left -= block.length;
    }
    if (left > 0) h.update(block.subarray(0, left));
    const d = h.digest();
    out.push(d);
    have += d.length;
  }
  return Buffer.concat(out).subarray(0, keyBytes);
}

const S2K_COUNT_OCTET = 0xff; // 65 011 712 octets hashed, as gpg's default calibrates to

function protectBody(body: Buffer, passphrase: string): Buffer {
  const pubLen = publicPartLength(body);
  if (body[pubLen] !== 0) throw new PgpError('secret-key-already-protected');
  const material = body.subarray(pubLen + 1, body.length - 2);
  const salt = randomBytes(8);
  const key = s2kDerive(passphrase, { type: 3, hash: 8, salt, count: s2kCount(S2K_COUNT_OCTET) }, 32);
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cfb', key, iv);
  const plain = Buffer.concat([material, createHash('sha1').update(material).digest()]);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  // usage 254 (SHA-1 check), AES-256, iterated+salted S2K with SHA-256.
  return Buffer.concat([body.subarray(0, pubLen), Buffer.of(254, 9, 3, 8), salt, Buffer.of(S2K_COUNT_OCTET), iv, ct]);
}

/** The secret key block with every secret packet protected under `passphrase` (S2K usage 254, AES-256, iterated+salted SHA-256). */
export function protectSecretKeyBlock(block: Uint8Array, passphrase: string): Buffer {
  return Buffer.concat(
    readPackets(block).map((p) => (p.tag === Tag.SecretKey || p.tag === Tag.SecretSubkey ? encodePacket(p.tag, protectBody(p.body, passphrase)) : encodePacket(p.tag, p.body))),
  );
}

function unlockBody(body: Buffer, passphrase: string): Buffer {
  const pubLen = publicPartLength(body);
  const usage = body[pubLen] ?? 0;
  if (usage === 0) return body;
  if (usage === 253) throw new UnsupportedError('aead-protected-key', 'the secret key is AEAD-protected (S2K usage 253), which Postroom cannot unlock');
  if (usage !== 254 && usage !== 255) throw new UnsupportedError('legacy-protected-key', 'the secret key uses a pre-RFC 4880 protection');
  let pos = pubLen + 1;
  const at = (i: number): number => {
    const v = body[i];
    if (v === undefined) throw new PgpError('key-truncated');
    return v;
  };
  const cipherId = at(pos++);
  const sym = SymmetricAlgorithm[cipherId];
  if (sym === undefined) throw new UnsupportedError(`cipher-${String(cipherId)}`, 'the secret key is protected with a cipher other than AES');
  const type = at(pos++);
  if (type === 101) throw new UnsupportedError('gnu-dummy-s2k', 'the secret key is a stub (its secret half lives on a smartcard or was not exported)');
  if (type !== 0 && type !== 1 && type !== 3) throw new UnsupportedError(`s2k-${String(type)}`);
  const hash = at(pos++);
  let salt: Buffer = Buffer.alloc(0);
  let count = 0;
  if (type === 1 || type === 3) {
    salt = body.subarray(pos, pos + 8);
    if (salt.length !== 8) throw new PgpError('key-truncated');
    pos += 8;
  }
  if (type === 3) count = s2kCount(at(pos++));
  const iv = body.subarray(pos, pos + 16);
  if (iv.length !== 16) throw new PgpError('key-truncated');
  pos += 16;
  const key = s2kDerive(passphrase, { type, hash, salt, count }, sym.keyBytes);
  const d = createDecipheriv(`${sym.cipher}-cfb`, key, iv);
  const plain = Buffer.concat([d.update(body.subarray(pos)), d.final()]);
  let material: Buffer;
  if (usage === 254) {
    if (plain.length < 20) throw new PgpError('bad-passphrase', 'the passphrase does not unlock the secret key');
    material = plain.subarray(0, plain.length - 20);
    const want = createHash('sha1').update(material).digest();
    if (!timingSafeEqual(want, plain.subarray(plain.length - 20))) throw new PgpError('bad-passphrase', 'the passphrase does not unlock the secret key');
  } else {
    if (plain.length < 2) throw new PgpError('bad-passphrase');
    material = plain.subarray(0, plain.length - 2);
    if (checksum16(material) !== plain.readUInt16BE(plain.length - 2)) throw new PgpError('bad-passphrase', 'the passphrase does not unlock the secret key');
  }
  return Buffer.concat([body.subarray(0, pubLen), Buffer.of(0), material, u16(checksum16(material))]);
}

/** True when any secret packet in the block is passphrase-protected. */
export function isProtectedSecretBlock(block: Uint8Array): boolean {
  return readPackets(block).some((p) => (p.tag === Tag.SecretKey || p.tag === Tag.SecretSubkey) && p.body[publicPartLength(p.body)] !== 0);
}

/** The secret key block with every protected secret packet unlocked with `passphrase` (stored sealed under the KEK instead). */
export function unlockSecretKeyBlock(block: Uint8Array, passphrase: string): Buffer {
  return Buffer.concat(
    readPackets(block).map((p: Packet) => {
      if (p.tag !== Tag.SecretKey && p.tag !== Tag.SecretSubkey) return encodePacket(p.tag, p.body);
      try {
        return encodePacket(p.tag, unlockBody(p.body, passphrase));
      } catch (err) {
        // A subkey stub (gpg's --export-secret-subkeys leaves the primary as one) is kept public.
        if (err instanceof UnsupportedError && err.reason === 'gnu-dummy-s2k' && p.tag === Tag.SecretSubkey) return encodePacket(Tag.PublicSubkey, p.body.subarray(0, publicPartLength(p.body)));
        throw err;
      }
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Encryption: PKESK v3 + SEIPD v1

const WRAP_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex');

/** RFC 8017 §7.2.1 EME-PKCS1-v1_5 encoding of `m` into `k` octets. */
function emePkcs1(m: Buffer, k: number): Buffer {
  if (m.length > k - 11) throw new PgpError('rsa-message-too-long');
  const ps = Buffer.alloc(k - m.length - 3);
  for (let i = 0; i < ps.length; ) {
    const fill = randomBytes(ps.length - i + 16);
    for (const b of fill) {
      if (b !== 0 && i < ps.length) ps[i++] = b;
    }
  }
  return Buffer.concat([Buffer.of(0, 2), ps, Buffer.of(0), m]);
}

/** One PKESK v3 body for `recipient` carrying `sessionKey` = algo || key || checksum. */
function pkesk(recipient: KeyMaterial, sessionKey: Buffer): Buffer {
  const pub = recipient.publicKey;
  if (pub === null) throw new UnsupportedError(recipient.unsupported ?? 'key-unusable');
  const head = Buffer.concat([Buffer.of(3), Buffer.from(recipient.keyId, 'hex'), Buffer.of(recipient.algorithm)]);
  if (recipient.algorithm === 1 || recipient.algorithm === 2) {
    const k = Math.ceil((recipient.bits ?? 0) / 8);
    // RSA without padding (node:crypto does the modular exponentiation); the padding is written here.
    const c = publicEncrypt({ key: pub, padding: constants.RSA_NO_PADDING }, emePkcs1(sessionKey, k));
    return Buffer.concat([head, encodeMpi(c)]);
  }
  if (recipient.algorithm === 18 && recipient.curveOid === OID.curve25519Legacy) {
    const eph = generateKeyPairSync('x25519');
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
    const kek = ecdhKdf(shared, recipient);
    // RFC 6637 §8: PKCS#5 padding to a multiple of 8 octets.
    const n = 8 - (sessionKey.length % 8);
    const padded = Buffer.concat([sessionKey, Buffer.alloc(n, n)]);
    const w = createCipheriv(`id-aes${String(kek.length * 8)}-wrap`, kek, WRAP_IV);
    const wrapped = Buffer.concat([w.update(padded), w.final()]);
    const point = Buffer.concat([Buffer.of(0x40), jwkBytes(eph.publicKey, 'x')]);
    return Buffer.concat([head, encodeMpi(point), Buffer.of(wrapped.length), wrapped]);
  }
  throw new UnsupportedError(`pkesk-algorithm-${String(recipient.algorithm)}`, `encrypting to ${recipient.algorithmName} is not supported`);
}

/** A literal data packet (RFC 9580 §5.9), binary format, no file name. */
export function literalPacket(data: Uint8Array, created: Date = new Date()): Buffer {
  return encodePacket(Tag.Literal, Buffer.concat([Buffer.of(0x62, 0), u32(seconds(created)), Buffer.from(data)]));
}

/** SEIPD v1 (RFC 9580 §5.13.1): AES-256-CFB, zero IV, over random prefix || packets || MDC packet. */
function seipdV1(packets: Buffer, key: Buffer): Buffer {
  const prefix = randomBytes(16);
  const plain = Buffer.concat([prefix, prefix.subarray(14), packets, Buffer.of(0xd3, 0x14)]);
  const mdc = createHash('sha1').update(plain).digest();
  const c = createCipheriv('aes-256-cfb', key, Buffer.alloc(16));
  const ct = Buffer.concat([c.update(Buffer.concat([plain, mdc])), c.final()]);
  return encodePacket(Tag.SEIPD, Buffer.concat([Buffer.of(1), ct]));
}

export interface EncryptedRecipient {
  fingerprint: string;
  keyId: string;
  algorithm: string;
}

export interface EncryptResult {
  binary: Buffer;
  armored: string;
  recipients: EncryptedRecipient[];
}

/**
 * Encrypt `plaintext` (as one literal packet) to every key in `keys`: one PKESK per encryption
 * key each block allows (validity.ts encryptionMaterials), then SEIPD v1 under a fresh AES-256
 * session key. Throws when a key has nothing to encrypt to — never silently drops a recipient.
 */
export function encryptMessage(keys: readonly OpenPgpKey[], plaintext: Uint8Array, opts: { now?: Date } = {}): EncryptResult {
  if (keys.length === 0) throw new PgpError('no-recipients');
  const now = opts.now ?? new Date();
  const session = randomBytes(32);
  const sk = Buffer.concat([Buffer.of(9), session, u16(checksum16(session))]);
  const out: Buffer[] = [];
  const recipients: EncryptedRecipient[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const { materials, reason } = encryptionMaterials(key, now);
    if (materials.length === 0) throw new UnsupportedError('recipient-cannot-encrypt', `${key.primary.fingerprint}: ${reason ?? 'no encryption key'}`);
    for (const m of materials) {
      if (seen.has(m.fingerprint)) continue;
      seen.add(m.fingerprint);
      out.push(encodePacket(Tag.PKESK, pkesk(m, sk)));
      recipients.push({ fingerprint: m.fingerprint, keyId: m.keyId, algorithm: m.algorithmName });
    }
  }
  out.push(seipdV1(literalPacket(plaintext, now), session));
  const binary = Buffer.concat(out);
  return { binary, armored: encodeArmor('PGP MESSAGE', binary), recipients };
}

