// CMS / PKCS#7 (RFC 5652) for S/MIME 4.0 (RFC 8551): ContentInfo, SignedData with signed
// attributes (contentType + messageDigest, §11.1/§11.2), EnvelopedData with KeyTransRecipientInfo,
// and the handful of certificate fields a signer or recipient is identified by (RFC 5280 §4.1).
// The wrappers (ContentInfo, SignedData, EnvelopedData, the certificate set) are read in der.ts's
// BER mode, since Thunderbird/NSS and `openssl cms -stream` send indefinite lengths and segmented
// OCTET STRINGs there; what a signature covers is read strictly as DER — each certificate, and the
// signed attributes, whose DER SET OF re-encoding must equal the bytes received (verifySigner).
// Certificates' own signatures, subjects and rfc822Names come from node:crypto's X509Certificate,
// as do every signature check and cipher.

import { constants, createDecipheriv, createHash, privateDecrypt, publicDecrypt, timingSafeEqual, verify as cryptoVerify, X509Certificate, type KeyObject } from 'node:crypto';
import { BerError, CmsError, DerError, NotDerError } from './errors.js';
import { children, definiteForm, derSetOf, expect, isContext, isUniversal, octets, oidOf, readTlv, UTag, type Encoding, type Tlv } from './der.js';
import { rsaPkcs1Decrypt } from './rsa.js';

export const Oids = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  envelopedData: '1.2.840.113549.1.7.3',
  authEnvelopedData: '1.2.840.113549.1.9.16.1.23',
  contentTypeAttr: '1.2.840.113549.1.9.3',
  messageDigestAttr: '1.2.840.113549.1.9.4',
  signingTimeAttr: '1.2.840.113549.1.9.5',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaesOaep: '1.2.840.113549.1.1.7',
  rsassaPss: '1.2.840.113549.1.1.10',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  anyExtendedKeyUsage: '2.5.29.37.0',
  emailProtection: '1.3.6.1.5.5.7.3.4',
} as const;

export const DIGEST_OIDS: Record<string, string> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.4': 'sha224',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};

/** Signature algorithm OID → how to verify: the hash (null = use the digest algorithm), and the key family. */
const SIGNATURE_OIDS: Record<string, { hash: string | null; family: 'rsa' | 'ecdsa' | 'ed25519' }> = {
  '1.2.840.113549.1.1.1': { hash: null, family: 'rsa' },
  '1.2.840.113549.1.1.5': { hash: 'sha1', family: 'rsa' },
  '1.2.840.113549.1.1.14': { hash: 'sha224', family: 'rsa' },
  '1.2.840.113549.1.1.11': { hash: 'sha256', family: 'rsa' },
  '1.2.840.113549.1.1.12': { hash: 'sha384', family: 'rsa' },
  '1.2.840.113549.1.1.13': { hash: 'sha512', family: 'rsa' },
  '1.2.840.10045.2.1': { hash: null, family: 'ecdsa' },
  '1.2.840.10045.4.3.2': { hash: 'sha256', family: 'ecdsa' },
  '1.2.840.10045.4.3.3': { hash: 'sha384', family: 'ecdsa' },
  '1.2.840.10045.4.3.4': { hash: 'sha512', family: 'ecdsa' },
  '1.3.101.112': { hash: null, family: 'ed25519' },
};

const CONTENT_CIPHERS: Record<string, { cipher: string; name: string; keyBytes: number } | undefined> = {
  '2.16.840.1.101.3.4.1.2': { cipher: 'aes-128-cbc', name: 'AES-128-CBC', keyBytes: 16 },
  '2.16.840.1.101.3.4.1.22': { cipher: 'aes-192-cbc', name: 'AES-192-CBC', keyBytes: 24 },
  '2.16.840.1.101.3.4.1.42': { cipher: 'aes-256-cbc', name: 'AES-256-CBC', keyBytes: 32 },
};

