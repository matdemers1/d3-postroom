// OpenPGP public and secret key packets (RFC 9580 §5.5), the v4 fingerprint and key ID
// (§5.5.4.2), and transferable keys (§10.1). Key material becomes a node:crypto KeyObject built
// from a JWK — the only place the primitive enters; the format is read here.
//
// Supported: v4 keys with RSA (1/2/3), EdDSALegacy over Ed25519 (22), ECDH over Curve25519Legacy
// (18), native Ed25519 (27) and X25519 (25). Everything else parses (so a key with an unsupported
// subkey still loads) but carries a named `unsupported` reason and no KeyObject. v6 keys are refused
// with `v6-key`: their fingerprints are SHA-256 over a different framing, and nothing we receive
// uses them yet.

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { Reader, b64url, padStart } from './bytes.js';
import { PgpError, UnsupportedError } from './errors.js';
import { readMpi, readPackets, Tag, type Packet } from './packets.js';

export const PublicKeyAlgorithm = {
  RSA: 1,
  RSAEncrypt: 2,
  RSASign: 3,
  Elgamal: 16,
  DSA: 17,
  ECDH: 18,
  ECDSA: 19,
  EdDSALegacy: 22,
  X25519: 25,
  X448: 26,
  Ed25519: 27,
  Ed448: 28,
} as const;

export const OID = {
  ed25519Legacy: '2b06010401da470f01',
  curve25519Legacy: '2b060104019755010501',
  p256: '2a8648ce3d030107',
  p384: '2b81040022',
  p521: '2b81040023',
} as const;

export function algorithmName(algo: number, curveOid: string | null = null): string {
  switch (algo) {
    case 1:
    case 2:
    case 3:
      return 'RSA';
    case 16:
      return 'Elgamal';
    case 17:
      return 'DSA';
    case 18:
      return curveOid === OID.curve25519Legacy ? 'ECDH Curve25519' : 'ECDH';
    case 19:
      return curveOid === OID.p256 ? 'ECDSA P-256' : curveOid === OID.p384 ? 'ECDSA P-384' : curveOid === OID.p521 ? 'ECDSA P-521' : 'ECDSA';
    case 22:
      return curveOid === OID.ed25519Legacy ? 'Ed25519 (EdDSALegacy)' : 'EdDSA';
    case 25:
      return 'X25519';
    case 26:
      return 'X448';
    case 27:
      return 'Ed25519';
    case 28:
      return 'Ed448';
    default:
      return `algorithm ${String(algo)}`;
  }
}

export interface KeyMaterial {
  version: number;
  algorithm: number;
  algorithmName: string;
  created: Date;
  /** Upper-case hex, as gpg prints it. */
  fingerprint: string;
  /** Upper-case hex of the low 64 bits of the fingerprint. */
  keyId: string;
  /** Curve OID (hex of the encoded OID body) for ECC algorithms. */
  curveOid: string | null;
  /** RSA modulus length in bits, when RSA. */
  bits: number | null;
  /** ECDH KDF parameters (RFC 6637 §9): hash and key-wrap algorithm IDs. */
  kdf: { hash: number; cipher: number } | null;
  /** The key usable with node:crypto, or null with `unsupported` naming why. */
  publicKey: KeyObject | null;
  /** The secret half, only when parsed from a secret key packet with unencrypted material. */
  secretKey: KeyObject | null;
  unsupported: string | null;
  /** The public key packet body (for the v4 fingerprint). */
  body: Buffer;
}

export interface OpenPgpKey {
  primary: KeyMaterial;
  subkeys: KeyMaterial[];
  userIds: string[];
  /** True when parsed from a secret key block. */
  secret: boolean;
}

/** v4 fingerprint: SHA-1 over 0x99 || two-octet length || public key packet body. */
export function v4Fingerprint(body: Uint8Array): Buffer {
  const head = Buffer.of(0x99, (body.length >> 8) & 0xff, body.length & 0xff);
  return createHash('sha1').update(head).update(body).digest();
}

const fail = (m: string): PgpError => new PgpError('key-truncated', `key packet: ${m}`);

function readOid(r: Reader): string {
  const len = r.u8();
  if (len === 0 || len === 255) throw new PgpError('key-bad-oid');
  return r.bytes(len).toString('hex');
}

function bytesToBigInt(b: Buffer): bigint {
  return b.length === 0 ? 0n : BigInt(`0x${b.toString('hex')}`);
}

function bigIntToBytes(n: bigint): Buffer {
  let h = n.toString(16);
  if (h.length % 2 === 1) h = `0${h}`;
  return Buffer.from(h, 'hex');
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new PgpError('key-bad-rsa-parameters');
  return ((oldS % m) + m) % m;
}

