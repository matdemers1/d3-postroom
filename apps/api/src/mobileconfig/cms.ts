// Signs a mobileconfig's plist as a CMS (PKCS#7) SignedData structure, DER-encoded (PST-T-8.6,
// PST-REQ-139) — exactly what iOS expects to unwrap before it trusts a configuration profile. Hand
// rolled against RFC 5652: a hash-rolled ASN.1 writer (./der.ts), `node:crypto` for the digest and
// the RSA/ECDSA signature, and no third-party CMS/PKCS#7 library.
import { X509Certificate, createHash, createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { TAG, children, der, explicitTag, implicitConstructedTag, integer, nullValue, octetString, oid, readTlv, sequence, set, utcTime } from './der.js';

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_CONTENT_TYPE_ATTR = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST_ATTR = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME_ATTR = '1.2.840.113549.1.9.5';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

export interface SigningKeyPair {
  /** PEM certificate for the signer. */
  readonly certificatePem: string;
  /** PEM private key matching the certificate. */
  readonly privateKeyPem: string;
  /** Additional PEM certificates to include (an intermediate chain), signer first is not required. */
  readonly chainPem?: readonly string[];
}

/** Pulls the DER `issuer` Name and `serialNumber` fields out of an X.509 certificate, by walking
 *  TBSCertificate's children positionally — no semantic parsing of the RDN sequence is needed. */
function issuerAndSerial(certDer: Buffer): { issuerRaw: Buffer; serialRaw: Buffer } {
  const cert = readTlv(certDer, 0);
  const tbs = readTlv(cert.content, 0);
  const kids = children(tbs.content);
  let i = 0;
  // version is an optional [0] EXPLICIT INTEGER; skip it if present.
  if (kids[i]?.tag === 0xa0) i++;
  const serial = kids[i];
  if (serial === undefined) throw new Error('certificate: missing serialNumber');
  i++; // serialNumber
  i++; // signature AlgorithmIdentifier
  const issuer = kids[i];
  if (issuer === undefined) throw new Error('certificate: missing issuer');
  return { issuerRaw: issuer.raw, serialRaw: serial.raw };
}

function pemToDer(pem: string): Buffer {
  return new X509Certificate(pem).raw;
}

function attribute(attrOid: string, values: Buffer[]): Buffer {
  return sequence(oid(attrOid), set(values));
}

function keyKind(key: KeyObject): 'rsa' | 'ec' {
  if (key.asymmetricKeyType === 'rsa') return 'rsa';
  if (key.asymmetricKeyType === 'ec') return 'ec';
  throw new Error(`unsupported signing key type: ${key.asymmetricKeyType ?? 'unknown'}`);
}

/**
 * Builds the DER `ContentInfo` (SignedData) that wraps `content`, signed with `keys`. The plist
 * itself is embedded (not detached): `openssl smime -verify -inform DER` prints it back out.
 */
export function signCms(content: Buffer, keys: SigningKeyPair, now: Date = new Date()): Buffer {
  const privateKey = createPrivateKey(keys.privateKeyPem);
  const kind = keyKind(privateKey);
  const signerCertDer = pemToDer(keys.certificatePem);
  const { issuerRaw, serialRaw } = issuerAndSerial(signerCertDer);
  const chainDer = (keys.chainPem ?? []).map((pem) => pemToDer(pem));

  const digestAlgorithm = sequence(oid(OID_SHA256), nullValue());
  const messageDigest = createHash('sha256').update(content).digest();

  const signedAttrsSet = set([
    attribute(OID_CONTENT_TYPE_ATTR, [oid(OID_DATA)]),
    attribute(OID_MESSAGE_DIGEST_ATTR, [octetString(messageDigest)]),
    attribute(OID_SIGNING_TIME_ATTR, [utcTime(now)]),
  ]);
  // RFC 5652 §5.4: the signature covers the DER encoding of SignedAttrs tagged as a SET (0x31), not
  // the [0] IMPLICIT form it is embedded as below.
  const signature = createSign('sha256').update(signedAttrsSet).sign(privateKey);
  const signedAttrsImplicit = implicitConstructedTag(0, signedAttrsSet);

  const signatureAlgorithm = kind === 'rsa' ? sequence(oid(OID_RSA_ENCRYPTION), nullValue()) : sequence(oid(OID_ECDSA_WITH_SHA256));

  const signerInfo = sequence(
    integer(1), // CMSVersion 1: issuerAndSerialNumber form
    sequence(issuerRaw, serialRaw), // IssuerAndSerialNumber
    digestAlgorithm,
    signedAttrsImplicit,
    signatureAlgorithm,
    octetString(signature),
  );

  const encapContentInfo = sequence(oid(OID_DATA), explicitTag(0, octetString(content)));
  const certificates = implicitConstructedTag(0, der(TAG.SET, ...[signerCertDer, ...chainDer]));

  const signedData = sequence(
    integer(1), // CMSVersion 1
    set([digestAlgorithm]),
    encapContentInfo,
    certificates,
    set([signerInfo]),
  );

  return sequence(oid(OID_SIGNED_DATA), explicitTag(0, signedData));
}
