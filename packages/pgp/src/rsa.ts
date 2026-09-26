// RSA decryption for PKESK (RFC 9580 §5.1.3) and CMS KeyTransRecipientInfo (RFC 5652 §6.2.1).
//
// Node 22 refuses `privateDecrypt` with RSA_PKCS1_PADDING outright (the Marvin-attack mitigation,
// CVE-2023-46809), so the RSA primitive is taken raw (RSA_NO_PADDING — node:crypto does the modular
// exponentiation) and the EME-PKCS1-v1_5 *format* (RFC 8017 §7.2.2) is read here, without early
// exit on the padding bytes. There is no online oracle: only the account owner sees the result.

import { constants, privateDecrypt, type KeyObject } from 'node:crypto';
import { padStart } from './bytes.js';

/** RSA without padding, then EME-PKCS1-v1_5 decoding. Null when the padding is not valid. */
export function rsaPkcs1Decrypt(key: KeyObject, ciphertext: Buffer): Buffer | null {
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (bits === undefined) return null;
  const k = Math.ceil(bits / 8);
  if (ciphertext.length > k) return null;
  let em: Buffer;
  try {
    em = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, padStart(ciphertext, k));
  } catch {
    return null;
  }
  em = padStart(em, k);
  // EM = 0x00 || 0x02 || PS (>= 8 non-zero octets) || 0x00 || M. Scan every octet regardless.
  let bad = (em[0] ?? 1) | ((em[1] ?? 0) ^ 0x02);
  let sep = 0;
  for (let i = 2; i < k; i++) {
    const zero = em[i] === 0 ? 1 : 0;
    if (sep === 0 && zero === 1) sep = i;
  }
  if (sep < 10) bad |= 1;
  return bad === 0 ? em.subarray(sep + 1) : null;
}