const DIGEST_INFO: Record<string, string> = {
  sha1: '3021300906052b0e03021a05000414',
  sha224: '302d300d06096086480165030402040500041c',
  sha256: '3031300d060960864801650304020105000420',
  sha384: '3041300d060960864801650304020205000430',
  sha512: '3051300d060960864801650304020305000440',
};

/**
 * A DER/BER reader failure as a CmsError: BER where only DER may be (a certificate) is named
 * (unsupported), malformed BER and anything else is malformed.
 */
function asCmsError(err: unknown): unknown {
  if (err instanceof NotDerError) return new CmsError('unsupported-ber-encoding', `${err.message}: a certificate must be DER`);
  if (err instanceof BerError) return new CmsError('malformed-ber', err.message);
  if (err instanceof DerError) return new CmsError('malformed-der', err.message);
  return err;
}

// ---------------------------------------------------------------------------------------------
// Certificates

export interface Certificate {
  der: Buffer;
  x509: X509Certificate;
  /** The subject public key, decoded once at parse time. */
  publicKey: KeyObject;
  /** Subject and issuer as one line, the serial as hex, and the subjectAltName as node:crypto renders them. */
  subject: string;
  issuer: string;
  serialHex: string;
  subjectAltName: string;
  /** The issuer Name, as encoded. */
  issuerRaw: Buffer;
  /** The serial number INTEGER contents. */
  serial: Buffer;
  subjectKeyId: Buffer | null;
  /** SHA-256 over the DER, lower-case hex: what a CryptoKey row stores as the fingerprint. */
  fingerprint: string;
  /** The validity window (RFC 5280 §4.1.2.5), read from the DER here. */
  notBefore: Date;
  notAfter: Date;
  /** RFC 5280 §4.2.1.3: the two bits an S/MIME signer needs; null when the extension is absent. */
  keyUsage: { digitalSignature: boolean; nonRepudiation: boolean } | null;
  /** RFC 5280 §4.2.1.12: the purposes as OIDs; null when the extension is absent. */
  extKeyUsage: string[] | null;
}

export function parseCertificate(der: Buffer): Certificate {
  const cert = readTlv(der);
  const [tbs] = children(expect(cert, UTag.Sequence, 'Certificate'));
  const fields = children(expect(tbs, UTag.Sequence, 'TBSCertificate'));
  let i = 0;
  if (fields[0] !== undefined && isContext(fields[0], 0)) i++;
  const serial = expect(fields[i], UTag.Integer, 'serialNumber').content;
  const issuerRaw = expect(fields[i + 2], UTag.Sequence, 'issuer').raw;
  const [nb, na] = children(expect(fields[i + 3], UTag.Sequence, 'validity'));
  const notBefore = readTime(nb);
  const notAfter = readTime(na);
  if (notBefore === null || notAfter === null) throw new CmsError('malformed-certificate', 'the certificate validity is not a UTCTime or GeneralizedTime in Z form');
  let subjectKeyId: Buffer | null = null;
  let keyUsage: Certificate['keyUsage'] = null;
  let extKeyUsage: string[] | null = null;
  for (const f of fields.slice(i + 6)) {
    if (!isContext(f, 3)) continue;
    const [exts] = children(f);
    for (const ext of children(expect(exts, UTag.Sequence, 'Extensions'))) {
      const parts = children(ext);
      const id = oidOf(parts[0], 'extnID');
      const value = parts[parts.length - 1];
      if (value === undefined) continue;
      if (id === Oids.subjectKeyIdentifier) {
        const inner = readTlv(expect(value, UTag.OctetString, 'extnValue').content);
        subjectKeyId = expect(inner, UTag.OctetString, 'SubjectKeyIdentifier').content;
      } else if (id === Oids.keyUsage) {
        const bits = expect(readTlv(expect(value, UTag.OctetString, 'extnValue').content), UTag.BitString, 'KeyUsage').content;
        const first = bits[1] ?? 0;
        keyUsage = { digitalSignature: (first & 0x80) !== 0, nonRepudiation: (first & 0x40) !== 0 };
      } else if (id === Oids.extKeyUsage) {
        extKeyUsage = children(expect(readTlv(expect(value, UTag.OctetString, 'extnValue').content), UTag.Sequence, 'ExtKeyUsageSyntax')).map((o) => oidOf(o, 'KeyPurposeId'));
      }
    }
  }
  let x509: X509Certificate;
  let publicKey: KeyObject;
  let subject: string;
  let issuer: string;
  let serialHex: string;
  let subjectAltName: string;
  try {
    x509 = new X509Certificate(der);
    // node:crypto decodes some fields lazily, and a getter that throws later would escape as a
    // non-package error. Touch every one read anywhere here, now, while a failure is ours to name.
    publicKey = x509.publicKey;
    subject = x509.subject.replace(/\n/g, ', ');
    issuer = x509.issuer.replace(/\n/g, ', ');
    serialHex = x509.serialNumber;
    subjectAltName = x509.subjectAltName ?? '';
  } catch {
    throw new CmsError('certificate-unreadable');
  }
  return { der: Buffer.from(cert.raw), x509, publicKey, subject, issuer, serialHex, subjectAltName, issuerRaw, serial, subjectKeyId, fingerprint: createHash('sha256').update(cert.raw).digest('hex'), notBefore, notAfter, keyUsage, extKeyUsage };
}

