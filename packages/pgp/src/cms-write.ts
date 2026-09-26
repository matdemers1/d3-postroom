// The CMS WRITING side for S/MIME 4.0 (PST-T-12.2, PST-REQ-161; RFC 5652, RFC 8551):
//   SignedData, detached, with signed attributes (contentType, signingTime, messageDigest) signed by
//   the account's certificate key — RSA PKCS#1 v1.5 (sha256WithRSAEncryption), ECDSA P-256/384
//   (ecdsa-with-SHA256/384), or Ed25519 — carrying the signer's certificate and its chain.
//   EnvelopedData with one KeyTransRecipientInfo (RSAES-OAEP, default parameters) per recipient
//   certificate and AES-256-CBC content encryption.
// Everything is DER, written with der.ts's encodeTlv / derSetOf; primitives from node:crypto.
// Round-tripped through cms.ts's readers in the tests, and through `openssl cms`.

import { constants, createCipheriv, createHash, publicEncrypt, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { Oids, type Certificate } from './cms.js';
import { derSetOf, encodeOid, encodeTlv, seq, TagClass, UTag } from './der.js';
import { CmsError } from './errors.js';

const oid = (o: string): Buffer => encodeTlv(TagClass.Universal, false, UTag.Oid, encodeOid(o));
const int = (content: Uint8Array): Buffer => encodeTlv(TagClass.Universal, false, UTag.Integer, content);
const octetString = (b: Uint8Array): Buffer => encodeTlv(TagClass.Universal, false, UTag.OctetString, b);
const NULL = Buffer.of(0x05, 0x00);

const DIGEST_OID: Record<string, string> = {
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
};

const AES256_CBC = '2.16.840.1.101.3.4.1.42';

/** UTCTime for 1950–2049, GeneralizedTime otherwise (RFC 5280 §4.1.2.5). */
export function derTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  if (y >= 1950 && y < 2050) return encodeTlv(TagClass.Universal, false, UTag.UtcTime, Buffer.from(`${p(y % 100)}${rest}`, 'latin1'));
  return encodeTlv(TagClass.Universal, false, UTag.GeneralizedTime, Buffer.from(`${String(y)}${rest}`, 'latin1'));
}

const attribute = (type: string, value: Buffer): Buffer => seq(oid(type), derSetOf([value]));

const issuerAndSerial = (cert: Certificate): Buffer => seq(cert.issuerRaw, int(cert.serial));

interface SigningAlgorithm {
  hash: string;
  /** The signatureAlgorithm AlgorithmIdentifier. */
  algorithm: Buffer;
  /** node:crypto's digest argument to sign(): null for Ed25519. */
  signHash: string | null;
}

function signingAlgorithm(key: KeyObject): SigningAlgorithm {
  const type = key.asymmetricKeyType;
  if (type === 'rsa') return { hash: 'sha256', algorithm: seq(oid('1.2.840.113549.1.1.11'), NULL), signHash: 'sha256' };
  if (type === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve === 'prime256v1') return { hash: 'sha256', algorithm: seq(oid('1.2.840.10045.4.3.2')), signHash: 'sha256' };
    if (curve === 'secp384r1') return { hash: 'sha384', algorithm: seq(oid('1.2.840.10045.4.3.3')), signHash: 'sha384' };
    throw new CmsError('unsupported-signing-curve', `ECDSA over ${curve ?? 'an unknown curve'} is not supported`);
  }
  // RFC 8419 §3: Ed25519 with SHA-512 as the message digest.
  if (type === 'ed25519') return { hash: 'sha512', algorithm: seq(oid('1.3.101.112')), signHash: null };
  throw new CmsError('unsupported-signing-key', `a ${type ?? 'unknown'} key cannot sign S/MIME here (RSA, ECDSA P-256/P-384 or Ed25519)`);
}

