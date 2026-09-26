// OpenPGP v4 signature packets (RFC 9580 §5.2.3): hashed and unhashed subpackets, the hash
// trailer (§5.2.4), and verification of a finished digest with a key's node:crypto KeyObject.
//
// Verification works on a digest the caller computed incrementally (the signed MIME part is hashed
// as it streams past), so a 100 MB signed message is never held whole:
//   Ed25519 / EdDSALegacy  crypto.verify(null, digest, key, r||s) — OpenPGP's EdDSA message IS the digest
//   RSA                    crypto.publicDecrypt(PKCS#1 v1.5) recovers the DigestInfo, compared in constant time
// ECDSA would need a prehashed verify that node:crypto does not offer, so it is refused by name.

import { createHash, constants, publicDecrypt, timingSafeEqual, verify as cryptoVerify, type Hash } from 'node:crypto';
import { Reader, padStart } from './bytes.js';
import { PgpError, UnsupportedError } from './errors.js';
import { readMpi } from './packets.js';
import type { KeyMaterial } from './keys.js';

export const HashAlgorithm: Record<number, string> = {
  2: 'sha1',
  8: 'sha256',
  9: 'sha384',
  10: 'sha512',
  11: 'sha224',
  12: 'sha3-256',
  14: 'sha3-512',
};

export function hashName(id: number): string {
  const n = HashAlgorithm[id];
  if (n === undefined) throw new UnsupportedError(`hash-algorithm-${String(id)}`, id === 1 ? 'MD5 signatures are not accepted' : `hash algorithm ${String(id)}`);
  return n;
}

/** DER DigestInfo prefixes (RFC 8017 §9.2 note 1). */
const DIGEST_INFO: Record<string, string> = {
  sha1: '3021300906052b0e03021a05000414',
  sha224: '302d300d06096086480165030402040500041c',
  sha256: '3031300d060960864801650304020105000420',
  sha384: '3041300d060960864801650304020205000430',
  sha512: '3051300d060960864801650304020305000440',
  'sha3-256': '3031300d060960864801650304020805000420',
  'sha3-512': '3051300d060960864801650304020a05000440',
};

export const SignatureType = {
  Binary: 0x00,
  Text: 0x01,
} as const;

export interface Subpacket {
  type: number;
  critical: boolean;
  body: Buffer;
}

export interface SignaturePacket {
  version: number;
  type: number;
  publicKeyAlgorithm: number;
  hashAlgorithm: number;
  /** version .. end of hashed subpackets: what the trailer hashes. */
  hashedPrefix: Buffer;
  hashed: Subpacket[];
  unhashed: Subpacket[];
  created: Date | null;
  expiresSeconds: number | null;
  issuerKeyId: string | null;
  issuerFingerprint: string | null;
  left16: Buffer;
  /** Algorithm-specific values: RSA [s]; EdDSALegacy/ECDSA [r, s]; Ed25519 [sig64]. */
  values: Buffer[];
}

const fail = (m: string): PgpError => new PgpError('signature-truncated', `signature packet: ${m}`);

function readSubpackets(r: Reader, len: number): Subpacket[] {
  const end = r.pos + len;
  if (end > r.end) throw fail('subpacket area past end');
  const sub = new Reader(r.buf, fail, r.pos, end);
  const out: Subpacket[] = [];
  while (sub.remaining > 0) {
    const first = sub.u8();
    let l: number;
    if (first < 192) l = first;
    else if (first < 255) l = ((first - 192) << 8) + sub.u8() + 192;
    else l = sub.u32();
    if (l < 1) throw new PgpError('signature-bad-subpacket');
    const t = sub.u8();
    out.push({ type: t & 0x7f, critical: (t & 0x80) !== 0, body: sub.bytes(l - 1) });
  }
  r.pos = end;
  return out;
}

