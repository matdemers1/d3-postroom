// Test-only builders for signatures, keys, certificates and messages the fixtures do not cover:
// revoked and expired keys, expiring and future-dated signatures, non-document signature types,
// SHA-1 and wrong-purpose S/MIME certificates (PST-T-12.1, PST-REQ-160). Everything is made fresh
// with node:crypto in the test run — throwaway keys on example.test, never written to disk.
import { constants, createCipheriv, createHash, generateKeyPairSync, publicEncrypt, randomBytes, sign, type KeyObject } from 'node:crypto';
import { decodeArmor, encodeArmor, encodePacket, parseKeys, type KnownKey } from '../../src/index.js';
import { derSetOf, encodeOid, encodeTlv, seq, TagClass, UTag } from '../../src/der.js';
import { text } from './fixtures.js';

const u16 = (n: number): Buffer => Buffer.of((n >> 8) & 0xff, n & 0xff);
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const secs = (d: Date): number => Math.floor(d.getTime() / 1000);
const crlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');

// ---------------------------------------------------------------------------------------------
// OpenPGP

export interface SigOptions {
  /** Signature type (default 0x00, binary document). */
  type?: number;
  /** 8 = SHA-256 (default), 10 = SHA-512. */
  hash?: number;
  /** Creation time; null leaves the subpacket out. Default now. */
  created?: Date | null;
  expiresSeconds?: number;
  keyExpiresSeconds?: number;
  revocationReason?: number;
  /** Key flags (subpacket 27), on a self-signature or binding. */
  flags?: number;
  /** An embedded signature (subpacket 32, hashed): the body of a 0x19 back-signature. */
  embedded?: Buffer;
}

const HASHES: Record<number, string> = { 2: 'sha1', 8: 'sha256', 10: 'sha512' };

function sub(type: number, body: Buffer): Buffer {
  const n = body.length + 1;
  const len = n < 192 ? Buffer.of(n) : Buffer.of(((n - 192) >> 8) + 192, (n - 192) & 0xff);
  return Buffer.concat([len, Buffer.of(type), body]);
}

/** A v4 Ed25519 (algorithm 27) key's public packet body. */
function ed25519Body(pub: KeyObject, created: Date): Buffer {
  const x = Buffer.from(pub.export({ format: 'jwk' }).x ?? '', 'base64url');
  return Buffer.concat([Buffer.of(4), u32(secs(created)), Buffer.of(27), x]);
}

const frame = (body: Buffer): Buffer => Buffer.concat([Buffer.of(0x99), u16(body.length), body]);

function fingerprintOf(body: Buffer): string {
  return createHash('sha1').update(frame(body)).digest('hex').toUpperCase();
}

/** A v4 signature packet by `priv` (fingerprint `fpr`) over `data`. */
export function signaturePacket(priv: KeyObject, fpr: string, data: Buffer, o: SigOptions = {}): Buffer {
  return encodePacket(2, signatureBody(priv, fpr, data, o));
}

/** The body of a v4 Ed25519 signature packet by `priv` (fingerprint `fpr`) over `data`. */
export function signatureBody(priv: KeyObject, fpr: string, data: Buffer, o: SigOptions = {}): Buffer {
  const hashId = o.hash ?? 8;
  const subs: Buffer[] = [];
  if (o.created !== null) subs.push(sub(2, u32(secs(o.created ?? new Date()))));
  if (o.expiresSeconds !== undefined) subs.push(sub(3, u32(o.expiresSeconds)));
  if (o.keyExpiresSeconds !== undefined) subs.push(sub(9, u32(o.keyExpiresSeconds)));
  if (o.revocationReason !== undefined) subs.push(sub(29, Buffer.of(o.revocationReason)));
  if (o.flags !== undefined) subs.push(sub(27, Buffer.of(o.flags)));
  if (o.embedded !== undefined) subs.push(sub(32, o.embedded));
  subs.push(sub(33, Buffer.concat([Buffer.of(4), Buffer.from(fpr, 'hex')])));
  const hashed = Buffer.concat(subs);
  const prefix = Buffer.concat([Buffer.of(4, o.type ?? 0, 27, hashId), u16(hashed.length), hashed]);
  const trailer = Buffer.concat([prefix, Buffer.of(4, 0xff), u32(prefix.length)]);
  const digest = createHash(HASHES[hashId] ?? 'sha256').update(data).update(trailer).digest();
  return Buffer.concat([prefix, u16(0), digest.subarray(0, 2), sign(null, digest, priv)]);
}