export interface CmsSignOptions {
  certificate: Certificate;
  privateKey: KeyObject;
  /** Intermediates (and optionally the root) to carry beside the signer's certificate. */
  chain?: readonly Certificate[];
  signingTime?: Date;
}

/**
 * A detached SignedData (RFC 5652 §5) over `content` — the exact bytes of the signed MIME part —
 * wrapped in a ContentInfo, DER.
 */
export function signCmsDetached(content: Uint8Array, opts: CmsSignOptions): Buffer {
  const alg = signingAlgorithm(opts.privateKey);
  const digestOid = DIGEST_OID[alg.hash];
  if (digestOid === undefined) throw new CmsError('unsupported-digest');
  const digestAlg = seq(oid(digestOid));
  const md = createHash(alg.hash).update(content).digest();
  const attrs = [attribute(Oids.contentTypeAttr, oid(Oids.data)), attribute(Oids.signingTimeAttr, derTime(opts.signingTime ?? new Date())), attribute(Oids.messageDigestAttr, octetString(md))];
  // RFC 5652 §5.4: the signature is over the DER SET OF; the SignerInfo carries it as [0] IMPLICIT.
  const signedSet = derSetOf(attrs);
  let signature: Buffer;
  try {
    signature = cryptoSign(alg.signHash, signedSet, opts.privateKey);
  } catch (err) {
    throw new CmsError('signing-failed', err instanceof Error ? err.message : 'signing failed');
  }
  const signerInfo = seq(int(Buffer.of(1)), issuerAndSerial(opts.certificate), digestAlg, derSetOf(attrs, TagClass.Context, 0), alg.algorithm, octetString(signature));
  const certs = [opts.certificate, ...(opts.chain ?? [])].filter((c, i, all) => all.findIndex((o) => o.fingerprint === c.fingerprint) === i);
  const signedData = seq(int(Buffer.of(1)), derSetOf([digestAlg]), seq(oid(Oids.data)), derSetOf(certs.map((c) => c.der), TagClass.Context, 0), derSetOf([signerInfo]));
  return seq(oid(Oids.signedData), encodeTlv(TagClass.Context, true, 0, signedData));
}

/**
 * An EnvelopedData (RFC 5652 §6) of `content` for every certificate in `recipients` (RSA keys:
 * RSAES-OAEP, RFC 8017 default parameters), content under AES-256-CBC, wrapped in a ContentInfo.
 */
export function encryptCmsEnveloped(content: Uint8Array, recipients: readonly Certificate[]): Buffer {
  if (recipients.length === 0) throw new CmsError('no-recipients');
  const cek = randomBytes(32);
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cbc', cek, iv);
  const encrypted = Buffer.concat([c.update(content), c.final()]);
  const infos: Buffer[] = [];
  const seen = new Set<string>();
  for (const cert of recipients) {
    if (seen.has(cert.fingerprint)) continue;
    seen.add(cert.fingerprint);
    if (cert.publicKey.asymmetricKeyType !== 'rsa') {
      throw new CmsError('unsupported-recipient-key', `${cert.subject}: only RSA certificates can be encrypted to (key transport); this one is ${cert.publicKey.asymmetricKeyType ?? 'unknown'}`);
    }
    const wrapped = publicEncrypt({ key: cert.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, cek);
    // RSAES-OAEP-params with every field at its default (SHA-1, MGF1-SHA-1, empty label): an empty SEQUENCE.
    infos.push(seq(int(Buffer.of(0)), issuerAndSerial(cert), seq(oid(Oids.rsaesOaep), seq()), octetString(wrapped)));
  }
  const eci = seq(oid(Oids.data), seq(oid(AES256_CBC), octetString(iv)), encodeTlv(TagClass.Context, false, 0, encrypted));
  const enveloped = seq(int(Buffer.of(0)), derSetOf(infos), eci);
  return seq(oid(Oids.envelopedData), encodeTlv(TagClass.Context, true, 0, enveloped));
}
