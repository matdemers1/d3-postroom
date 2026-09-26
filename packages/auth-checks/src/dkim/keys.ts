// DKIM keys: generation, DNS TXT records, and KEK sealing (PST-REQ-038, PST-REQ-039).
//
// A DKIM private key is only ever stored sealed by the KEK: `sealDkimKey` exports PKCS#8 DER,
// seals it with `sealWithKek`, and zeroes the plaintext export. The AAD should bind the sealed key to
// its row (e.g. "dkim:<domain>:<selector>") so a sealed key cannot be moved onto another selector.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { openWithKek, sealWithKek, type Aad, type Kek } from '@postroom/crypto';
import { DkimError } from './errors.js';
import { parseTagList, stripWhitespace } from './tags.js';

export type DkimAlgorithm = 'rsa-sha256' | 'ed25519-sha256';

export const RSA_MODULUS_BITS = 2048;

export interface DkimKeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

/** A fresh RSA-2048 and Ed25519 key pair, one per algorithm (PST-REQ-038). */
export function generateDkimKeys(): { rsa: DkimKeyPair; ed25519: DkimKeyPair } {
  const rsa = generateKeyPairSync('rsa', { modulusLength: RSA_MODULUS_BITS, publicExponent: 0x10001 });
  const ed25519 = generateKeyPairSync('ed25519');
  return { rsa, ed25519 };
}

/** The key type a signing algorithm needs, as Node names it. */
export function keyTypeFor(algorithm: DkimAlgorithm): 'rsa' | 'ed25519' {
  return algorithm === 'rsa-sha256' ? 'rsa' : 'ed25519';
}

/**
 * The TXT record value to publish at `<selector>._domainkey.<domain>`.
 * RSA: p= is base64 of the SubjectPublicKeyInfo DER (RFC 6376 §3.6.1).
 * Ed25519: p= is base64 of the raw 32-byte public key, not SPKI (RFC 8463 §4.2).
 */
export function dnsRecordFor(algorithm: DkimAlgorithm, publicKey: KeyObject): string {
  const key = publicKey.type === 'private' ? createPublicKey(publicKey) : publicKey;
  assertKeyType(key, algorithm);
  if (algorithm === 'rsa-sha256') {
    const der = key.export({ type: 'spki', format: 'der' });
    return `v=DKIM1; k=rsa; p=${der.toString('base64')}`;
  }
  return `v=DKIM1; k=ed25519; p=${rawEd25519Public(key).toString('base64')}`;
}

/** Parse a DKIM key TXT record (RFC 6376 §3.6.1) into a public key. Revoked (empty p=) is an error. */
export function publicKeyFromDnsRecord(record: string): { algorithm: DkimAlgorithm; publicKey: KeyObject } {
  const tags = parseTagList(record);
  const v = tags.get('v');
  if (v !== undefined && v !== 'DKIM1') throw new DkimError('key record has unsupported v=');
  const k = tags.get('k') ?? 'rsa';
  const p = stripWhitespace(tags.get('p') ?? '');
  if (p === '') throw new DkimError('key record has no key (revoked or missing p=)');
  const der = Buffer.from(p, 'base64');
  if (k === 'rsa') {
    try {
      return { algorithm: 'rsa-sha256', publicKey: createPublicKey({ key: der, format: 'der', type: 'spki' }) };
    } catch {
      throw new DkimError('key record p= is not an RSA SubjectPublicKeyInfo');
    }
  }
  if (k === 'ed25519') {
    if (der.length !== 32) throw new DkimError('ed25519 key record p= must be 32 bytes');
    return { algorithm: 'ed25519-sha256', publicKey: ed25519PublicFromRaw(der) };
  }
  throw new DkimError('key record has unsupported k=');
}

// SPKI and PKCS#8 wrappers for a raw Ed25519 key (RFC 8410): fixed prefixes, then the 32 bytes.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519PublicFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new DkimError('ed25519 public key must be 32 bytes');
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** An Ed25519 private key from its raw 32-byte seed (the form RFC 8463 Appendix A publishes). */
export function ed25519PrivateFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new DkimError('ed25519 seed must be 32 bytes');
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  try {
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } finally {
    der.fill(0);
  }
}

function rawEd25519Public(key: KeyObject): Buffer {
  const der = key.export({ type: 'spki', format: 'der' });
  if (der.length !== ED25519_SPKI_PREFIX.length + 32) throw new DkimError('unexpected ed25519 SPKI length');
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

export function assertKeyType(key: KeyObject, algorithm: DkimAlgorithm): void {
  if (key.asymmetricKeyType !== keyTypeFor(algorithm)) {
    throw new DkimError(`${algorithm} needs a ${keyTypeFor(algorithm)} key`);
  }
}

/** Seal a DKIM private key under the KEK: PKCS#8 DER, AES-256-GCM, the plaintext export zeroed. */
export function sealDkimKey(kek: Kek, privateKey: KeyObject, aad: Aad): Buffer {
  if (privateKey.type !== 'private') throw new DkimError('sealDkimKey needs a private key');
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  try {
    return sealWithKek(kek, der, aad);
  } finally {
    der.fill(0);
  }
}

/** Open a sealed DKIM key. Throws DecryptError (from @postroom/crypto) on a wrong KEK or AAD. */
export function openDkimKey(kek: Kek, sealed: Uint8Array, aad: Aad): KeyObject {
  const der = openWithKek(kek, sealed, aad);
  try {
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } finally {
    der.fill(0);
  }
}

/**
 * A dated selector: "pr" + UTC year and month + "r" (RSA) or "e" (Ed25519), e.g. "pr202609r".
 * Rotation (PST-T-7.4) publishes the next month's selectors before switching to them.
 */
export function selectorFor(date: Date, algorithm: DkimAlgorithm): string {
  const yyyy = String(date.getUTCFullYear()).padStart(4, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `pr${yyyy}${mm}${algorithm === 'rsa-sha256' ? 'r' : 'e'}`;
}
