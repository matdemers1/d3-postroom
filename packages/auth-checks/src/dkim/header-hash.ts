// The signed data of a DKIM signature (RFC 6376 §3.7) and the two signature algorithms.
// Shared by the signer and the verifier so both hash exactly the same bytes.

import { createHash, sign, verify, type KeyObject } from 'node:crypto';
import { canonicalizeHeader, type Canonicalization } from './canon.js';
import type { DkimAlgorithm } from './keys.js';
import { selectHeaders, type HeaderField } from './message.js';

/**
 * The header hash input: each field selected by `hNames` (bottom-up, §5.4.2), canonicalized and
 * followed by CRLF, then the DKIM-Signature field itself with an empty b= value, canonicalized,
 * WITHOUT a trailing CRLF. `signatureField` is the raw field text (latin1) with b= already empty.
 */
export function headerHashInput(
  fields: readonly HeaderField[],
  hNames: readonly string[],
  signatureField: string,
  mode: Canonicalization,
): Buffer {
  const parts: string[] = [];
  for (const f of selectHeaders(fields, hNames)) {
    parts.push(canonicalizeHeader(f.raw, mode), '\r\n');
  }
  parts.push(canonicalizeHeader(signatureField, mode));
  return Buffer.from(parts.join(''), 'latin1');
}

/**
 * Sign the header hash input.
 * rsa-sha256: RSASSA-PKCS1-v1_5 with SHA-256 over the data (RFC 6376 §3.3.1).
 * ed25519-sha256: PureEdDSA (Ed25519) over the 32-byte SHA-256 digest of the data — the data is
 * hashed first, then that hash is what Ed25519 signs (RFC 8463 §3).
 */
export function signHeaderData(algorithm: DkimAlgorithm, privateKey: KeyObject, data: Uint8Array): Buffer {
  if (algorithm === 'rsa-sha256') return sign('sha256', data, privateKey);
  return sign(null, createHash('sha256').update(data).digest(), privateKey);
}

export function verifyHeaderData(
  algorithm: DkimAlgorithm,
  publicKey: KeyObject,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (algorithm === 'rsa-sha256') return verify('sha256', data, publicKey, signature);
  return verify(null, createHash('sha256').update(data).digest(), publicKey, signature);
}