/** Certificates from PEM text (every CERTIFICATE block, in order). */
export function certificatesFromPem(pem: string): Certificate[] {
  const out: Certificate[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (let m = re.exec(pem); m !== null; m = re.exec(pem)) out.push(parseCertificate(Buffer.from((m[1] ?? '').replace(/\s+/g, ''), 'base64')));
  return out;
}

/** The rfc822Name entries of the subjectAltName, lowercased (X509Certificate renders them as `email:…`). */
export function rfc822Names(cert: Certificate): string[] {
  const san = cert.subjectAltName;
  const out: string[] = [];
  for (const part of san.split(/,\s*/)) if (part.startsWith('email:')) out.push(part.slice(6).toLowerCase());
  return out;
}

// ---------------------------------------------------------------------------------------------
// Signer and recipient identifiers

export type SignerId = { kind: 'issuer-serial'; issuer: Buffer; serial: Buffer } | { kind: 'ski'; ski: Buffer };

function readSid(t: Tlv | undefined): SignerId {
  if (t === undefined) throw new CmsError('missing-signer-identifier');
  if (isUniversal(t, UTag.Sequence)) {
    const [issuer, serial] = children(t);
    // A BER sender may frame the issuer Name with indefinite lengths; it is compared in definite form.
    return { kind: 'issuer-serial', issuer: definiteForm(expect(issuer, UTag.Sequence, 'issuer')), serial: expect(serial, UTag.Integer, 'serialNumber').content };
  }
  if (isContext(t, 0)) return { kind: 'ski', ski: t.constructed ? octets(t) : t.content };
  throw new CmsError('bad-signer-identifier');
}

export function matchesId(cert: Certificate, id: SignerId): boolean {
  if (id.kind === 'ski') return cert.subjectKeyId !== null && cert.subjectKeyId.equals(id.ski);
  return cert.issuerRaw.equals(id.issuer) && cert.serial.equals(id.serial);
}

// ---------------------------------------------------------------------------------------------
// ContentInfo

export interface ContentInfo {
  contentType: string;
  content: Tlv;
}

/** ContentInfo, read as BER by default (a DER encoding is BER too); `encoding: 'der'` is strict. */
export function parseContentInfo(bytes: Buffer, encoding: Encoding = 'ber'): ContentInfo {
  try {
    const ci = readTlv(bytes, 0, 0, encoding);
    const [type, explicit] = children(expect(ci, UTag.Sequence, 'ContentInfo'));
    const contentType = oidOf(type, 'contentType');
    if (explicit === undefined || !isContext(explicit, 0)) throw new CmsError('content-info-no-content');
    const [content] = children(explicit);
    if (content === undefined) throw new CmsError('content-info-no-content');
    return { contentType, content };
  } catch (err) {
    throw asCmsError(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// SignedData

export interface SignerInfo {
  sid: SignerId;
  digestAlgorithm: string;
  /** The signed attributes as encoded ([0] IMPLICIT), or null when absent. */
  signedAttrs: Tlv | null;
  attributes: Map<string, Tlv[]>;
  signatureAlgorithm: string;
  signature: Buffer;
}

export interface SignedData {
  eContentType: string;
  /** The encapsulated content, or null when detached (multipart/signed). */
  eContent: Buffer | null;
  certificates: Certificate[];
  signers: SignerInfo[];
}

export function parseSignedData(t: Tlv): SignedData {
  try {
    const f = children(expect(t, UTag.Sequence, 'SignedData'));
    const encap = children(expect(f[2], UTag.Sequence, 'EncapsulatedContentInfo'));
    const eContentType = oidOf(encap[0], 'eContentType');
    const explicit = encap[1];
    let eContent: Buffer | null = null;
    if (explicit !== undefined && isContext(explicit, 0)) {
      const [inner] = children(explicit);
      if (inner !== undefined) eContent = octets(inner);
    }
    const certificates: Certificate[] = [];
    let k = 3;
    for (; k < f.length; k++) {
      const x = f[k];
      if (x === undefined) break;
      if (isContext(x, 0)) {
        for (const c of children(x)) if (isUniversal(c, UTag.Sequence)) certificates.push(parseCertificate(Buffer.from(c.raw)));
      } else if (!isContext(x, 1)) break;
    }
    const signers = children(expect(f[k], UTag.Set, 'signerInfos')).map(parseSignerInfo);
    return { eContentType, eContent, certificates, signers };
  } catch (err) {
    throw asCmsError(err);
    throw err;
  }
}

function parseSignerInfo(t: Tlv): SignerInfo {
  const f = children(expect(t, UTag.Sequence, 'SignerInfo'));
  const sid = readSid(f[1]);
  const digestAlgorithm = oidOf(children(expect(f[2], UTag.Sequence, 'digestAlgorithm'))[0]);
  let i = 3;
  let signedAttrs: Tlv | null = null;
  const attributes = new Map<string, Tlv[]>();
  const maybe = f[i];
  if (maybe !== undefined && isContext(maybe, 0)) {
    signedAttrs = maybe;
    for (const a of children(maybe)) {
      const [type, values] = children(expect(a, UTag.Sequence, 'Attribute'));
      attributes.set(oidOf(type), children(expect(values, UTag.Set, 'attrValues')));
    }
    i++;
  }
  const signatureAlgorithm = oidOf(children(expect(f[i], UTag.Sequence, 'signatureAlgorithm'))[0]);
  const signature = octets(expect(f[i + 1], UTag.OctetString, 'signature'));
  return { sid, digestAlgorithm, signedAttrs, attributes, signatureAlgorithm, signature };
}

export interface SignerCheck {
  valid: boolean;
  reasons: string[];
  signingTime: Date | null;
  hash: string | null;
}

/** The node:crypto hash name for a digest algorithm OID, or throws CmsError('unsupported-digest'). */
export function digestName(oid: string): string {
  const n = DIGEST_OIDS[oid];
  if (n === undefined) throw new CmsError(`unsupported-digest-${oid}`);
  return n;
}

/** UTCTime or GeneralizedTime in the Z form RFC 5280 §4.1.2.5 requires; null for anything else, including a field out of range. */
function readTime(t: Tlv | undefined): Date | null {
  if (t === undefined) return null;
  const s = t.content.toString('latin1');
  let m: RegExpExecArray | null;
  let year: number;
  if (isUniversal(t, UTag.UtcTime) && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)) !== null) {
    const yy = Number(m[1]);
    year = yy < 50 ? 2000 + yy : 1900 + yy;
  } else if (isUniversal(t, UTag.GeneralizedTime) && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)) !== null) {
    year = Number(m[1]);
  } else return null;
  const [mo, d, h, mi, sec] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  const date = new Date(Date.UTC(year, mo - 1, d, h, mi, sec));
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== d ? null : date;
}

