// AES-256-GCM, the one AEAD this package uses, and the small-data formats built on it.
//
// Node has no XChaCha20-Poly1305, so every format uses AES-256-GCM with a 12-byte nonce and a
// 16-byte tag, and starts with a format byte naming both layout and algorithm, so either can change
// later without guessing. Format bytes are distinct per layout so one kind of ciphertext can never
// be parsed as another:
//
//   0x01  KEK-sealed   [0x01][kekId 8][nonce 12][ciphertext n][tag 16]   AAD = 0x01 || kekId || aad
//   0x11  DEK buffer   [0x11][nonce 12][ciphertext n][tag 16]            AAD = 0x11 || aad
//   0x21  DEK stream   see stream.ts
//
// A wrapped DEK is a KEK-sealed 32-byte DEK: 1 + 8 + 12 + 32 + 16 = 69 bytes. Its AAD should bind it
// to its blob (the blob's SHA-256), so a wrapped DEK cannot be moved onto another blob's row.
//
// Nonces are random. For the KEK that is the standard GCM random-nonce bound (2^32 messages per
// key), which a single-domain mail server will not approach; DEKs are single-use per blob.

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { DecryptError } from './errors.js';
import { KEK_ID_BYTES, kekKeyObject, type Kek } from './kek.js';

export const DEK_BYTES = 32;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export const FORMAT_KEK_SEALED = 0x01;
export const FORMAT_DEK_BUFFER = 0x11;
export const FORMAT_DEK_STREAM = 0x21;

export const WRAPPED_DEK_BYTES = 1 + KEK_ID_BYTES + NONCE_BYTES + DEK_BYTES + TAG_BYTES;

/** Associated data: bytes, or a string taken as UTF-8 (e.g. a blob's sha256 hex). */
export type Aad = Uint8Array | string;

export function aadBytes(aad: Aad): Buffer {
  return typeof aad === 'string' ? Buffer.from(aad, 'utf8') : Buffer.from(aad);
}

/** A fresh random 32-byte data-encryption key, one per blob. */
export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

export function assertDek(dek: Uint8Array): void {
  if (dek.length !== DEK_BYTES) {
    throw new RangeError(`DEK must be exactly ${DEK_BYTES} bytes (got ${dek.length})`);
  }
}

type Key = KeyObject | Uint8Array;

/** Seal one message. Returns ciphertext || tag. */
export function gcmSeal(key: Key, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const head = cipher.update(plaintext);
  const tail = cipher.final();
  return Buffer.concat([head, tail, cipher.getAuthTag()]);
}

/**
 * Open ciphertext || tag. Throws DecryptError on any authentication failure; plaintext is only
 * returned after `final()` has verified the tag.
 */
export function gcmOpen(key: Key, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Buffer {
  if (sealed.length < TAG_BYTES) throw new DecryptError('ciphertext too short');
  const ct = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const head = decipher.update(ct);
    const tail = decipher.final();
    return Buffer.concat([head, tail]);
  } catch {
    throw new DecryptError('authentication failed');
  }
}

// ---- KEK-sealed (format 0x01) ----

/**
 * Seal small data directly under the KEK, recording the KEK id. Used for wrapped DEKs, and later
 * for DKIM private keys and TOTP secrets (PST-ADR-009).
 */
export function sealWithKek(kek: Kek, plaintext: Uint8Array, aad: Aad): Buffer {
  const header = Buffer.concat([Buffer.of(FORMAT_KEK_SEALED), kek.idBytes()]);
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = gcmSeal(kekKeyObject(kek), nonce, Buffer.concat([header, aadBytes(aad)]), plaintext);
  return Buffer.concat([header, nonce, sealed]);
}

/** The KEK id (hex) recorded in a KEK-sealed value, or undefined if it is not one. */
export function sealedKekId(sealed: Uint8Array): string | undefined {
  if (sealed.length < 1 + KEK_ID_BYTES || sealed[0] !== FORMAT_KEK_SEALED) return undefined;
  return Buffer.from(sealed.subarray(1, 1 + KEK_ID_BYTES)).toString('hex');
}

export function openWithKek(kek: Kek, sealed: Uint8Array, aad: Aad): Buffer {
  const min = 1 + KEK_ID_BYTES + NONCE_BYTES + TAG_BYTES;
  if (sealed.length < min) throw new DecryptError('KEK-sealed value too short');
  if (sealed[0] !== FORMAT_KEK_SEALED) throw new DecryptError('unknown KEK-sealed format');
  const header = sealed.subarray(0, 1 + KEK_ID_BYTES);
  if (sealedKekId(sealed) !== kek.id) {
    throw new DecryptError('sealed under a different KEK');
  }
  const nonce = sealed.subarray(header.length, header.length + NONCE_BYTES);
  const body = sealed.subarray(header.length + NONCE_BYTES);
  return gcmOpen(kekKeyObject(kek), nonce, Buffer.concat([header, aadBytes(aad)]), body);
}

/** Wrap a 32-byte DEK under the KEK. `aad` should identify the blob (its sha256). 69 bytes out. */
export function wrapDek(kek: Kek, dek: Uint8Array, aad: Aad): Buffer {
  assertDek(dek);
  return sealWithKek(kek, dek, aad);
}

export function unwrapDek(kek: Kek, wrapped: Uint8Array, aad: Aad): Buffer {
  if (wrapped.length !== WRAPPED_DEK_BYTES) throw new DecryptError('wrapped DEK has the wrong length');
  return openWithKek(kek, wrapped, aad);
}

// ---- DEK buffer (format 0x11) ----

/** Encrypt small data under a DEK (or any 32-byte key) in one shot. */
export function encryptBuffer(key: Uint8Array, plaintext: Uint8Array, aad: Aad): Buffer {
  assertDek(key);
  const format = Buffer.of(FORMAT_DEK_BUFFER);
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = gcmSeal(key, nonce, Buffer.concat([format, aadBytes(aad)]), plaintext);
  return Buffer.concat([format, nonce, sealed]);
}

export function decryptBuffer(key: Uint8Array, data: Uint8Array, aad: Aad): Buffer {
  assertDek(key);
  if (data.length < 1 + NONCE_BYTES + TAG_BYTES) throw new DecryptError('ciphertext too short');
  if (data[0] !== FORMAT_DEK_BUFFER) throw new DecryptError('unknown buffer format');
  const nonce = data.subarray(1, 1 + NONCE_BYTES);
  return gcmOpen(key, nonce, Buffer.concat([data.subarray(0, 1), aadBytes(aad)]), data.subarray(1 + NONCE_BYTES));
}