export interface KeyOptions {
  created?: Date;
  uid?: string;
  /** Key expiration (subpacket 9) on the self-certification. */
  keyExpiresSeconds?: number;
  /** A key revocation signature (0x20). `forged` signs it with a different key. */
  revocation?: { created: Date; reason?: number; forged?: boolean };
  /** Key flags on the primary's self-certification (default 0x03, certify + sign); null leaves them out. */
  primaryFlags?: number | null;
  /**
   * Add an Ed25519 subkey, optionally revoked (0x28). By default it is a proper signing subkey:
   * bound (0x18) with key flags 0x02 and an embedded 0x19 back-signature. `unbound` leaves the 0x18
   * out, `flags` changes (or, null, drops) the flags, `backSig` false leaves the 0x19 out and
   * 'forged' makes it with another key.
   */
  subkey?: { revocation?: { created: Date; reason?: number }; unbound?: boolean; flags?: number | null; backSig?: boolean | 'forged' };
}

export interface ForgedKey {
  fingerprint: string;
  subkeyFingerprint: string | null;
  armored: string;
  /** A signature packet by the primary key. */
  sign(data: Buffer, o?: SigOptions): Buffer;
  /** A signature packet by the signing subkey. */
  signWithSubkey(data: Buffer, o?: SigOptions): Buffer;
  known(extra?: Partial<KnownKey>): KnownKey;
}

export function forgeKey(o: KeyOptions = {}): ForgedKey {
  const created = o.created ?? new Date('2026-01-01T00:00:00Z');
  const uid = Buffer.from(o.uid ?? 'Dave Test <dave@example.test>', 'utf8');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const body = ed25519Body(publicKey, created);
  const fpr = fingerprintOf(body);
  const uidData = Buffer.concat([frame(body), Buffer.of(0xb4), u32(uid.length), uid]);
  const packets: Buffer[] = [encodePacket(6, body)];
  if (o.revocation !== undefined) {
    const signer = o.revocation.forged === true ? generateKeyPairSync('ed25519').privateKey : privateKey;
    packets.push(signaturePacket(signer, fpr, frame(body), { type: 0x20, created: o.revocation.created, ...(o.revocation.reason === undefined ? {} : { revocationReason: o.revocation.reason }) }));
  }
  packets.push(encodePacket(13, uid));
  const primaryFlags = o.primaryFlags === undefined ? 0x03 : o.primaryFlags;
  packets.push(signaturePacket(privateKey, fpr, uidData, { type: 0x13, created, ...(o.keyExpiresSeconds === undefined ? {} : { keyExpiresSeconds: o.keyExpiresSeconds }), ...(primaryFlags === null ? {} : { flags: primaryFlags }) }));
  let subPriv: KeyObject | null = null;
  let subFpr: string | null = null;
  if (o.subkey !== undefined) {
    const pair = generateKeyPairSync('ed25519');
    subPriv = pair.privateKey;
    const subBody = ed25519Body(pair.publicKey, created);
    subFpr = fingerprintOf(subBody);
    packets.push(encodePacket(14, subBody));
    const bindData = Buffer.concat([frame(body), frame(subBody)]);
    const flags = o.subkey.flags === undefined ? 0x02 : o.subkey.flags;
    const back = o.subkey.backSig ?? true;
    const backBody = back === false ? undefined : signatureBody(back === 'forged' ? generateKeyPairSync('ed25519').privateKey : pair.privateKey, subFpr, bindData, { type: 0x19, created });
    if (o.subkey.unbound !== true) packets.push(signaturePacket(privateKey, fpr, bindData, { type: 0x18, created, ...(flags === null ? {} : { flags }), ...(backBody === undefined ? {} : { embedded: backBody }) }));
    const rev = o.subkey.revocation;
    if (rev !== undefined) packets.push(signaturePacket(privateKey, fpr, bindData, { type: 0x28, created: rev.created, ...(rev.reason === undefined ? {} : { revocationReason: rev.reason }) }));
  }
  const armored = encodeArmor('PGP PUBLIC KEY BLOCK', Buffer.concat(packets));
  return {
    fingerprint: fpr,
    subkeyFingerprint: subFpr,
    armored,
    sign: (data, so) => signaturePacket(privateKey, fpr, data, so),
    signWithSubkey: (data, so) => {
      if (subPriv === null || subFpr === null) throw new Error('no subkey');
      return signaturePacket(subPriv, subFpr, data, so);
    },
    known: (extra = {}) => ({ id: 'dave-contact', kind: 'pgp', owner: 'contact', address: 'dave@example.test', fingerprint: fpr, publicKey: armored, ...extra }),
  };
}

