// OpenPGP decryption (RFC 9580 §5.1, §5.13; RFC 6637 for ECDH): PKESK v3 with RSA or ECDH over
// Curve25519Legacy, then SEIPD v1 (AES-CFB with a zero IV and the Modification Detection Code,
// RFC 4880 §5.13 / RFC 9580 §5.13.1), then compressed / one-pass-signature / literal packets.
//
// Primitives come from node:crypto: X25519 via crypto.diffieHellman, AES key unwrap (RFC 3394) via
// the 'id-aesN-wrap' ciphers, AES-CFB via 'aes-N-cfb', SHA-1/SHA-2 via createHash, inflate via
// node:zlib. The RFC 6637 KDF is one SHA-2 call over a byte string built here.
//
// Refused by name: SEIPD v2 (AEAD), LibrePGP's OCB packet (tag 20, gpg 2.4+ to AEAD-capable keys),
// the unprotected SED packet (tag 9 — no integrity, never decrypted), non-AES ciphers, BZip2.

import { createDecipheriv, createHash, createPublicKey, diffieHellman, timingSafeEqual } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { Reader, b64url } from './bytes.js';
import { PgpError, UnsupportedError } from './errors.js';
import { algorithmName, OID, type KeyMaterial } from './keys.js';
import { readMpi, readPackets, Tag, type Packet } from './packets.js';
import { rsaPkcs1Decrypt } from './rsa.js';
import { HashAlgorithm, parseSignaturePacket, type SignaturePacket } from './signature.js';

export const SymmetricAlgorithm: Record<number, { name: string; cipher: string; keyBytes: number } | undefined> = {
  7: { name: 'AES-128', cipher: 'aes-128', keyBytes: 16 },
  8: { name: 'AES-192', cipher: 'aes-192', keyBytes: 24 },
  9: { name: 'AES-256', cipher: 'aes-256', keyBytes: 32 },
};

export interface DecryptionKey {
  material: KeyMaterial;
  /** Opaque id handed back when this key opened the message (a CryptoKey row id). */
  ref: string;
}

export interface PkeskInfo {
  version: number;
  keyId: string;
  algorithm: string;
  /** The `ref` of the key that matched, or null. */
  matched: string | null;
}

export interface InnerSignature {
  signature: SignaturePacket;
  /** The literal data it covers, canonicalized when the signature is a text signature. */
  data: Buffer;
}

export type DecryptStatus = 'decrypted' | 'no-key' | `failed:${string}`;

export interface PgpDecryptResult {
  status: DecryptStatus;
  recipients: PkeskInfo[];
  cipher: string | null;
  integrity: 'mdc' | null;
  plaintext: Buffer | null;
  filename: string | null;
  signatures: InnerSignature[];
  /** The ref of the key that opened it. */
  openedWith: string | null;
}

export interface DecryptOptions {
  /** Cap on decrypted and decompressed bytes (default 64 MiB). */
  maxPlaintext?: number;
}

const fail = (m: string): PgpError => new PgpError('pkesk-truncated', m);

interface Pkesk {
  info: PkeskInfo;
  algo: number;
  body: Reader;
}

function parsePkesk(p: Packet): Pkesk | null {
  const r = new Reader(p.body, fail);
  const version = r.u8();
  if (version !== 3) return { info: { version, keyId: '', algorithm: 'unknown', matched: null }, algo: -1, body: r };
  const keyId = r.bytes(8).toString('hex').toUpperCase();
  const algo = r.u8();
  return { info: { version, keyId, algorithm: algorithmName(algo), matched: null }, algo, body: r };
}

/** RFC 6637 §8: the KDF over the X25519 shared secret. */
export function ecdhKdf(shared: Buffer, key: KeyMaterial): Buffer {
  if (key.kdf === null || key.curveOid === null) throw new PgpError('ecdh-no-kdf-params');
  const hash = HashAlgorithm[key.kdf.hash];
  const sym = SymmetricAlgorithm[key.kdf.cipher];
  if (hash === undefined) throw new UnsupportedError(`ecdh-kdf-hash-${String(key.kdf.hash)}`);
  if (sym === undefined) throw new UnsupportedError(`ecdh-kek-cipher-${String(key.kdf.cipher)}`);
  const oid = Buffer.from(key.curveOid, 'hex');
  const param = Buffer.concat([
    Buffer.of(oid.length),
    oid,
    Buffer.of(18, 0x03, 0x01, key.kdf.hash, key.kdf.cipher),
    Buffer.from('Anonymous Sender    ', 'latin1'),
    Buffer.from(key.fingerprint, 'hex'),
  ]);
  const digest = createHash(hash).update(Buffer.of(0, 0, 0, 1)).update(shared).update(param).digest();
  if (digest.length < sym.keyBytes) throw new UnsupportedError('ecdh-kdf-too-short');
  return digest.subarray(0, sym.keyBytes);
}

