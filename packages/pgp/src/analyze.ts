// The Inspect drawer's "Signature and encryption" evidence for one message (PST-REQ-160).
//
// `analyzeMessage` reads the message once, as a stream, and recognises at the top level:
//   multipart/signed    application/pgp-signature (RFC 3156 §5) or application/(x-)pkcs7-signature
//                       (RFC 8551 §3.5.3). The first part is hashed as it streams past; only the
//                       signature part (capped) is held.
//   multipart/encrypted application/pgp-encrypted (RFC 3156 §4) — the encrypted part is held (capped).
//   application/(x-)pkcs7-mime  enveloped-data or opaque signed-data (RFC 8551 §3.3, §3.5.2).
//   text/plain          inline cleartext signatures and inline PGP MESSAGE blocks.
// After decrypting, the plaintext entity is analysed again for a signature inside it (sign-then-
// encrypt), and OpenPGP one-pass signatures inside the encrypted data are checked too.
//
// Trust: a signature is 'verified-known-key' only when its key is one of the account's CryptoKey
// rows (owner 'own' or 'contact'). A key or certificate that came only with the message gives at
// most 'valid-signature-unknown-key' — a key attached to the message is never trusted on its own.
// For S/MIME the certificate chain is reported as presented, verified only up to what the message
// carried; no claim is made against any system trust store.

import { createHash, createPrivateKey, type KeyObject } from 'node:crypto';
import { createTransferDecoder, normalizeEncoding, parseContentType, parseHeaderBlock, parseMailboxes, type HeaderList } from '@postroom/mime';
import { decodeArmor, decodeArmors, parseCleartext } from './armor.js';
import { certificatesFromPem, chainOf, decryptEnvelopedData, digestName, matchesId, parseContentInfo, parseEnvelopedData, parseSignedData, rfc822Names, verifySigner, Oids, type Certificate, type ChainLink, type SignedData } from './cms.js';
import { decryptMessage, type DecryptionKey, type InnerSignature, type PgpDecryptResult } from './decrypt.js';
import { ArmorError, CmsError, DerError, PgpError, UnsupportedError } from './errors.js';
import { allMaterials, parseKeys, userIdAddress, type KeyMaterial, type OpenPgpKey } from './keys.js';
import { readPackets, Tag } from './packets.js';
import { digestFor, finishDigest, hashName, parseSignaturePacket, verifyDigest, type SignaturePacket } from './signature.js';
import { CollectSink, HashSink, splitLines, walkMultipart, type ByteSource, type Line } from './stream.js';

export type SignatureStatus = 'verified-known-key' | 'valid-signature-unknown-key' | 'bad-signature' | 'not-signed' | `unsupported:${string}`;
export type DecryptionStatus = 'decrypted' | 'no-key' | 'not-encrypted' | `failed:${string}`;

/** One of the account's keys (a CryptoKey row), as the analyzer needs it. */
export interface KnownKey {
  id: string;
  kind: 'pgp' | 'smime';
  owner: 'own' | 'contact';
  address: string;
  fingerprint: string;
  /** Armored OpenPGP public key, or the certificate in PEM. */
  publicKey: string;
  /** Opens the private key (armored/binary OpenPGP secret key, or PKCS#8 PEM/DER) only when a message names this key. */
  openPrivate?: (() => Promise<Uint8Array | string | null>) | undefined;
}

export interface SignerReport {
  keyId: string | null;
  fingerprint: string | null;
  algorithm: string | null;
  hash: string | null;
  userIds: string[];
  addresses: string[];
  /** Whether the From address is one the key or certificate speaks for; null when unknown. */
  fromMatches: boolean | null;
  createdAt: string | null;
  /** Where the key that checked the signature came from. */
  keySource: 'account' | 'message' | 'none';
  knownKeyId: string | null;
  owner: 'own' | 'contact' | null;
}

export interface SignatureReport {
  status: SignatureStatus;
  format: 'pgp-mime' | 'pgp-inline' | 'pgp-encrypted' | 'smime' | 'smime-opaque' | null;
  reasons: string[];
  signer: SignerReport | null;
  /** S/MIME: the certificate chain as presented, signer first. */
  certificates: ChainLink[];
  chain: { verified: boolean; endsAtSelfSigned: boolean; reason: string } | null;
}