const HEAD = (ct: string, from = 'Dave Test <dave@example.test>'): string => `From: ${from}\r\nTo: Me <me@d3cloud.io>\r\nSubject: forged for a test\r\nMIME-Version: 1.0\r\nContent-Type: ${ct}\r\n\r\n`;

/** RFC 3156 §5 multipart/signed: `part` is hashed exactly as given (it holds its own headers, if any). */
export function pgpMimeSigned(part: Buffer, signature: Buffer, from?: string): Buffer {
  return Buffer.concat([
    Buffer.from(`${HEAD('multipart/signed; micalg=pgp-sha256; protocol="application/pgp-signature"; boundary="sig-b"', from)}--sig-b\r\n`, 'latin1'),
    part,
    Buffer.from(`\r\n--sig-b\r\nContent-Type: application/pgp-signature\r\n\r\n${crlf(encodeArmor('PGP SIGNATURE', signature))}\r\n--sig-b--\r\n`, 'latin1'),
  ]);
}

export const SIGNED_PART = Buffer.from('Content-Type: text/plain; charset=utf-8\r\n\r\nHello Bob,\r\nthis part is signed.\r\n', 'latin1');

/** The bytes a cleartext signature covers (RFC 9580 §7.2): trailing whitespace stripped, CRLF between lines. */
export function canonicalText(lines: readonly string[]): Buffer {
  return Buffer.from(lines.map((l) => l.replace(/[ \t]+$/, '')).join('\r\n'), 'latin1');
}

export function clearsigned(lines: readonly string[], signature: Buffer): Buffer {
  const body = ['-----BEGIN PGP SIGNED MESSAGE-----', 'Hash: SHA256', '', ...lines.map((l) => (l.startsWith('-') ? `- ${l}` : l)), encodeArmor('PGP SIGNATURE', signature).trimEnd()].join('\n');
  return Buffer.from(`${HEAD('text/plain; charset=utf-8')}${crlf(body)}\r\n`, 'latin1');
}

/** A literal data packet (RFC 9580 §5.9). */
export function literalPacket(data: Buffer, format: 'b' | 't' = 'b'): Buffer {
  return encodePacket(11, Buffer.concat([Buffer.from(format, 'latin1'), Buffer.of(0), u32(0), data]));
}

function mpi(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  const bits = (v.length - 1) * 8 + (32 - Math.clz32(v[0] ?? 0));
  return Buffer.concat([u16(bits), v]);
}

/**
 * An inline PGP MESSAGE encrypted to bob's RSA subkey (PKESK v3 + SEIPD v1 with MDC, AES-256),
 * wrapping `inner` (literal / signature packets) as they are.
 */