interface ParsedPublic {
  material: KeyMaterial;
  /** Algorithm-specific public values, kept for building the private JWK. */
  pub: { n?: Buffer; e?: Buffer; point?: Buffer };
  /** Where the public part ended inside the packet body. */
  end: number;
}

function parsePublicBody(body: Buffer): ParsedPublic {
  const r = new Reader(body, fail);
  const version = r.u8();
  if (version === 6 || version === 5) throw new UnsupportedError(`v${String(version)}-key`, `v${String(version)} keys are not supported`);
  if (version !== 4) throw new UnsupportedError(`v${String(version)}-key`, `key version ${String(version)} is not supported`);
  const created = new Date(r.u32() * 1000);
  const algorithm = r.u8();
  let curveOid: string | null = null;
  let bits: number | null = null;
  let kdf: KeyMaterial['kdf'] = null;
  let publicKey: KeyObject | null = null;
  let unsupported: string | null = null;
  const pub: ParsedPublic['pub'] = {};
  switch (algorithm) {
    case 1:
    case 2:
    case 3: {
      const n = readMpi(r);
      const e = readMpi(r);
      pub.n = n;
      pub.e = e;
      bits = n.length * 8 - Math.clz32(n[0] ?? 0) + 24;
      publicKey = tryKey(() => createPublicKey({ key: { kty: 'RSA', n: b64url(n), e: b64url(e) }, format: 'jwk' }));
      if (publicKey === null) unsupported = 'rsa-key-rejected';
      break;
    }
    case 16:
    case 17: {
      // p, q?, g, y — parse to skip, never use.
      const count = algorithm === 17 ? 4 : 3;
      for (let i = 0; i < count; i++) readMpi(r);
      unsupported = algorithm === 17 ? 'dsa' : 'elgamal';
      break;
    }
    case 18: {
      curveOid = readOid(r);
      const point = readMpi(r);
      const kl = r.u8();
      if (kl < 3) throw new PgpError('key-bad-kdf-params');
      const kp = r.bytes(kl);
      if (kp[0] !== 1) throw new UnsupportedError('ecdh-kdf-params-version');
      kdf = { hash: kp[1] ?? 0, cipher: kp[2] ?? 0 };
      pub.point = point;
      if (curveOid === OID.curve25519Legacy) {
        if (point.length !== 33 || point[0] !== 0x40) throw new PgpError('key-bad-curve25519-point');
        publicKey = tryKey(() => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64url(point.subarray(1)) }, format: 'jwk' }));
      } else unsupported = 'ecdh-curve';
      break;
    }
    case 19: {
      curveOid = readOid(r);
      pub.point = readMpi(r);
      unsupported = 'ecdsa';
      break;
    }
    case 22: {
      curveOid = readOid(r);
      const point = readMpi(r);
      pub.point = point;
      if (curveOid !== OID.ed25519Legacy) unsupported = 'eddsa-curve';
      else if (point.length !== 33 || point[0] !== 0x40) throw new PgpError('key-bad-ed25519-point');
      else publicKey = tryKey(() => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(point.subarray(1)) }, format: 'jwk' }));
      break;
    }
    case 25:
    case 27: {
      const point = r.bytes(32);
      pub.point = point;
      publicKey = tryKey(() => createPublicKey({ key: { kty: 'OKP', crv: algorithm === 25 ? 'X25519' : 'Ed25519', x: b64url(point) }, format: 'jwk' }));
      if (algorithm === 25) unsupported = 'x25519-native-pkesk';
      break;
    }
    case 26:
      r.bytes(56);
      unsupported = 'x448';
      break;
    case 28:
      r.bytes(57);
      unsupported = 'ed448';
      break;
    default:
      throw new UnsupportedError(`public-key-algorithm-${String(algorithm)}`);
  }
  const end = r.pos;
  const pubBody = body.subarray(0, end);
  const fp = v4Fingerprint(pubBody);
  return {
    material: {
      version,
      algorithm,
      algorithmName: algorithmName(algorithm, curveOid),
      created,
      fingerprint: fp.toString('hex').toUpperCase(),
      keyId: fp.subarray(12).toString('hex').toUpperCase(),
      curveOid,
      bits,
      kdf,
      publicKey,
      secretKey: null,
      unsupported,
      body: pubBody,
    },
    pub,
    end,
  };
}

function tryKey(make: () => KeyObject): KeyObject | null {
  try {
    return make();
  } catch {
    return null;
  }
}

/** A public key or public subkey packet body. */
export function parsePublicKeyPacket(body: Buffer): KeyMaterial {
  return parsePublicBody(body).material;
}