export interface RecipientReport {
  /** OpenPGP key ID, or the certificate issuer + serial / subject key identifier. */
  id: string;
  algorithm: string | null;
  /** The CryptoKey row it matched, when one did. */
  matchedKeyId: string | null;
}

export interface EncryptionReport {
  status: DecryptionStatus;
  format: 'pgp-mime' | 'pgp-inline' | 'smime' | null;
  reasons: string[];
  recipients: RecipientReport[];
  cipher: string | null;
  integrity: string | null;
  openedWithKeyId: string | null;
  plaintextBytes: number | null;
}

export interface CryptoReport {
  signature: SignatureReport;
  encryption: EncryptionReport;
}

export interface AnalyzeOptions {
  /** Cap on an encrypted part or opaque S/MIME body held for decryption (default 64 MiB). */
  maxEncryptedBytes?: number;
  /** Cap on a detached signature part (default 1 MiB). */
  maxSignatureBytes?: number;
  /** Cap on an inline text/plain body scanned for armor (default 4 MiB). */
  maxInlineBytes?: number;
  /** Cap on the top-level header block (default 256 KiB). */
  maxHeaderBytes?: number;
}

const NOT_SIGNED: SignatureReport = { status: 'not-signed', format: null, reasons: [], signer: null, certificates: [], chain: null };
const NOT_ENCRYPTED: EncryptionReport = { status: 'not-encrypted', format: null, reasons: [], recipients: [], cipher: null, integrity: null, openedWithKeyId: null, plaintextBytes: null };

// ---------------------------------------------------------------------------------------------
// The account's keyring

interface PgpEntry {
  known: KnownKey;
  key: OpenPgpKey;
}

interface Keyring {
  pgp: PgpEntry[];
  smime: { known: KnownKey; cert: Certificate }[];
  problems: string[];
}

function buildKeyring(keys: readonly KnownKey[]): Keyring {
  const ring: Keyring = { pgp: [], smime: [], problems: [] };
  for (const k of keys) {
    try {
      if (k.kind === 'pgp') {
        for (const a of decodeArmors(k.publicKey)) if (a.type === 'PGP PUBLIC KEY BLOCK') for (const key of parseKeys(a.data)) ring.pgp.push({ known: k, key });
      } else {
        const [cert] = certificatesFromPem(k.publicKey);
        if (cert !== undefined) ring.smime.push({ known: k, cert });
      }
    } catch (err) {
      ring.problems.push(`key ${k.fingerprint}: ${describe(err)}`);
    }
  }
  return ring;
}

function describe(err: unknown): string {
  if (err instanceof PgpError || err instanceof CmsError) return err.reason;
  if (err instanceof DerError) return `malformed DER (${err.message})`;
  return err instanceof Error ? err.message : String(err);
}

function reasonOf(err: unknown): string {
  if (err instanceof UnsupportedError) return err.reason;
  if (err instanceof CmsError && err.reason.startsWith('unsupported-')) return err.reason.slice('unsupported-'.length);
  if (err instanceof ArmorError || err instanceof PgpError || err instanceof CmsError) return `malformed-${err.reason.replace(/^malformed-/, '')}`;
  if (err instanceof DerError) return 'malformed-der';
  throw err;
}

// ---------------------------------------------------------------------------------------------
// OpenPGP signatures

function findMaterial(keys: readonly OpenPgpKey[], sig: SignaturePacket): { key: OpenPgpKey; material: KeyMaterial } | null {
  for (const key of keys) {
    for (const m of allMaterials(key)) {
      if (sig.issuerFingerprint !== null ? m.fingerprint === sig.issuerFingerprint : m.keyId === sig.issuerKeyId) return { key, material: m };
    }
  }
  return null;
}