export function encryptedToBob(inner: Buffer): Buffer {
  const armoredKey = decodeArmor(text('bob-rsa3072.pub.asc'));
  if (armoredKey === null) throw new Error('bob key');
  const [bob] = parseKeys(armoredKey.data);
  const subkey = bob?.subkeys[0];
  if (subkey === undefined || subkey.publicKey === null) throw new Error('bob subkey');
  const key = randomBytes(32);
  let sum = 0;
  for (const b of key) sum = (sum + b) & 0xffff;
  const m = Buffer.concat([Buffer.of(9), key, u16(sum)]);
  const c = publicEncrypt({ key: subkey.publicKey, padding: constants.RSA_PKCS1_PADDING }, m);
  const pkesk = encodePacket(1, Buffer.concat([Buffer.of(3), Buffer.from(subkey.keyId, 'hex'), Buffer.of(1), mpi(c)]));
  const prefix = randomBytes(16);
  const plain = Buffer.concat([prefix, prefix.subarray(14), inner, Buffer.of(0xd3, 0x14)]);
  const full = Buffer.concat([plain, createHash('sha1').update(plain).digest()]);
  const cipher = createCipheriv('aes-256-cfb', key, Buffer.alloc(16));
  const seipd = encodePacket(18, Buffer.concat([Buffer.of(1), cipher.update(full), cipher.final()]));
  const armored = encodeArmor('PGP MESSAGE', Buffer.concat([pkesk, seipd]));
  return Buffer.from(`${HEAD('text/plain; charset=us-ascii')}${crlf(armored)}`, 'latin1');
}

// ---------------------------------------------------------------------------------------------
// S/MIME

const oid = (o: string): Buffer => encodeTlv(TagClass.Universal, false, UTag.Oid, encodeOid(o));
const int = (b: Buffer): Buffer => encodeTlv(TagClass.Universal, false, UTag.Integer, b);
const octet = (b: Buffer): Buffer => encodeTlv(TagClass.Universal, false, UTag.OctetString, b);
const set = (...items: Buffer[]): Buffer => encodeTlv(TagClass.Universal, true, UTag.Set, Buffer.concat(items));
const ctx = (n: number, content: Buffer): Buffer => encodeTlv(TagClass.Context, true, n, content);
const utc = (d: Date): Buffer => encodeTlv(TagClass.Universal, false, UTag.UtcTime, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'latin1'));
const name = (cn: string): Buffer => seq(set(seq(oid('2.5.4.3'), encodeTlv(TagClass.Universal, false, UTag.Utf8String, Buffer.from(cn, 'utf8')))));
const ext = (id: string, value: Buffer): Buffer => seq(oid(id), octet(value));

const ED25519 = '1.3.101.112';
export const OID = {
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha1WithRsa: '1.2.840.113549.1.1.5',
  ed25519: ED25519,
  emailProtection: '1.3.6.1.5.5.7.3.4',
  serverAuth: '1.3.6.1.5.5.7.3.1',
} as const;

export interface CertOptions {
  notBefore?: Date;
  notAfter?: Date;
  email?: string;
  /** Key usage byte (first octet of the BIT STRING): 0x80 digitalSignature, 0x40 nonRepudiation, 0x20 keyEncipherment. null = no extension. */
  keyUsage?: number | null;
  /** EKU OIDs; null = no extension. */
  eku?: string[] | null;
  /** Subject/issuer CN and serial (vary them for several certificates in one message). */
  cn?: string;
  serial?: Buffer;
}

export interface ForgedCert {
  pem: string;
  der: Buffer;
  priv: KeyObject;
  issuerName: Buffer;
  serial: Buffer;
  known(extra?: Partial<KnownKey>): KnownKey;
}

export function forgeCert(o: CertOptions = {}): ForgedCert {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const cn = o.cn ?? 'Erin Test (TEST ONLY)';
  const serial = o.serial ?? Buffer.of(0x01, 0x23, 0x45);
  const exts = [ext('2.5.29.17', seq(encodeTlv(TagClass.Context, false, 1, Buffer.from(o.email ?? 'erin@example.test', 'latin1'))))];
  const ku = o.keyUsage === undefined ? 0x80 : o.keyUsage;
  if (ku !== null) exts.push(ext('2.5.29.15', encodeTlv(TagClass.Universal, false, UTag.BitString, Buffer.of(0, ku))));
  const eku = o.eku === undefined ? [OID.emailProtection] : o.eku;
  if (eku !== null) exts.push(ext('2.5.29.37', seq(...eku.map(oid))));
  const tbs = seq(
    ctx(0, int(Buffer.of(2))),
    int(serial),
    seq(oid(ED25519)),
    name(cn),
    seq(utc(o.notBefore ?? new Date('2026-01-01T00:00:00Z')), utc(o.notAfter ?? new Date('2046-01-01T00:00:00Z'))),
    name(cn),
    publicKey.export({ format: 'der', type: 'spki' }),
    ctx(3, seq(...exts)),
  );
  const der = seq(tbs, seq(oid(ED25519)), encodeTlv(TagClass.Universal, false, UTag.BitString, Buffer.concat([Buffer.of(0), sign(null, tbs, privateKey)])));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
  return {
    pem,
    der,
    priv: privateKey,
    issuerName: name(cn),
    serial,
    known: (extra = {}) => ({ id: 'erin-contact', kind: 'smime', owner: 'contact', address: 'erin@example.test', fingerprint: 'see-certificate', publicKey: pem, ...extra }),
  };
}

