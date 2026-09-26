// MIME framing for outbound signed and encrypted mail (PST-T-12.2, PST-REQ-161):
//   PGP/MIME (RFC 3156)  multipart/signed; protocol="application/pgp-signature"; micalg=pgp-sha256
//                        multipart/encrypted; protocol="application/pgp-encrypted"
//   S/MIME 4.0 (RFC 8551) multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256
//                        application/pkcs7-mime; smime-type=enveloped-data
// Each takes the MIME entity to protect — its content headers, a blank line, its body, strict
// CRLF — and returns the content headers and body of the entity that replaces it. The message
// headers (From, To, Subject, …) stay outside: Subject protection (RFC 9788) is out of scope.
// Sign-then-encrypt is these composed: the signed entity is what gets encrypted.

import type { KeyObject } from 'node:crypto';
import { generateBoundary } from '@postroom/mime';
import type { Certificate } from './cms.js';
import { encryptCmsEnveloped, signCmsDetached } from './cms-write.js';
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

/** RFC 1847: the signed entity verbatim, then the signature part. */
function multipartSigned(protocol: string, micalg: string, entity: Buffer, signaturePart: Buffer): MimeEntity {
  const boundary = boundaryFor(entity, signaturePart);
  // The CRLF before each delimiter belongs to the delimiter (RFC 2046 §5.1.1): the signed bytes are exactly `entity`.
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\n`), entity, Buffer.from(`\r\n--${boundary}\r\n`), signaturePart, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { headers: [`Content-Type: multipart/signed; micalg=${micalg};\r\n protocol="${protocol}";\r\n boundary="${boundary}"`], body };
}

/** RFC 3156 §5: a detached OpenPGP signature (type 0x01, over the CRLF-canonical entity). */
export function pgpMimeSign(entity: Buffer, key: OpenPgpKey, opts: { created?: Date } = {}): MimeEntity {
  const armored = signDetached(key, entity, opts.created === undefined ? {} : { created: opts.created });
  const part = Buffer.from(
    ['Content-Type: application/pgp-signature; name="signature.asc"', 'Content-Description: OpenPGP digital signature', 'Content-Disposition: attachment; filename="signature.asc"', '', crlf(armored)].join('\r\n'),
    'utf8',
  );
  return multipartSigned('application/pgp-signature', 'pgp-sha256', entity, part);
}

/** RFC 3156 §4: the version part, then the encrypted entity as an armored OpenPGP message. */
export function pgpMimeEncrypt(entity: Buffer, keys: readonly OpenPgpKey[], opts: { now?: Date } = {}): MimeEntity & { recipients: EncryptedRecipient[] } {
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

/** RFC 8551 §3.5.3: multipart/signed with an application/pkcs7-signature part (detached SignedData). */
export function smimeSign(entity: Buffer, signer: SmimeSigner, opts: { signingTime?: Date } = {}): MimeEntity {
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