/**
 * A secret key or secret subkey packet body. Only unencrypted secret material (S2K usage 0) is
 * read: Postroom keeps private keys sealed under the KEK, so a passphrase-protected key must be
 * unlocked when it is imported (PST-T-12.2), and one arriving here is refused by name.
 */
export function parseSecretKeyPacket(body: Buffer): KeyMaterial {
  const parsed = parsePublicBody(body);
  const m = parsed.material;
  const r = new Reader(body, fail, parsed.end);
  const usage = r.u8();
  if (usage !== 0) throw new UnsupportedError('passphrase-protected-key', 'the secret key is passphrase-protected');
  const start = r.pos;
  switch (m.algorithm) {
    case 1:
    case 2:
    case 3: {
      const d = readMpi(r);
      const p = readMpi(r);
      const q = readMpi(r);
      readMpi(r); // u = p^-1 mod q; JWK wants qi = q^-1 mod p, derived below
      const { n, e } = parsed.pub;
      if (n === undefined || e === undefined) throw new PgpError('key-bad-rsa-parameters');
      const D = bytesToBigInt(d);
      const P = bytesToBigInt(p);
      const Q = bytesToBigInt(q);
      if (P < 2n || Q < 2n) throw new PgpError('key-bad-rsa-parameters');
      const jwk = {
        kty: 'RSA',
        n: b64url(n),
        e: b64url(e),
        d: b64url(d),
        p: b64url(p),
        q: b64url(q),
        dp: b64url(bigIntToBytes(D % (P - 1n))),
        dq: b64url(bigIntToBytes(D % (Q - 1n))),
        qi: b64url(bigIntToBytes(modInverse(Q, P))),
      };
      m.secretKey = tryKey(() => createPrivateKey({ key: jwk, format: 'jwk' }));
      break;
    }
    case 18: {
      const s = readMpi(r);
      if (m.curveOid === OID.curve25519Legacy && parsed.pub.point !== undefined) {
        // Curve25519Legacy secrets are stored big-endian: the reverse of the native encoding.
        const native = Buffer.from(padStart(Buffer.from(s), 32)).reverse();
        const x = parsed.pub.point.subarray(1);
        m.secretKey = tryKey(() => createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: b64url(native), x: b64url(x) }, format: 'jwk' }));
      }
      break;
    }
    case 22:
      readMpi(r);
      break;
    case 25:
      r.bytes(32);
      break;
    case 27:
      r.bytes(32);
      break;
    default:
      // Other algorithms: leave the material unread; the key stays usable for its public half.
      return m;
  }
  const material = body.subarray(start, r.pos);
  const checksum = r.u16();
  let sum = 0;
  for (const b of material) sum = (sum + b) & 0xffff;
  if (sum !== checksum) throw new PgpError('secret-key-checksum-mismatch');
  return m;
}

/** Transferable public or secret keys (RFC 9580 §10.1/§10.2) from binary packets. */
export function parseKeys(data: Uint8Array): OpenPgpKey[] {
  return keysFromPackets(readPackets(data));
}

export function keysFromPackets(packets: readonly Packet[]): OpenPgpKey[] {
  const keys: OpenPgpKey[] = [];
  let current: OpenPgpKey | null = null;
  for (const p of packets) {
    if (p.tag === Tag.PublicKey || p.tag === Tag.SecretKey) {
      const secret = p.tag === Tag.SecretKey;
      current = { primary: secret ? parseSecretKeyPacket(p.body) : parsePublicKeyPacket(p.body), subkeys: [], userIds: [], secret };
      keys.push(current);
    } else if (current === null) {
      if (p.tag === Tag.Marker) continue;
      throw new PgpError('key-block-no-primary', `packet tag ${String(p.tag)} before any primary key`);
    } else if (p.tag === Tag.UserId) {
      current.userIds.push(p.body.toString('utf8'));
    } else if (p.tag === Tag.PublicSubkey || p.tag === Tag.SecretSubkey) {
      try {
        current.subkeys.push(p.tag === Tag.SecretSubkey ? parseSecretKeyPacket(p.body) : parsePublicKeyPacket(p.body));
      } catch (err) {
        // An unsupported subkey does not make the rest of the key unusable.
        if (!(err instanceof UnsupportedError)) throw err;
      }
    }
    // Signatures, trust and user attributes are skipped: a key in the account's keyring is trusted
    // because the account put it there (import is PST-T-12.2), not because of its self-signatures.
  }
  return keys;
}

/** The address in a User ID like `Alice <alice@example.test>`, lowercased; null when there is none. */
export function userIdAddress(uid: string): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(uid) ?? /^([^<>\s]+@[^<>\s]+)$/.exec(uid.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

/** Every key in the block, primary first, then subkeys. */
export function allMaterials(key: OpenPgpKey): KeyMaterial[] {
  return [key.primary, ...key.subkeys];
}