export interface SmimeOptions {
  digest?: 'sha1' | 'sha256';
  signatureAlgorithm?: string;
  signingTime?: Date | null;
  /** Encode the signed attributes in an order that is not DER's (and sign those bytes). */
  unsortedAttributes?: boolean;
}

/** A CMS ContentInfo(SignedData), detached, by `cert` over `content`. */
export function signedData(cert: ForgedCert, content: Buffer, o: SmimeOptions = {}): Buffer {
  return signedDataOf([signerInfo(cert, content, o)], [cert.der], o.digest ?? 'sha256');
}

/** ContentInfo(SignedData), detached, around the given SignerInfos and certificates, in that order. */
export function signedDataOf(signerInfos: readonly Buffer[], certs: readonly Buffer[], digest: 'sha1' | 'sha256' = 'sha256'): Buffer {
  const sd = seq(int(Buffer.of(1)), set(seq(oid(OID[digest]))), seq(oid('1.2.840.113549.1.7.1')), ...(certs.length === 0 ? [] : [ctx(0, Buffer.concat(certs))]), set(...signerInfos));
  return seq(oid('1.2.840.113549.1.7.2'), ctx(0, sd));
}

/** One SignerInfo by `cert` over `content`. `bogus` signs other bytes, so it never verifies. */
export function signerInfo(cert: ForgedCert, content: Buffer, o: SmimeOptions & { bogus?: boolean } = {}): Buffer {
  const digest = o.digest ?? 'sha256';
  const attrs = [
    seq(oid('1.2.840.113549.1.9.3'), set(oid('1.2.840.113549.1.7.1'))),
    seq(oid('1.2.840.113549.1.9.4'), set(octet(createHash(digest).update(content).digest()))),
  ];
  if (o.signingTime !== null) attrs.push(seq(oid('1.2.840.113549.1.9.5'), set(utc(o.signingTime ?? new Date('2026-06-01T00:00:00Z')))));
  let implicit: Buffer;
  let signed: Buffer;
  if (o.unsortedAttributes === true) {
    const sorted = derSetOf(attrs);
    // Reverse the DER order, so the received bytes are not DER.
    const kids = [...attrs].sort((a, b) => Buffer.compare(b, a));
    implicit = ctx(0, Buffer.concat(kids));
    signed = set(...kids);
    if (signed.equals(sorted)) throw new Error('test attributes happen to be in DER order');
  } else {
    implicit = derSetOf(attrs, TagClass.Context, 0);
    signed = derSetOf(attrs);
  }
  const sig = sign(null, o.bogus === true ? Buffer.concat([signed, Buffer.of(0)]) : signed, cert.priv);
  return seq(int(Buffer.of(1)), seq(cert.issuerName, int(cert.serial)), seq(oid(OID[digest])), implicit, seq(oid(o.signatureAlgorithm ?? ED25519)), octet(sig));
}

/** RFC 8551 §3.5.3 multipart/signed around `part` with `cms` (DER) as the signature. */
export function smimeSigned(part: Buffer, cms: Buffer): Buffer {
  const b64 = cms.toString('base64').replace(/(.{76})/g, '$1\r\n');
  return Buffer.concat([
    Buffer.from(`${HEAD('multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="sm-b"', 'Erin Test <erin@example.test>')}--sm-b\r\n`, 'latin1'),
    part,
    Buffer.from(`\r\n--sm-b\r\nContent-Type: application/pkcs7-signature; name=smime.p7s\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--sm-b--\r\n`, 'latin1'),
  ]);
}