const WRAP_IV = Buffer.from('A6A6A6A6A6A6A6A6', 'hex');

/** Session key bytes `algo || key || checksum` from one PKESK, or null when this key cannot open it. */
function sessionKeyFrom(pk: Pkesk, key: KeyMaterial): Buffer | null {
  const secret = key.secretKey;
  if (secret === null) return null;
  const r = new Reader(pk.body.buf, fail, pk.body.pos, pk.body.end);
  if (pk.algo === 1 || pk.algo === 2) {
    if (key.algorithm !== 1 && key.algorithm !== 2) return null;
    return rsaPkcs1Decrypt(secret, readMpi(r));
  }
  if (pk.algo === 18) {
    if (key.algorithm !== 18 || key.curveOid !== OID.curve25519Legacy) return null;
    const point = readMpi(r);
    const wrapped = r.bytes(r.u8());
    if (point.length !== 33 || point[0] !== 0x40) throw new PgpError('ecdh-bad-ephemeral');
    const ephemeral = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64url(point.subarray(1)) }, format: 'jwk' });
    const shared = diffieHellman({ privateKey: secret, publicKey: ephemeral });
    const kek = ecdhKdf(shared, key);
    let unwrapped: Buffer;
    try {
      const d = createDecipheriv(`id-aes${String(kek.length * 8)}-wrap`, kek, WRAP_IV);
      unwrapped = Buffer.concat([d.update(wrapped), d.final()]);
    } catch {
      return null;
    }
    // RFC 6637 §8: PKCS#5 padding to a multiple of 8.
    const n = unwrapped[unwrapped.length - 1] ?? 0;
    if (n < 1 || n > 8 || n > unwrapped.length) return null;
    for (let i = unwrapped.length - n; i < unwrapped.length; i++) if (unwrapped[i] !== n) return null;
    return unwrapped.subarray(0, unwrapped.length - n);
  }
  throw new UnsupportedError(`pkesk-algorithm-${String(pk.algo)}`);
}

function checkSessionKey(m: Buffer): { algo: number; key: Buffer } | null {
  if (m.length < 3) return null;
  const algo = m[0] ?? 0;
  const key = m.subarray(1, m.length - 2);
  const sum = m.readUInt16BE(m.length - 2);
  let s = 0;
  for (const b of key) s = (s + b) & 0xffff;
  if (s !== sum) return null;
  return { algo, key };
}

/** SEIPD v1: AES-CFB with a zero IV over prefix || data || MDC packet; the MDC is SHA-1 over all of it but the hash. */
function openSeipdV1(body: Buffer, algo: number, key: Buffer, max: number): Buffer {
  const sym = SymmetricAlgorithm[algo];
  if (sym === undefined) throw new UnsupportedError(`cipher-${String(algo)}`);
  if (key.length !== sym.keyBytes) throw new PgpError('session-key-length');
  const ct = body.subarray(1);
  if (ct.length > max + 64) throw new PgpError('too-large');
  const d = createDecipheriv(`${sym.cipher}-cfb`, key, Buffer.alloc(16));
  const plain = Buffer.concat([d.update(ct), d.final()]);
  const bs = 16;
  if (plain.length < bs + 2 + 22) throw new PgpError('seipd-too-short');
  const mdcAt = plain.length - 22;
  if (plain[mdcAt] !== 0xd3 || plain[mdcAt + 1] !== 0x14) throw new PgpError('mdc-mismatch');
  const want = createHash('sha1').update(plain.subarray(0, mdcAt + 2)).digest();
  if (!timingSafeEqual(want, plain.subarray(mdcAt + 2))) throw new PgpError('mdc-mismatch');
  return plain.subarray(bs + 2, mdcAt);
}

interface Opened {
  plaintext: Buffer;
  filename: string | null;
  signatures: InnerSignature[];
}

function toCrlf(data: Buffer): Buffer {
  const s = data.toString('latin1').replace(/\r?\n/g, '\r\n');
  return Buffer.from(s, 'latin1');
}

