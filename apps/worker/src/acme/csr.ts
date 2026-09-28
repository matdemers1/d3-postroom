// The PKCS#10 certificate request (RFC 2986) the ACME finalize step carries (RFC 8555 §7.4),
// built by hand in DER (PST-T-0.15). Subject CN is the first domain; every domain goes in a
// subjectAltName extension requested through the PKCS#9 extensionRequest attribute, which is what
// the CA actually reads.
//
// The certificate key is RSA-2048 by default: MX TLS is spoken by every kind of sending MTA, and
// RSA is the choice no peer refuses. ECDSA P-256 is accepted too (the tests use both).
import { createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { bitString, contextConstructed, contextPrimitive, integer, nullValue, octetString, oid, sequence, setOf, utf8String } from './der.js';

const OID_CN = '2.5.4.3';
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

export function generateCertificateKey(type: 'rsa' | 'ec' = 'rsa'): KeyObject {
  return type === 'rsa'
    ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    : generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
}

/** The DER of a CSR for `domains`, signed SHA-256 by `key` (RSA or P-256). */
export function buildCsr(key: KeyObject, domains: readonly string[]): Buffer {
  const [cn] = domains;
  if (cn === undefined) throw new Error('a certificate request needs at least one domain');
  // X.520 caps CN at 64 characters; a longer first name would make the CA refuse the request.
  if (cn.length > 64) throw new Error(`the first domain (${cn}) is too long for a subject CN`);
  if (key.type !== 'private') throw new Error('buildCsr needs the private key');
  const privateKey = key;
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const subject = sequence(setOf(sequence(oid(OID_CN), utf8String(cn))));
  const generalNames = sequence(...domains.map((d) => contextPrimitive(2, Buffer.from(d, 'ascii'))));
  const extensions = sequence(sequence(oid(OID_SUBJECT_ALT_NAME), octetString(generalNames)));
  const attributes = contextConstructed(0, sequence(oid(OID_EXTENSION_REQUEST), setOf(extensions)));
  const info = sequence(integer(0), subject, spki, attributes);

  const isRsa = privateKey.asymmetricKeyType === 'rsa';
  if (!isRsa && privateKey.asymmetricKeyType !== 'ec') throw new Error(`unsupported certificate key type ${String(privateKey.asymmetricKeyType)}`);
  // RSA: PKCS#1 v1.5 with NULL parameters. ECDSA: DER (r, s) signature, parameters absent (RFC 5758).
  const algorithm = isRsa ? sequence(oid(OID_SHA256_WITH_RSA), nullValue()) : sequence(oid(OID_ECDSA_WITH_SHA256));
  const signature = sign('sha256', info, privateKey);
  return sequence(info, algorithm, bitString(signature));
}
