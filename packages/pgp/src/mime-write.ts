// MIME framing for outbound signed and encrypted mail (PST-T-12.2, PST-REQ-161):
//   PGP/MIME (RFC 3156)  multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256
//                        multipart/encrypted; protocol="application/pgp-encrypted"
//   S/MIME 4.0 (RFC 8551) multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256
//                        application/pkcs7-mime; smime-type=enveloped-data
// Each takes the MIME entity to protect — its content headers, a blank line, its body, strict
// CRLF — and returns the content headers and body of the entity that replaces it. The message
// headers (From, To, Subject, …) stay outside: Subject protection (RFC 9788) is out of scope.
// Sign-then-encrypt is these composed: the signed entity is what gets encrypted.
//
// PST-T-12.6: before an entity is signed it is made 7bit-safe (canonicalizeForSigning, below), as
// RFC 3156 §3 and RFC 8551 §3.1.1 ask — a relay that strips trailing whitespace, re-wraps long
// lines or downgrades 8bit must not be able to change a single signed byte. And pgpMimeEncrypt can
// hide recipients (Bcc) behind the wildcard key ID (RFC 9580 §5.1).

import type { KeyObject } from 'node:crypto';
import { createTransferDecoder, generateBoundary, normalizeEncoding, parseContentType, unfold } from '@postroom/mime';
import type { Certificate } from './cms.js';
import { encryptCmsEnveloped, signCmsDetached } from './cms-write.js';
import { PgpError } from './errors.js';
import type { OpenPgpKey } from './keys.js';
import { encryptMessage, signDetached, type EncryptedRecipient } from './write.js';

export interface MimeEntity {
  /** Header lines (folded lines kept as written), without the blank line. */
  headers: string[];
  body: Buffer;
}

/** The entity's bytes: headers, CRLF CRLF, body. */
export function entityBytes(e: MimeEntity): Buffer {
  return Buffer.concat([Buffer.from(`${e.headers.join('\r\n')}\r\n\r\n`, 'utf8'), e.body]);
}

const crlf = (text: string): string => text.replace(/\r?\n/g, '\r\n');

function base64Lines(data: Uint8Array): string {
  const b64 = Buffer.from(data).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return `${lines.join('\r\n')}\r\n`;
}

function boundaryFor(...parts: Buffer[]): string {
  for (;;) {
    const b = generateBoundary();
    if (!parts.some((p) => p.includes(b))) return b;
  }
}

// ---------------------------------------------------------------------------------------------
// Canonicalizing a signed entity (PST-T-12.6; RFC 3156 §3, RFC 8551 §3.1.1, RFC 2046 §5.2.1)
//
// The rules, applied recursively to the entity about to be signed:
//   · every header line loses its trailing whitespace (a continuation line left empty is dropped);
//   · text/* with 7bit, 8bit, binary (or no) Content-Transfer-Encoding is re-encoded
//     quoted-printable: lines of at most 76 characters, trailing space/tab encoded (=20 / =09), and
//     a line start of "-", "." or "From " encoded too (no boundary look-alikes, no dot-stuffing or
//     mbox ">From" munging can touch it);
//   · any other leaf with 7bit/8bit/binary is kept when already safe, else re-encoded base64;
//     a quoted-printable or base64 leaf is kept when safe, else decoded and re-encoded;
//   · multipart/* is walked part by part with its own boundary; its preamble and epilogue (which no
//     MIME reader shows) are dropped, and its Content-Transfer-Encoding becomes the default 7bit;
//   · message/rfc822 may not be encoded (RFC 2046 §5.2.1), so the embedded message is kept byte for
//     byte when it is already safe (its own DKIM signature survives); otherwise its parts are
//     canonicalized by these same rules; and if the result is still not 7bit (8-bit header fields,
//     say, RFC 6532 mail), it becomes message/global in base64, which RFC 6532 §3.5 allows.
// "Safe" means: US-ASCII without NUL, CRLF line ends only, no line over 998 octets, and no line
// ending in whitespace. What cannot be made safe (a multipart nested past MAX_DEPTH, an unknown
// transfer encoding over unsafe bytes) is refused rather than signed in a form a relay could break.

const MAX_DEPTH = 32;
const MAX_LINE = 998;
const QP_LINE = 76;

/** 7bit-safe, in the sense above. */
export function isSevenBitSafe(data: Uint8Array, maxLine = MAX_LINE): boolean {
  let col = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as number;
    if (c === 0x0d) {
      if (data[i + 1] !== 0x0a) return false;
      const prev = i > 0 ? data[i - 1] : undefined;
      if (col > 0 && (prev === 0x20 || prev === 0x09)) return false;
      i++;
      col = 0;
      continue;
    }
    if (c === 0x0a || c === 0 || c > 0x7f) return false;
    if (++col > maxLine) return false;
  }
  const last = data[data.length - 1];
  return !(col > 0 && (last === 0x20 || last === 0x09));
}