/** Compressed / one-pass-signature / literal / signature packets inside the decrypted data. */
export function readMessagePackets(data: Buffer, max: number, depth = 0): Opened {
  if (depth > 4) throw new PgpError('nesting-too-deep');
  const packets = readPackets(data);
  let literal: Buffer | null = null;
  let filename: string | null = null;
  const sigs: SignaturePacket[] = [];
  for (const p of packets) {
    if (p.tag === Tag.Compressed) {
      const algo = p.body[0];
      const rest = p.body.subarray(1);
      let out: Buffer;
      try {
        if (algo === 0) out = rest;
        else if (algo === 1) out = inflateRawSync(rest, { maxOutputLength: max });
        else if (algo === 2) out = inflateSync(rest, { maxOutputLength: max });
        else throw new UnsupportedError(algo === 3 ? 'bzip2' : `compression-${String(algo)}`);
      } catch (err) {
        if (err instanceof PgpError) throw err;
        throw new PgpError('decompression', err instanceof Error ? err.message : 'inflate failed');
      }
      return readMessagePackets(out, max, depth + 1);
    }
    if (p.tag === Tag.Literal) {
      const r = new Reader(p.body, (m) => new PgpError('literal-truncated', m));
      r.u8(); // format: b, t, u, m
      filename = r.bytes(r.u8()).toString('utf8');
      r.u32();
      literal = r.rest();
    } else if (p.tag === Tag.Signature) {
      sigs.push(parseSignaturePacket(p.body));
    } else if (p.tag === Tag.OnePassSignature || p.tag === Tag.Marker || p.tag === Tag.Padding) {
      continue;
    } else {
      throw new PgpError('unexpected-packet', `packet tag ${String(p.tag)} inside the encrypted message`);
    }
  }
  if (literal === null) throw new PgpError('no-literal-data');
  const plaintext = literal;
  return {
    plaintext,
    filename: filename === '' ? null : filename,
    signatures: sigs.map((signature) => ({ signature, data: signature.type === 0x01 ? toCrlf(plaintext) : plaintext })),
  };
}

/**
 * Decrypts a binary OpenPGP message with whichever of `keys` a PKESK names. Never throws for bad
 * input: every failure is a status with a named reason.
 */
export function decryptMessage(data: Uint8Array, keys: readonly DecryptionKey[], opts: DecryptOptions = {}): PgpDecryptResult {
  const max = opts.maxPlaintext ?? 64 * 1024 * 1024;
  const result: PgpDecryptResult = { status: 'no-key', recipients: [], cipher: null, integrity: null, plaintext: null, filename: null, signatures: [], openedWith: null };
  const failed = (reason: string): PgpDecryptResult => ({ ...result, status: `failed:${reason}` });
  try {
    const packets = readPackets(data);
    const pkesks: Pkesk[] = [];
    let encrypted: Packet | null = null;
    for (const p of packets) {
      if (p.tag === Tag.PKESK) {
        const pk = parsePkesk(p);
        if (pk !== null) pkesks.push(pk);
      } else if (p.tag === Tag.SEIPD || p.tag === Tag.SED || p.tag === Tag.OCB) {
        encrypted = p;
        break;
      }
    }
    result.recipients = pkesks.map((p) => p.info);
    if (encrypted === null) return failed('no-encrypted-data');
    if (encrypted.tag === Tag.OCB) return failed('unsupported-librepgp-ocb');
    if (encrypted.tag === Tag.SED) return failed('no-integrity-protection');
    const version = encrypted.body[0];
    if (version === 2) return failed('unsupported-seipd-v2');
    if (version !== 1) return failed(`unsupported-seipd-v${String(version ?? 0)}`);

    let session: { algo: number; key: Buffer } | null = null;
    let anyMatch = false;
    for (const pk of pkesks) {
      if (pk.info.version !== 3) continue;
      const wildcard = /^0+$/.test(pk.info.keyId);
      for (const k of keys) {
        if (!wildcard && k.material.keyId !== pk.info.keyId) continue;
        if (k.material.secretKey === null) continue;
        anyMatch = true;
        pk.info.matched = k.ref;
        const m = sessionKeyFrom(pk, k.material);
        const sk = m === null ? null : checkSessionKey(m);
        if (sk !== null) {
          session = sk;
          result.openedWith = k.ref;
          break;
        }
        if (wildcard) pk.info.matched = null;
      }
      if (session !== null) break;
    }
    if (session === null) return anyMatch ? failed('session-key') : result;
    result.cipher = SymmetricAlgorithm[session.algo]?.name ?? `cipher ${String(session.algo)}`;
    const inner = openSeipdV1(encrypted.body, session.algo, session.key, max);
    result.integrity = 'mdc';
    const opened = readMessagePackets(inner, max);
    return { ...result, status: 'decrypted', plaintext: opened.plaintext, filename: opened.filename, signatures: opened.signatures };
  } catch (err) {
    if (err instanceof UnsupportedError) return failed(`unsupported-${err.reason}`);
    if (err instanceof PgpError) return failed(err.reason);
    throw err;
  }
}