export function parseSignaturePacket(body: Buffer): SignaturePacket {
  const r = new Reader(body, fail);
  const version = r.u8();
  if (version === 3) throw new UnsupportedError('v3-signature');
  if (version !== 4) throw new UnsupportedError(`v${String(version)}-signature`);
  const type = r.u8();
  const publicKeyAlgorithm = r.u8();
  const hashAlgorithm = r.u8();
  const hashedLen = r.u16();
  const hashed = readSubpackets(r, hashedLen);
  const hashedPrefix = body.subarray(0, r.pos);
  const unhashedLen = r.u16();
  const unhashed = readSubpackets(r, unhashedLen);
  const left16 = r.bytes(2);
  const values: Buffer[] = [];
  switch (publicKeyAlgorithm) {
    case 1:
    case 3:
      values.push(readMpi(r));
      break;
    case 17:
    case 19:
    case 22:
      values.push(readMpi(r), readMpi(r));
      break;
    case 27:
      values.push(r.bytes(64));
      break;
    case 28:
      values.push(r.bytes(114));
      break;
    default:
      throw new UnsupportedError(`signature-algorithm-${String(publicKeyAlgorithm)}`);
  }
  let created: Date | null = null;
  let expiresSeconds: number | null = null;
  let issuerKeyId: string | null = null;
  let issuerFingerprint: string | null = null;
  for (const s of hashed) {
    if (s.type === 2 && s.body.length === 4) created = new Date(s.body.readUInt32BE(0) * 1000);
    else if (s.type === 3 && s.body.length === 4) expiresSeconds = s.body.readUInt32BE(0);
    else if (s.type === 33 && s.body.length >= 21) issuerFingerprint = s.body.subarray(1).toString('hex').toUpperCase();
    else if (s.type === 16 && s.body.length === 8) issuerKeyId = s.body.toString('hex').toUpperCase();
    else if (s.critical && !KNOWN_CRITICAL.has(s.type)) throw new UnsupportedError(`critical-subpacket-${String(s.type)}`);
  }
  // Issuer subpackets are allowed in the unhashed area (they only help find the key).
  for (const s of unhashed) {
    if (s.type === 16 && s.body.length === 8) issuerKeyId ??= s.body.toString('hex').toUpperCase();
    else if (s.type === 33 && s.body.length >= 21) issuerFingerprint ??= s.body.subarray(1).toString('hex').toUpperCase();
  }
  if (issuerKeyId === null && issuerFingerprint !== null && issuerFingerprint.length === 40) issuerKeyId = issuerFingerprint.slice(24);
  return { version, type, publicKeyAlgorithm, hashAlgorithm, hashedPrefix, hashed, unhashed, created, expiresSeconds, issuerKeyId, issuerFingerprint, left16, values };
}

/** Subpackets whose meaning we honour, so a critical one is not a reason to refuse. */
const KNOWN_CRITICAL = new Set([2, 3, 16, 27, 33, 11, 21, 22, 30, 23, 25, 20]);

/** RFC 9580 §5.2.4: hashedPrefix || 0x04 0xFF || four-octet length of hashedPrefix. */
export function signatureTrailer(sig: SignaturePacket): Buffer {
  const tail = Buffer.alloc(6);
  tail[0] = 0x04;
  tail[1] = 0xff;
  tail.writeUInt32BE(sig.hashedPrefix.length, 2);
  return Buffer.concat([sig.hashedPrefix, tail]);
}

/** Finish a data hash with the signature's trailer. `h` is consumed. */
export function finishDigest(h: Hash, sig: SignaturePacket): Buffer {
  return h.update(signatureTrailer(sig)).digest();
}

/** The whole digest for a signature over in-memory data (clearsigned text, a literal packet). */
export function digestFor(sig: SignaturePacket, data: Uint8Array): Buffer {
  return finishDigest(createHash(hashName(sig.hashAlgorithm)).update(data), sig);
}

/**
 * True when `sig` is a valid signature by `key` over the data that produced `digest`. Throws
 * UnsupportedError for combinations that cannot be checked here.
 */
export function verifyDigest(sig: SignaturePacket, digest: Buffer, key: KeyMaterial): boolean {
  if (sig.hashAlgorithm === 2) throw new UnsupportedError('sha1-signature', 'SHA-1 document signatures are not accepted (RFC 9580 §9.5)');
  if (key.publicKey === null) throw new UnsupportedError(key.unsupported ?? 'key-unusable');
  if (sig.left16.length !== 2 || sig.left16[0] !== digest[0] || sig.left16[1] !== digest[1]) return false;
  const pk = key.publicKey;
  switch (sig.publicKeyAlgorithm) {
    case 22:
    case 27: {
      if (key.algorithm !== 22 && key.algorithm !== 27) return false;
      const raw = sig.publicKeyAlgorithm === 27 ? sig.values[0] : Buffer.concat([padStart(sig.values[0] ?? Buffer.alloc(0), 32), padStart(sig.values[1] ?? Buffer.alloc(0), 32)]);
      if (raw?.length !== 64) return false;
      try {
        return cryptoVerify(null, digest, pk, raw);
      } catch {
        return false;
      }
    }
    case 1:
    case 3: {
      if (key.algorithm !== 1 && key.algorithm !== 3) return false;
      const prefix = DIGEST_INFO[hashName(sig.hashAlgorithm)];
      if (prefix === undefined) throw new UnsupportedError('rsa-hash');
      const bytes = Math.ceil((key.bits ?? 0) / 8);
      const s = padStart(sig.values[0] ?? Buffer.alloc(0), bytes);
      let recovered: Buffer;
      try {
        recovered = publicDecrypt({ key: pk, padding: constants.RSA_PKCS1_PADDING }, s);
      } catch {
        return false;
      }
      const expected = Buffer.concat([Buffer.from(prefix, 'hex'), digest]);
      return recovered.length === expected.length && timingSafeEqual(recovered, expected);
    }
    case 19:
      throw new UnsupportedError('ecdsa', 'node:crypto has no prehashed ECDSA verify');
    default:
      throw new UnsupportedError(`signature-algorithm-${String(sig.publicKeyAlgorithm)}`);
  }
}