/**
 * RFC 5652 §5.4/§5.6: when signed attributes are present, messageDigest must equal the content
 * digest and contentType the eContentType, and the signature covers the attributes re-tagged as a
 * SET. `contentDigest` is the digest of the content under the signer's digest algorithm.
 */
export function verifySigner(si: SignerInfo, cert: Certificate, eContentType: string, contentDigest: Buffer): SignerCheck {
  const reasons: string[] = [];
  const hash = digestName(si.digestAlgorithm);
  const algo = SIGNATURE_OIDS[si.signatureAlgorithm];
  if (si.signatureAlgorithm === Oids.rsassaPss) throw new CmsError('unsupported-rsassa-pss');
  if (algo === undefined) throw new CmsError(`unsupported-signature-algorithm-${si.signatureAlgorithm}`);
  // Refused as OpenPGP refuses it (RFC 9580 §9.5); RFC 8551 §2.1 makes SHA-1 receive-only legacy.
  if (hash === 'sha1' || algo.hash === 'sha1') throw new CmsError('unsupported-weak-hash-sha1', 'SHA-1 signatures are not accepted');
  const key = cert.publicKey;
  let signingTime: Date | null = null;
  if (si.signedAttrs !== null) {
    // RFC 5652 §5.4: the signature is over the DER encoding of the attributes as a SET OF, not
    // the [0] IMPLICIT bytes as they arrived. Re-read them strictly as DER (the SignedData around
    // them may be BER), re-encode (sorted per X.690 §11.6) and require the bytes received to be
    // exactly that — before reading anything from them — so there is one encoding and it is the
    // one checked.
    let strict: Tlv[];
    try {
      strict = children(readTlv(Buffer.from(si.signedAttrs.raw), 0, 0, 'der'));
    } catch (err) {
      if (err instanceof NotDerError) throw new CmsError('unsupported-signed-attributes-not-der', `the signed attributes are not DER (${err.message}), so the bytes signed are ambiguous`);
      throw asCmsError(err);
    }
    const set = derSetOf(strict.map((a) => a.raw));
    const retagged = Buffer.from(si.signedAttrs.raw);
    retagged[0] = 0x31;
    if (!set.equals(retagged)) throw new CmsError('unsupported-signed-attributes-not-der', 'the signed attributes are not in DER order (X.690 §11.6), so the bytes signed are ambiguous');
    const md = si.attributes.get(Oids.messageDigestAttr);
    const ct = si.attributes.get(Oids.contentTypeAttr);
    if (md?.length !== 1 || ct?.length !== 1) return { valid: false, reasons: ['signed attributes lack exactly one messageDigest and one contentType (RFC 5652 §5.3)'], signingTime, hash };
    const mdValue = expect(md[0], UTag.OctetString, 'messageDigest').content;
    if (mdValue.length !== contentDigest.length || !timingSafeEqual(mdValue, contentDigest)) {
      return { valid: false, reasons: ['messageDigest does not match the content: the signed part was changed'], signingTime, hash };
    }
    if (oidOf(ct[0]) !== eContentType) return { valid: false, reasons: ['contentType attribute does not match the encapsulated content type'], signingTime, hash };
    signingTime = readTime(si.attributes.get(Oids.signingTimeAttr)?.[0]);
    const ok = verifyWith(algo, algo.hash ?? hash, set, key, si.signature);
    reasons.push(ok ? `signature over the signed attributes verifies with the signer's certificate (${hash})` : 'signature over the signed attributes does not verify');
    return { valid: ok, reasons, signingTime, hash };
  }
  // No signed attributes: the signature is over the content itself. With only its digest in hand,
  // RSA can still be checked by recovering the DigestInfo; other families cannot.
  if (algo.family !== 'rsa') throw new CmsError('unsupported-unsigned-attributes-non-rsa');
  const prefix = DIGEST_INFO[hash];
  if (prefix === undefined) throw new CmsError('unsupported-digest');
  let recovered: Buffer;
  try {
    recovered = publicDecrypt({ key, padding: constants.RSA_PKCS1_PADDING }, si.signature);
  } catch {
    return { valid: false, reasons: ['signature does not verify'], signingTime, hash };
  }
  const expected = Buffer.concat([Buffer.from(prefix, 'hex'), contentDigest]);
  const ok = recovered.length === expected.length && timingSafeEqual(recovered, expected);
  return { valid: ok, reasons: [ok ? 'signature over the content verifies' : 'signature does not verify: the signed part was changed'], signingTime, hash };
}