function signerOf(sig: SignaturePacket, found: { key: OpenPgpKey; material: KeyMaterial } | null, from: string | null, known: KnownKey | null, source: SignerReport['keySource']): SignerReport {
  const userIds = found?.key.userIds ?? [];
  const addresses = [...new Set(userIds.map(userIdAddress).filter((a): a is string => a !== null))];
  if (known !== null && !addresses.includes(known.address)) addresses.push(known.address);
  return {
    keyId: found?.material.keyId ?? sig.issuerKeyId,
    fingerprint: found?.material.fingerprint ?? sig.issuerFingerprint,
    algorithm: found?.material.algorithmName ?? null,
    hash: safeHashName(sig.hashAlgorithm),
    userIds,
    addresses,
    fromMatches: from === null || addresses.length === 0 ? null : addresses.includes(from),
    createdAt: sig.created?.toISOString() ?? null,
    keySource: source,
    knownKeyId: known?.id ?? null,
    owner: known?.owner ?? null,
  };
}

function safeHashName(id: number): string | null {
  try {
    return hashName(id);
  } catch {
    return null;
  }
}

/** Checks OpenPGP signatures given a digest function; the first signature that resolves to a key decides. */
function checkPgpSignatures(
  sigs: readonly SignaturePacket[],
  digestOf: (sig: SignaturePacket) => Buffer | null,
  ring: Keyring,
  attached: readonly OpenPgpKey[],
  from: string | null,
  format: SignatureReport['format'],
): SignatureReport {
  if (sigs.length === 0) return { ...NOT_SIGNED, status: 'unsupported:no-signature-packet', format, reasons: ['the signature part holds no signature packet'] };
  let firstUnresolved: SignatureReport | null = null;
  for (const sig of sigs) {
    const reasons: string[] = [];
    let source: SignerReport['keySource'] = 'none';
    let known: KnownKey | null = null;
    let found: { key: OpenPgpKey; material: KeyMaterial } | null = null;
    for (const e of ring.pgp) {
      const f = findMaterial([e.key], sig);
      if (f !== null) {
        found = f;
        known = e.known;
        source = 'account';
        break;
      }
    }
    if (found === null) {
      found = findMaterial(attached, sig);
      if (found !== null) source = 'message';
    }
    if (found === null) {
      firstUnresolved ??= {
        ...NOT_SIGNED,
        status: 'unsupported:signer-key-unavailable',
        format,
        reasons: [`signed by key ${sig.issuerFingerprint ?? sig.issuerKeyId ?? 'unknown'}, which is not in this account's keys and was not attached`],
        signer: signerOf(sig, null, from, null, 'none'),
      };
      continue;
    }
    try {
      const digest = digestOf(sig);
      if (digest === null) throw new UnsupportedError(`hash-${String(sig.hashAlgorithm)}-not-computed`);
      const ok = verifyDigest(sig, digest, found.material);
      const signer = signerOf(sig, found, from, known, source);
      if (!ok) {
        reasons.push('the signature does not match the signed content: it was changed after signing, or signed by a different key');
        return { ...NOT_SIGNED, status: 'bad-signature', format, reasons, signer };
      }
      reasons.push(`valid ${found.material.algorithmName} signature (${signer.hash ?? 'hash'}) by ${found.material.fingerprint}`);
      if (source === 'account') {
        reasons.push(`the key is one of this account's ${known?.owner === 'own' ? 'own keys' : 'contact keys'}`);
        return { ...NOT_SIGNED, status: 'verified-known-key', format, reasons, signer };
      }
      reasons.push('the key came only with the message: it proves the message was not changed, not who sent it');
      return { ...NOT_SIGNED, status: 'valid-signature-unknown-key', format, reasons, signer };
    } catch (err) {
      return { ...NOT_SIGNED, status: `unsupported:${reasonOf(err)}`, format, reasons: [describe(err)], signer: signerOf(sig, found, from, known, source) };
    }
  }
  return firstUnresolved ?? { ...NOT_SIGNED, format };
}

function signaturesIn(data: Buffer): SignaturePacket[] {
  return readPackets(data)
    .filter((p) => p.tag === Tag.Signature)
    .map((p) => parseSignaturePacket(p.body));
}