const HEX = '0123456789ABCDEF';
const esc = (c: number): string => `=${HEX[c >> 4] ?? '0'}${HEX[c & 15] ?? '0'}`;

/**
 * Quoted-printable (RFC 2045 §6.7) of text: CRLF is a hard line break, every other byte outside
 * printable US-ASCII (a bare CR or LF included) is encoded, as is whitespace at a line's end and a
 * "-", "." or "From " at a line's start. Lines are at most 76 characters.
 */
export function encodeQuotedPrintableSafe(data: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  while (i <= data.length) {
    let end = i;
    while (end < data.length && !(data[end] === 0x0d && data[end + 1] === 0x0a)) end++;
    let line = '';
    for (let j = i; j < end; j++) {
      const c = data[j] as number;
      const lastOfLine = j === end - 1;
      let token: string;
      if ((c === 0x20 || c === 0x09) && !lastOfLine) token = String.fromCharCode(c);
      else if (c >= 0x21 && c <= 0x7e && c !== 0x3d) token = String.fromCharCode(c);
      else token = esc(c);
      // A soft break (the "=") must fit, so a line holds at most 75 characters of content.
      if (line.length + token.length > QP_LINE - 1) {
        out.push(`${line}=\r\n`);
        line = '';
      }
      if (line.length === 0 && token.length === 1) {
        const from = c === 0x46 && Buffer.from(data.subarray(j, j + 5)).toString('latin1') === 'From ';
        if (c === 0x2d || c === 0x2e || from) token = esc(c);
      }
      line += token;
    }
    if (end >= data.length) {
      out.push(line);
      break;
    }
    out.push(`${line}\r\n`);
    i = end + 2;
  }
  return out.join('');
}