function verifyWith(algo: { family: 'rsa' | 'ecdsa' | 'ed25519' }, hash: string, data: Buffer, key: KeyObject, sig: Buffer): boolean {
  try {
    if (algo.family === 'ed25519') return cryptoVerify(null, data, key, sig);
    if (algo.family === 'rsa' && key.asymmetricKeyType !== 'rsa') return false;
    if (algo.family === 'ecdsa' && key.asymmetricKeyType !== 'ec') return false;
    return cryptoVerify(hash, data, key, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Chain as presented (no trust store: RFC 8551 leaves trust anchors to the receiver)

export interface ChainLink {
  subject: string;
  issuer: string;
  fingerprint: string;
  serial: string;
  notBefore: string;
  notAfter: string;
  rfc822Names: string[];
  selfSigned: boolean;
  /** This certificate's signature verified with the next link's public key (or its own, when self-signed). */
  signatureVerified: boolean;
}

export interface Chain {
  links: ChainLink[];
  /** Every link's signature verifies with the next certificate presented. */
  verified: boolean;
  /** The chain ends in a self-signed certificate that was presented in the message. */
  endsAtSelfSigned: boolean;
  reason: string;
}

function link(c: Certificate, verified: boolean, selfSigned: boolean): ChainLink {
  return {
    subject: c.subject,
    issuer: c.issuer,
    fingerprint: c.fingerprint,
    serial: c.serialHex,
    notBefore: c.notBefore.toISOString(),
    notAfter: c.notAfter.toISOString(),
    rfc822Names: rfc822Names(c),
    selfSigned,
    signatureVerified: verified,
  };
}

/** Walks issuer links through the certificates the message itself carried. */
export function chainOf(leaf: Certificate, presented: readonly Certificate[]): Chain {
  const links: ChainLink[] = [];
  let current = leaf;
  const seen = new Set<string>();
  let verified = true;
  for (let depth = 0; depth < 10; depth++) {
    seen.add(current.fingerprint);
    const cur = current;
    const selfIssued = issuedBy(cur, cur);
    if (selfIssued) {
      const ok = safeVerify(cur, cur);
      links.push(link(cur, ok, true));
      if (!ok) verified = false;
      return { links, verified, endsAtSelfSigned: ok, reason: ok ? 'verifies up to a self-signed root that the message itself carried (not a system trust anchor)' : 'the self-signed certificate does not verify' };
    }
    const issuer = presented.find((c) => !seen.has(c.fingerprint) && issuedBy(cur, c));
    if (issuer === undefined) {
      links.push(link(cur, false, false));
      return { links, verified, endsAtSelfSigned: false, reason: links.length === 1 ? 'the issuer of the signing certificate was not included' : 'verifies up to the embedded intermediates; the root was not included' };
    }
    const ok = safeVerify(cur, issuer);
    links.push(link(cur, ok, false));
    if (!ok) {
      verified = false;
      links.push(link(issuer, false, issuedBy(issuer, issuer)));
      return { links, verified, endsAtSelfSigned: false, reason: `the certificate for ${cur.subject} is not signed by the issuer presented` };
    }
    current = issuer;
  }
  return { links, verified: false, endsAtSelfSigned: false, reason: 'chain too long' };
}

function issuedBy(c: Certificate, by: Certificate): boolean {
  try {
    return c.x509.checkIssued(by.x509);
  } catch {
    return false;
  }
}

function safeVerify(c: Certificate, by: Certificate): boolean {
  try {
    return c.x509.verify(by.publicKey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// EnvelopedData

export interface Recipient {
  rid: SignerId;
  keyEncryptionAlgorithm: string;
  encryptedKey: Buffer;
}

export interface EnvelopedData {
  recipients: Recipient[];
  /** Recipient kinds other than KeyTransRecipientInfo, by name (kari, kekri, pwri, ori). */
  otherRecipients: string[];
  contentEncryptionAlgorithm: string;
  iv: Buffer | null;
  encryptedContent: Buffer | null;
}

export function parseEnvelopedData(t: Tlv): EnvelopedData {
  try {
    const f = children(expect(t, UTag.Sequence, 'EnvelopedData'));
    let i = 1;
    const maybe = f[i];
    if (maybe !== undefined && isContext(maybe, 0)) i++;
    const recipients: Recipient[] = [];
    const otherRecipients: string[] = [];
    for (const ri of children(expect(f[i], UTag.Set, 'recipientInfos'))) {
      if (isUniversal(ri, UTag.Sequence)) {
        const r = children(ri);
        recipients.push({
          rid: readSid(r[1]),
          keyEncryptionAlgorithm: oidOf(children(expect(r[2], UTag.Sequence, 'keyEncryptionAlgorithm'))[0]),
          encryptedKey: octets(expect(r[3], UTag.OctetString, 'encryptedKey')),
        });
      } else otherRecipients.push(['ktri', 'kari', 'kekri', 'pwri', 'ori'][ri.tag] ?? `recipient-${String(ri.tag)}`);
    }
    const eci = children(expect(f[i + 1], UTag.Sequence, 'EncryptedContentInfo'));
    const alg = children(expect(eci[1], UTag.Sequence, 'contentEncryptionAlgorithm'));
    const contentEncryptionAlgorithm = oidOf(alg[0]);
    const params = alg[1];
    const iv = params !== undefined && isUniversal(params, UTag.OctetString) ? octets(params) : null;
    const ec = eci[2];
    const encryptedContent = ec !== undefined && isContext(ec, 0) ? (ec.constructed ? octets(ec) : ec.content) : null;
    return { recipients, otherRecipients, contentEncryptionAlgorithm, iv, encryptedContent };
  } catch (err) {
    throw asCmsError(err);
    throw err;
  }
}

export interface SmimeDecryptionKey {
  certificate: Certificate;
  privateKey: KeyObject;
  ref: string;
}

export type SmimeDecryptResult =
  | { status: 'decrypted'; plaintext: Buffer; cipher: string; openedWith: string }
  | { status: 'no-key' }
  | { status: `failed:${string}` };

export function decryptEnvelopedData(env: EnvelopedData, keys: readonly SmimeDecryptionKey[]): SmimeDecryptResult {
  const cipher = CONTENT_CIPHERS[env.contentEncryptionAlgorithm];
  for (const r of env.recipients) {
    const k = keys.find((key) => matchesId(key.certificate, r.rid));
    if (k === undefined) continue;
    let cek: Buffer | null;
    if (r.keyEncryptionAlgorithm === Oids.rsaEncryption) cek = rsaPkcs1Decrypt(k.privateKey, r.encryptedKey);
    else if (r.keyEncryptionAlgorithm === Oids.rsaesOaep) {
      try {
        cek = privateDecrypt({ key: k.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, r.encryptedKey);
      } catch {
        cek = null;
      }
    } else return { status: `failed:unsupported-key-encryption-${r.keyEncryptionAlgorithm}` };
    if (cek === null) return { status: 'failed:content-key' };
    if (cipher === undefined) return { status: `failed:unsupported-content-cipher-${env.contentEncryptionAlgorithm}` };
    if (cek.length !== cipher.keyBytes || env.iv?.length !== 16 || env.encryptedContent === null) return { status: 'failed:content-key' };
    try {
      const d = createDecipheriv(cipher.cipher, cek, env.iv);
      const plaintext = Buffer.concat([d.update(env.encryptedContent), d.final()]);
      return { status: 'decrypted', plaintext, cipher: cipher.name, openedWith: k.ref };
    } catch {
      return { status: 'failed:content-decryption' };
    }
  }
  return { status: 'no-key' };
}