function attachedKeys(armored: readonly string[]): OpenPgpKey[] {
  const out: OpenPgpKey[] = [];
  for (const text of armored) {
    try {
      for (const a of decodeArmors(text)) if (a.type === 'PGP PUBLIC KEY BLOCK') out.push(...parseKeys(a.data));
    } catch {
      // An unreadable attached key is simply not used.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// S/MIME signatures

function checkSmime(sd: SignedData, digestOf: (hash: string) => Buffer | null, ring: Keyring, from: string | null, format: 'smime' | 'smime-opaque'): SignatureReport {
  const si = sd.signers[0];
  if (si === undefined) return { ...NOT_SIGNED, status: 'unsupported:no-signer-info', format, reasons: ['the SignedData has no SignerInfo'] };
  const cert = sd.certificates.find((c) => matchesId(c, si.sid)) ?? ring.smime.find((s) => matchesId(s.cert, si.sid))?.cert;
  if (cert === undefined) return { ...NOT_SIGNED, status: 'unsupported:signer-certificate-unavailable', format, reasons: ['the signer\'s certificate was neither included nor in this account\'s keys'] };
  const chain = chainOf(cert, sd.certificates);
  const names = rfc822Names(cert);
  const known = ring.smime.find((s) => s.cert.fingerprint === cert.fingerprint)?.known ?? null;
  const signer: SignerReport = {
    keyId: cert.x509.serialNumber,
    fingerprint: cert.fingerprint,
    algorithm: cert.x509.publicKey.asymmetricKeyType ?? null,
    hash: DIGEST_NAMES[si.digestAlgorithm] ?? si.digestAlgorithm,
    userIds: [cert.x509.subject.replace(/\n/g, ', ')],
    addresses: names,
    fromMatches: from === null || names.length === 0 ? null : names.includes(from),
    createdAt: null,
    keySource: known === null ? 'message' : 'account',
    knownKeyId: known?.id ?? null,
    owner: known?.owner ?? null,
  };
  const base = { format, signer, certificates: chain.links, chain: { verified: chain.verified, endsAtSelfSigned: chain.endsAtSelfSigned, reason: chain.reason } };
  try {
    const digest = digestOf(digestName(si.digestAlgorithm));
    if (digest === null) throw new CmsError('unsupported-digest-not-computed');
    const check = verifySigner(si, cert, sd.eContentType, digest);
    signer.createdAt = check.signingTime?.toISOString() ?? null;
    if (!check.valid) return { ...base, status: 'bad-signature', reasons: check.reasons };
    const reasons = [...check.reasons, `certificate chain: ${chain.reason}`];
    if (known !== null) return { ...base, status: 'verified-known-key', reasons: [...reasons, `the certificate is one of this account's ${known.owner === 'own' ? 'own certificates' : 'contact certificates'}`] };
    return { ...base, status: 'valid-signature-unknown-key', reasons: [...reasons, 'the certificate came only with the message and is not one of this account\'s keys'] };
  } catch (err) {
    return { ...base, status: `unsupported:${reasonOf(err)}`, reasons: [describe(err)] };
  }
}

const DIGEST_NAMES: Record<string, string> = { '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.4': 'sha224', '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512' };

// ---------------------------------------------------------------------------------------------
// Decryption

async function openPrivate(k: KnownKey): Promise<Uint8Array | string | null> {
  if (k.openPrivate === undefined) return null;
  return k.openPrivate();
}

async function pgpDecryptionKeys(data: Buffer, ring: Keyring): Promise<{ keys: DecryptionKey[]; unavailable: string[] }> {
  const wanted = new Set<string>();
  for (const p of readPackets(data)) {
    if (p.tag === Tag.PKESK && p.body[0] === 3) wanted.add(p.body.subarray(1, 9).toString('hex').toUpperCase());
    if (p.tag !== Tag.PKESK && p.tag !== Tag.Marker) break;
  }
  const wildcard = wanted.has('0000000000000000');
  const keys: DecryptionKey[] = [];
  const unavailable: string[] = [];
  const opened = new Set<string>();
  for (const e of ring.pgp) {
    if (e.known.owner !== 'own' || opened.has(e.known.id)) continue;
    if (!wildcard && !allMaterials(e.key).some((m) => wanted.has(m.keyId))) continue;
    opened.add(e.known.id);
    const secret = await openPrivate(e.known);
    if (secret === null) {
      unavailable.push(e.known.id);
      continue;
    }
    try {
      const bytes = typeof secret === 'string' ? (decodeArmor(secret)?.data ?? Buffer.alloc(0)) : Buffer.from(secret);
      for (const key of parseKeys(bytes)) for (const m of allMaterials(key)) keys.push({ material: m, ref: e.known.id });
    } catch (err) {
      // A stored secret key that will not parse (or is passphrase-protected) cannot open anything.
      unavailable.push(`${e.known.id}: ${describe(err)}`);
    }
  }
  return { keys, unavailable };
}

function privateKeyObject(secret: Uint8Array | string): KeyObject {
  return typeof secret === 'string' ? createPrivateKey(secret) : createPrivateKey({ key: Buffer.from(secret), format: 'der', type: 'pkcs8' });
}

interface Decrypted {
  report: EncryptionReport;
  plaintext: Buffer | null;
  inner: InnerSignature[];
}

async function decryptPgp(data: Buffer, ring: Keyring, format: 'pgp-mime' | 'pgp-inline', maxPlaintext: number): Promise<Decrypted> {
  const { keys, unavailable } = await pgpDecryptionKeys(data, ring);
  const r: PgpDecryptResult = decryptMessage(data, keys, { maxPlaintext });
  let status: DecryptionStatus = r.status;
  const reasons: string[] = [];
  if (status === 'no-key' && unavailable.length > 0) {
    status = 'failed:private-key-unavailable';
    reasons.push('a matching key of this account is known, but its private half could not be opened (no sealed private key, or the KEK is not loaded)');
  } else if (status === 'no-key') reasons.push('none of the recipient keys is one of this account\'s own keys');
  else if (status === 'decrypted') reasons.push(`decrypted with ${r.cipher ?? 'a session key'}; the Modification Detection Code checked`);
  else reasons.push(`decryption failed: ${status.slice('failed:'.length)}`);
  return {
    report: {
      status,
      format,
      reasons,
      recipients: r.recipients.map((p) => ({ id: p.keyId, algorithm: p.algorithm, matchedKeyId: p.matched })),
      cipher: r.cipher,
      integrity: r.integrity === 'mdc' ? 'MDC (SEIPD v1)' : null,
      openedWithKeyId: r.openedWith,
      plaintextBytes: r.plaintext?.length ?? null,
    },
    plaintext: r.plaintext,
    inner: r.signatures,
  };
}

async function decryptSmime(env: ReturnType<typeof parseEnvelopedData>, ring: Keyring): Promise<Decrypted> {
  const recipients: RecipientReport[] = env.recipients.map((r) => {
    const match = ring.smime.find((s) => matchesId(s.cert, r.rid));
    return {
      id: r.rid.kind === 'ski' ? `ski:${r.rid.ski.toString('hex')}` : `serial:${r.rid.serial.toString('hex')}`,
      algorithm: r.keyEncryptionAlgorithm === Oids.rsaEncryption ? 'RSA PKCS#1 v1.5' : r.keyEncryptionAlgorithm === Oids.rsaesOaep ? 'RSA-OAEP' : r.keyEncryptionAlgorithm,
      matchedKeyId: match?.known.id ?? null,
    };
  });
  for (const other of env.otherRecipients) recipients.push({ id: other, algorithm: other, matchedKeyId: null });
  const keys = [];
  let unavailable = false;
  for (const s of ring.smime) {
    if (s.known.owner !== 'own' || !env.recipients.some((r) => matchesId(s.cert, r.rid))) continue;
    const secret = await openPrivate(s.known);
    if (secret === null) {
      unavailable = true;
      continue;
    }
    try {
      keys.push({ certificate: s.cert, privateKey: privateKeyObject(secret), ref: s.known.id });
    } catch {
      unavailable = true;
    }
  }
  const r = decryptEnvelopedData(env, keys);
  const base = { format: 'smime' as const, recipients, integrity: null, plaintextBytes: null, cipher: null, openedWithKeyId: null };
  if (r.status === 'decrypted') {
    return { report: { ...base, status: 'decrypted', reasons: [`decrypted with ${r.cipher}`], cipher: r.cipher, openedWithKeyId: r.openedWith, plaintextBytes: r.plaintext.length }, plaintext: r.plaintext, inner: [] };
  }
  if (r.status === 'no-key' && unavailable) {
    return { report: { ...base, status: 'failed:private-key-unavailable', reasons: ['a matching certificate of this account is known, but its private key could not be opened'] }, plaintext: null, inner: [] };
  }
  return { report: { ...base, status: r.status, reasons: [r.status === 'no-key' ? 'none of the recipients is one of this account\'s own certificates' : `decryption failed: ${r.status.slice('failed:'.length)}`] }, plaintext: null, inner: [] };
}

// ---------------------------------------------------------------------------------------------
// The top level

async function readHeaders(lines: AsyncIterator<Line>, max: number): Promise<HeaderList | null> {
  const parts: Buffer[] = [];
  let size = 0;
  for (;;) {
    const next = await lines.next();
    if (next.done === true) break;
    const { bytes, eol } = next.value;
    if (eol && bytes.length === 0) break;
    size += bytes.length + 2;
    if (size > max) return null;
    parts.push(bytes, eol ? Buffer.from('\r\n') : Buffer.alloc(0));
  }
  return parseHeaderBlock(Buffer.concat(parts));
}

async function collectRest(lines: AsyncIterator<Line>, cap: number): Promise<CollectSink> {
  const sink = new CollectSink(cap);
  let first = true;
  let midLine = false;
  for (;;) {
    const next = await lines.next();
    if (next.done === true) break;
    if (!first && !midLine) sink.write(Buffer.from('\r\n'));
    sink.write(next.value.bytes);
    midLine = !next.value.eol;
    first = false;
    if (sink.overflow) break;
  }
  return sink;
}

function splitEntity(entity: Buffer): { headers: HeaderList; body: Buffer } {
  if (entity.subarray(0, 2).toString('latin1') === '\r\n') return { headers: parseHeaderBlock(Buffer.alloc(0)), body: entity.subarray(2) };
  const at = entity.indexOf('\r\n\r\n');
  if (at < 0) return { headers: parseHeaderBlock(entity), body: Buffer.alloc(0) };
  return { headers: parseHeaderBlock(entity.subarray(0, at + 2)), body: entity.subarray(at + 4) };
}

function decodeBody(headers: HeaderList, body: Buffer): Buffer {
  const d = createTransferDecoder(normalizeEncoding(headers.get('content-transfer-encoding')));
  return Buffer.concat([d.write(body), d.end()]);
}

function fromAddress(headers: HeaderList): string | null {
  const v = headers.get('from');
  if (v === null) return null;
  const a = parseMailboxes(v)[0]?.address;
  return a === undefined || a === '' ? null : a.toLowerCase();
}

/** Analyse one message (or a decrypted MIME entity). Never throws for malformed input. */
export async function analyzeMessage(source: ByteSource, keys: readonly KnownKey[], opts: AnalyzeOptions = {}): Promise<CryptoReport> {
  return analyze(source, buildKeyring(keys), opts, 0, null);
}

async function analyze(source: ByteSource, ring: Keyring, opts: AnalyzeOptions, depth: number, outerFrom: string | null): Promise<CryptoReport> {
  const maxEnc = opts.maxEncryptedBytes ?? 64 * 1024 * 1024;
  const maxSig = opts.maxSignatureBytes ?? 1024 * 1024;
  const maxInline = opts.maxInlineBytes ?? 4 * 1024 * 1024;
  const lines = splitLines(source)[Symbol.asyncIterator]();
  let phase: 'signature' | 'encryption' = 'signature';
  try {
    const headers = await readHeaders(lines, opts.maxHeaderBytes ?? 256 * 1024);
    if (headers === null) return { signature: NOT_SIGNED, encryption: NOT_ENCRYPTED };
    const from = fromAddress(headers) ?? outerFrom;
    const ct = parseContentType(headers.get('content-type'));
    const protocol = (ct.params['protocol'] ?? '').toLowerCase();
    const boundary = ct.params['boundary'];

    if (ct.mimeType === 'multipart/signed' && boundary !== undefined) {
      const isPgp = protocol === 'application/pgp-signature';
      const isSmime = protocol === 'application/pkcs7-signature' || protocol === 'application/x-pkcs7-signature';
      if (!isPgp && !isSmime) return { signature: { ...NOT_SIGNED, status: `unsupported:signature-protocol-${protocol === '' ? 'missing' : protocol}`, reasons: [`multipart/signed with protocol "${protocol}"`] }, encryption: NOT_ENCRYPTED };
      const hash = new HashSink();
      const sig = new CollectSink(maxSig);
      const walk = await walkMultipart(lines, boundary, (i) => (i === 0 ? hash : i === 1 ? sig : null), 2);
      const format = isPgp ? 'pgp-mime' : 'smime';
      if (walk.parts < 2) return { signature: { ...NOT_SIGNED, status: 'unsupported:malformed-multipart-signed', format, reasons: ['multipart/signed without both a signed part and a signature part'] }, encryption: NOT_ENCRYPTED };
      if (sig.overflow) return { signature: { ...NOT_SIGNED, status: 'unsupported:signature-part-too-large', format, reasons: [`the signature part is over ${String(maxSig)} bytes`] }, encryption: NOT_ENCRYPTED };
      const part = splitEntity(sig.buffer());
      const body = decodeBody(part.headers, part.body);
      if (isPgp) {
        const armored = decodeArmor(body.toString('latin1'));
        if (armored?.type !== 'PGP SIGNATURE') return { signature: { ...NOT_SIGNED, status: 'unsupported:malformed-signature-part', format, reasons: ['the signature part holds no PGP SIGNATURE block'] }, encryption: NOT_ENCRYPTED };
        const sigs = signaturesIn(armored.data);
        const digestOf = (s: SignaturePacket): Buffer | null => {
          const h = hash.copy(hashName(s.hashAlgorithm));
          return h === null ? null : finishDigest(h, s);
        };
        return { signature: checkPgpSignatures(sigs, digestOf, ring, attachedKeys(hash.armoredKeys), from, format), encryption: NOT_ENCRYPTED };
      }
      const ci = parseContentInfo(body);
      if (ci.contentType !== Oids.signedData) return { signature: { ...NOT_SIGNED, status: 'unsupported:malformed-pkcs7-signature', format, reasons: ['the signature part is not CMS SignedData'] }, encryption: NOT_ENCRYPTED };
      const sd = parseSignedData(ci.content);
      return { signature: checkSmime(sd, (h) => hash.copy(h)?.digest() ?? null, ring, from, 'smime'), encryption: NOT_ENCRYPTED };
    }

    if (ct.mimeType === 'multipart/encrypted' && boundary !== undefined) {
      phase = 'encryption';
      if (protocol !== 'application/pgp-encrypted') return { signature: NOT_SIGNED, encryption: { ...NOT_ENCRYPTED, status: `failed:unsupported-protocol-${protocol === '' ? 'missing' : protocol}`, reasons: [`multipart/encrypted with protocol "${protocol}"`] } };
      const enc = new CollectSink(maxEnc);
      const walk = await walkMultipart(lines, boundary, (i) => (i === 1 ? enc : null), 2);
      if (walk.parts < 2) return { signature: NOT_SIGNED, encryption: { ...NOT_ENCRYPTED, status: 'failed:malformed-multipart-encrypted', format: 'pgp-mime', reasons: ['multipart/encrypted without the encrypted part'] } };
      if (enc.overflow) return { signature: NOT_SIGNED, encryption: { ...NOT_ENCRYPTED, status: 'failed:too-large', format: 'pgp-mime', reasons: [`the encrypted part is over ${String(maxEnc)} bytes`] } };
      const part = splitEntity(enc.buffer());
      const armored = decodeArmor(decodeBody(part.headers, part.body).toString('latin1'));
      if (armored?.type !== 'PGP MESSAGE') return { signature: NOT_SIGNED, encryption: { ...NOT_ENCRYPTED, status: 'failed:malformed-encrypted-part', format: 'pgp-mime', reasons: ['the encrypted part holds no PGP MESSAGE block'] } };
      return await afterDecryption(await decryptPgp(armored.data, ring, 'pgp-mime', maxEnc), ring, opts, depth, from, true);
    }

    if (ct.mimeType === 'application/pkcs7-mime' || ct.mimeType === 'application/x-pkcs7-mime') {
      const rest = await collectRest(lines, maxEnc);
      if (rest.overflow) return { signature: NOT_SIGNED, encryption: { ...NOT_ENCRYPTED, status: 'failed:too-large', format: 'smime', reasons: [`the S/MIME body is over ${String(maxEnc)} bytes`] } };
      const der = decodeBody(headers, rest.buffer());
      const ci = parseContentInfo(der);
      if (ci.contentType === Oids.envelopedData) phase = 'encryption';
      if (ci.contentType === Oids.envelopedData) return await afterDecryption(await decryptSmime(parseEnvelopedData(ci.content), ring), ring, opts, depth, from, true);
      if (ci.contentType === Oids.authEnvelopedData) return { signature: NOT_SIGNED, encryption: { ...NOT_ENCRYPTED, status: 'failed:unsupported-auth-enveloped-data', format: 'smime', reasons: ['AuthEnvelopedData (AES-GCM, RFC 5083) is not supported yet'] } };
      if (ci.contentType === Oids.signedData) {
        const sd = parseSignedData(ci.content);
        const content = sd.eContent;
        if (content === null) return { signature: { ...NOT_SIGNED, status: 'unsupported:opaque-signed-without-content', format: 'smime-opaque', reasons: ['signed-data without encapsulated content'] }, encryption: NOT_ENCRYPTED };
        return { signature: checkSmime(sd, (h) => createHash(h).update(content).digest(), ring, from, 'smime-opaque'), encryption: NOT_ENCRYPTED };
      }
      return { signature: { ...NOT_SIGNED, status: `unsupported:cms-content-${ci.contentType}` }, encryption: NOT_ENCRYPTED };
    }

    if (ct.mimeType === 'text/plain') {
      const rest = await collectRest(lines, maxInline);
      if (rest.overflow) return { signature: NOT_SIGNED, encryption: NOT_ENCRYPTED };
      const text = decodeBody(headers, rest.buffer()).toString('latin1');
      if (text.includes('-----BEGIN PGP SIGNED MESSAGE-----')) {
        const clear = parseCleartext(text);
        if (clear === null) return { signature: NOT_SIGNED, encryption: NOT_ENCRYPTED };
        const sigs = signaturesIn(clear.signature.data);
        return { signature: checkPgpSignatures(sigs, (s) => digestFor(s, clear.signedText), ring, [], from, 'pgp-inline'), encryption: NOT_ENCRYPTED };
      }
      if (text.includes('-----BEGIN PGP MESSAGE-----')) {
        const armored = decodeArmor(text.slice(text.indexOf('-----BEGIN PGP MESSAGE-----')));
        if (armored === null) return { signature: NOT_SIGNED, encryption: NOT_ENCRYPTED };
        return await afterDecryption(await decryptPgp(armored.data, ring, 'pgp-inline', maxEnc), ring, opts, depth, from, false);
      }
    }
    return { signature: NOT_SIGNED, encryption: NOT_ENCRYPTED };
  } catch (err) {
    const reason = reasonOf(err);
    if (phase === 'encryption') return { signature: NOT_SIGNED, encryption: { ...NOT_ENCRYPTED, status: `failed:${reason}`, reasons: [describe(err)] } };
    return { signature: { ...NOT_SIGNED, status: `unsupported:${reason}`, reasons: [describe(err)] }, encryption: NOT_ENCRYPTED };
  } finally {
    await lines.return(undefined);
  }
}

async function afterDecryption(d: Decrypted, ring: Keyring, opts: AnalyzeOptions, depth: number, from: string | null, mimeInside: boolean): Promise<CryptoReport> {
  let signature: SignatureReport = NOT_SIGNED;
  if (d.inner.length > 0) {
    const sigs = d.inner.map((s) => s.signature);
    const byPacket = new Map(d.inner.map((s) => [s.signature, s.data]));
    signature = checkPgpSignatures(sigs, (s) => digestFor(s, byPacket.get(s) ?? Buffer.alloc(0)), ring, [], from, 'pgp-encrypted');
  } else if (mimeInside && d.plaintext !== null && depth < 2) {
    signature = (await analyze([d.plaintext], ring, opts, depth + 1, from)).signature;
  }
  return { signature, encryption: d.report };
}