function base64Wrapped(data: Uint8Array): string {
  const b64 = Buffer.from(data).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

function decodeTransfer(encoding: string, body: Buffer): Buffer {
  const d = createTransferDecoder(encoding);
  return Buffer.concat([d.write(body), d.end()]);
}

interface Fields {
  /** Each field's physical lines, trailing whitespace stripped. */
  fields: string[][];
}

function splitHead(bytes: Buffer): { head: string; body: Buffer } {
  if (bytes.subarray(0, 2).toString('latin1') === '\r\n') return { head: '', body: bytes.subarray(2) };
  const at = bytes.indexOf('\r\n\r\n');
  if (at < 0) return { head: bytes.toString('latin1'), body: Buffer.alloc(0) };
  return { head: bytes.subarray(0, at).toString('latin1'), body: bytes.subarray(at + 4) };
}

function parseFields(head: string): Fields {
  const fields: string[][] = [];
  for (const raw of head === '' ? [] : head.split('\r\n')) {
    const line = raw.replace(/[ \t]+$/, '');
    const continuation = raw.startsWith(' ') || raw.startsWith('\t');
    const last = fields[fields.length - 1];
    if (continuation && last !== undefined) {
      if (line !== '') last.push(line);
    } else if (line !== '') fields.push([line]);
  }
  return { fields };
}

function fieldValue(f: Fields, name: string): string | null {
  const want = `${name.toLowerCase()}:`;
  const field = f.fields.find((lines) => (lines[0] ?? '').toLowerCase().startsWith(want));
  if (field === undefined) return null;
  return unfold(field.join('\r\n').slice(want.length)).trim();
}

function withFields(f: Fields, drop: readonly string[], add: readonly string[]): string {
  const lower = drop.map((d) => `${d.toLowerCase()}:`);
  const kept = f.fields.filter((lines) => !lower.some((d) => (lines[0] ?? '').toLowerCase().startsWith(d))).map((lines) => lines.join('\r\n'));
  return [...kept, ...add].join('\r\n');
}

function assemble(head: string, body: Buffer | string): Buffer {
  return Buffer.concat([Buffer.from(head === '' ? '\r\n' : `${head}\r\n\r\n`, 'latin1'), typeof body === 'string' ? Buffer.from(body, 'latin1') : body]);
}

/** The parts of a multipart body (the CRLF before each delimiter belongs to it), or null when no delimiter is found. */
function multipartParts(body: Buffer, boundary: string): Buffer[] | null {
  const dash = `--${boundary}`;
  const parts: Buffer[] = [];
  let start: number | null = null;
  let pos = 0;
  while (pos <= body.length) {
    let eol = body.indexOf('\r\n', pos);
    if (eol < 0) eol = body.length;
    const line = body.subarray(pos, eol).toString('latin1');
    if (line.startsWith(dash)) {
      const rest = line.slice(dash.length);
      const close = rest.startsWith('--');
      if (/^[ \t]*$/.test(close ? rest.slice(2) : rest)) {
        if (start !== null) parts.push(body.subarray(start, Math.max(start, pos - 2)));
        if (close) return parts;
        start = eol + 2;
      }
    }
    if (eol >= body.length) break;
    pos = eol + 2;
  }
  // No close delimiter: what follows the last delimiter is the last part (a truncated message).
  if (start === null) return null;
  parts.push(body.subarray(Math.min(start, body.length)));
  return parts;
}

function canonical(bytes: Buffer, defaultType: string, depth: number): Buffer {
  if (depth > MAX_DEPTH) throw new PgpError('unsafe-signed-entity', `the message nests deeper than ${String(MAX_DEPTH)} levels`);
  const { head, body } = splitHead(bytes);
  const f = parseFields(head);
  const ct = parseContentType(fieldValue(f, 'Content-Type'), defaultType);
  const cte = normalizeEncoding(fieldValue(f, 'Content-Transfer-Encoding'));
  const identity = cte === '7bit' || cte === '8bit' || cte === 'binary';

  if (ct.type === 'multipart' && ct.valid) {
    const boundary = ct.params['boundary'];
    const parts = boundary === undefined || boundary === '' ? null : multipartParts(body, boundary);
    if (boundary !== undefined && parts !== null) {
      const childType = ct.subtype === 'digest' ? 'message/rfc822' : 'text/plain';
      const chunks: Buffer[] = [];
      for (const part of parts) chunks.push(Buffer.from(`--${boundary}\r\n`, 'latin1'), canonical(part, childType, depth + 1), Buffer.from('\r\n', 'latin1'));
      chunks.push(Buffer.from(`--${boundary}--\r\n`, 'latin1'));
      return assemble(withFields(f, ['Content-Transfer-Encoding'], []), Buffer.concat(chunks));
    }
    // A multipart without a usable boundary is opaque: kept only if a relay cannot change it.
    if (isSevenBitSafe(body)) return assemble(withFields(f, [], []), body);
    throw new PgpError('unsafe-signed-entity', 'a multipart part without a usable boundary holds 8-bit or unsafe lines');
  }

  if (ct.mimeType === 'message/rfc822' && identity) {
    if (isSevenBitSafe(body)) return assemble(withFields(f, ['Content-Transfer-Encoding'], []), body);
    const inner = canonical(body, 'text/plain', depth + 1);
    if (isSevenBitSafe(inner)) return assemble(withFields(f, ['Content-Transfer-Encoding'], []), inner);
    // RFC 6532 §3.5: message/global may carry a base64 transfer encoding; message/rfc822 may not.
    return assemble(withFields(f, ['Content-Type', 'Content-Transfer-Encoding'], ['Content-Type: message/global', 'Content-Transfer-Encoding: base64']), base64Wrapped(body));
  }

  if (identity) {
    if (ct.type === 'text') return assemble(withFields(f, ['Content-Transfer-Encoding'], ['Content-Transfer-Encoding: quoted-printable']), encodeQuotedPrintableSafe(body));
    if (isSevenBitSafe(body)) return assemble(withFields(f, [], []), body);
    return assemble(withFields(f, ['Content-Transfer-Encoding'], ['Content-Transfer-Encoding: base64']), base64Wrapped(body));
  }
  if (cte === 'quoted-printable' || cte === 'base64') {
    if (isSevenBitSafe(body, QP_LINE)) return assemble(withFields(f, [], []), body);
    const decoded = decodeTransfer(cte, body);
    const encoded = cte === 'base64' ? base64Wrapped(decoded) : encodeQuotedPrintableSafe(decoded);
    return assemble(withFields(f, [], []), encoded);
  }
  if (isSevenBitSafe(body)) return assemble(withFields(f, [], []), body);
  throw new PgpError('unsafe-signed-entity', `a part in the unknown transfer encoding "${cte}" holds 8-bit or unsafe lines`);
}

/**
 * The MIME entity (content headers, blank line, body; strict CRLF) re-encoded so that every byte of
 * it survives transport untouched: 7bit, no line over 998 octets (76 in what is re-encoded here),
 * no trailing whitespace anywhere. The rules are above. What it returns is what gets signed.
 */
export function canonicalizeForSigning(entity: Uint8Array): Buffer {
  return canonical(Buffer.from(entity), 'text/plain', 0);
}

/** RFC 1847: the signed entity verbatim, then the signature part. */
function multipartSigned(protocol: string, micalg: string, entity: Buffer, signaturePart: Buffer): MimeEntity {
  const boundary = boundaryFor(entity, signaturePart);
  // The CRLF before each delimiter belongs to the delimiter (RFC 2046 §5.1.1): the signed bytes are exactly `entity`.
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\n`), entity, Buffer.from(`\r\n--${boundary}\r\n`), signaturePart, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { headers: [`Content-Type: multipart/signed; micalg=${micalg};\r\n protocol="${protocol}";\r\n boundary="${boundary}"`], body };
}

/** RFC 3156 §5: a detached OpenPGP signature (type 0x01, over the CRLF-canonical entity, made 7bit-safe first). */
export function pgpMimeSign(input: Buffer, key: OpenPgpKey, opts: { created?: Date } = {}): MimeEntity {
  const entity = canonicalizeForSigning(input);
  const armored = signDetached(key, entity, opts.created === undefined ? {} : { created: opts.created });
  const part = Buffer.from(
    ['Content-Type: application/pgp-signature; name="signature.asc"', 'Content-Description: OpenPGP digital signature', 'Content-Disposition: attachment; filename="signature.asc"', '', crlf(armored)].join('\r\n'),
    'utf8',
  );
  return multipartSigned('application/pgp-signature', 'pgp-sha256', entity, part);
}

/**
 * RFC 3156 §4: the version part, then the encrypted entity as an armored OpenPGP message. `hidden`
 * keys get PKESKs with the wildcard key ID (RFC 9580 §5.1): the Bcc recipients of a single copy.
 */
export function pgpMimeEncrypt(entity: Buffer, keys: readonly OpenPgpKey[], opts: { now?: Date; hidden?: readonly OpenPgpKey[] } = {}): MimeEntity & { recipients: EncryptedRecipient[] } {
  const enc = encryptMessage(keys, entity, opts);
  const armored = Buffer.from(crlf(enc.armored), 'utf8');
  const boundary = boundaryFor(armored);
  const body = Buffer.concat([
    Buffer.from(
      [
        'This is an OpenPGP/MIME encrypted message (RFC 3156).',
        `--${boundary}`,
        'Content-Type: application/pgp-encrypted',
        'Content-Description: PGP/MIME version identification',
        '',
        'Version: 1',
        '',
        `--${boundary}`,
        'Content-Type: application/octet-stream; name="encrypted.asc"',
        'Content-Description: OpenPGP encrypted message',
        'Content-Disposition: inline; filename="encrypted.asc"',
        '',
        '',
      ].join('\r\n'),
      'utf8',
    ),
    armored,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { headers: [`Content-Type: multipart/encrypted;\r\n protocol="application/pgp-encrypted";\r\n boundary="${boundary}"`], body, recipients: enc.recipients };
}

export interface SmimeSigner {
  certificate: Certificate;
  privateKey: KeyObject;
  chain?: readonly Certificate[];
}

const MICALG: Record<string, string> = { sha256: 'sha-256', sha384: 'sha-384', sha512: 'sha-512' };

/** RFC 8551 §3.5.3: multipart/signed with an application/pkcs7-signature part (detached SignedData), over the entity made 7bit-safe. */
export function smimeSign(input: Buffer, signer: SmimeSigner, opts: { signingTime?: Date } = {}): MimeEntity {
  const entity = canonicalizeForSigning(input);
  const der = signCmsDetached(entity, { certificate: signer.certificate, privateKey: signer.privateKey, ...(signer.chain !== undefined ? { chain: signer.chain } : {}), ...(opts.signingTime !== undefined ? { signingTime: opts.signingTime } : {}) });
  const t = signer.privateKey.asymmetricKeyType;
  const curve = signer.privateKey.asymmetricKeyDetails?.namedCurve;
  const micalg = MICALG[t === 'ed25519' ? 'sha512' : t === 'ec' && curve === 'secp384r1' ? 'sha384' : 'sha256'] ?? 'sha-256';
  const part = Buffer.from(
    ['Content-Type: application/pkcs7-signature; name="smime.p7s"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="smime.p7s"', 'Content-Description: S/MIME Cryptographic Signature', '', base64Lines(der)].join('\r\n'),
    'utf8',
  );
  // base64Lines ends in CRLF; the delimiter's own CRLF follows it.
  return multipartSigned('application/pkcs7-signature', micalg, entity, part.subarray(0, part.length - 2));
}

/** RFC 8551 §3.3: application/pkcs7-mime; smime-type=enveloped-data, base64 of the DER EnvelopedData. */
export function smimeEncrypt(entity: Buffer, recipients: readonly Certificate[]): MimeEntity {
  const der = encryptCmsEnveloped(entity, recipients);
  return {
    headers: [
      'Content-Type: application/pkcs7-mime; smime-type=enveloped-data;\r\n name="smime.p7m"',
      'Content-Transfer-Encoding: base64',
      'Content-Disposition: attachment; filename="smime.p7m"',
      'Content-Description: S/MIME Encrypted Message',
    ],
    body: Buffer.from(base64Lines(der), 'latin1'),
  };
}
