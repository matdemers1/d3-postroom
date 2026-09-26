// Signing and encrypting what the composer sends (PST-T-12.2, PST-REQ-161): "Where the user has a
// key, the composer shall sign and encrypt outbound mail with PGP or S/MIME."
//
// The message is composed exactly as without crypto (message.ts: headers, Markdown alternative,
// forward attachment); then its content — the Content-* header fields and the body — becomes the
// MIME entity that is protected, and the message headers (From, To, Subject, Date, Message-ID, …)
// stay outside it:
//   sign     PGP/MIME multipart/signed (RFC 3156 §5) or S/MIME multipart/signed (RFC 8551 §3.5.3),
//            with the sender's own key or certificate for the From address (any own one otherwise)
//   encrypt  PGP/MIME multipart/encrypted (RFC 3156 §4) or application/pkcs7-mime;
//            smime-type=enveloped-data (RFC 8551 §3.3) to every To/Cc/Bcc recipient's key AND the
//            sender's own key, so the Sent copy (the very blob that is queued) opens for them too
//   both     sign, then encrypt the signed entity (RFC 3156 §6.1)
// A recipient without a key is a refusal (409, naming them), never a plaintext send.
//
// Not protected: the header fields. Subject, To and the rest travel in the clear (header protection,
// RFC 9788, is out of scope). DKIM still signs the outer message, as for any other send.
import { createPrivateKey, type KeyObject } from 'node:crypto';
import type { Kek } from '@postroom/crypto';
import type { Db } from '@postroom/db';
import {
  certificatesFromPem,
  CmsError,
  decodeArmors,
  entityBytes,
  parseKeys,
  PgpError,
  pgpMimeEncrypt,
  pgpMimeSign,
  smimeEncrypt,
  smimeSign,
  type Certificate,
  type MimeEntity,
  type OpenPgpKey,
} from '@postroom/pgp';
import { openPrivateKey } from '../mail/crypto-keys.js';

export type CryptoKind = 'pgp' | 'smime';

export interface CryptoRequest {
  sign?: CryptoKind | undefined;
  encrypt?: CryptoKind | undefined;
}

/** A send the crypto step refuses: status, stable code, a sentence, and (for missing keys) who. */
export class CryptoRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly recipients: string[] | null = null,
  ) {
    super(message);
  }
}

const LABEL: Record<CryptoKind, string> = { pgp: 'OpenPGP', smime: 'S/MIME' };

/**
 * The message's header fields as written (folded lines kept), split into the message's own and the
 * content's (Content-*), and the body. The content fields and the body are the entity to protect.
 */
export function splitMessage(raw: Buffer): { outer: string[]; entity: Buffer } {
  const at = raw.indexOf('\r\n\r\n');
  const head = at < 0 ? raw.toString('latin1') : raw.subarray(0, at).toString('latin1');
  const body = at < 0 ? Buffer.alloc(0) : raw.subarray(at + 4);
  const fields: string[] = [];
  for (const line of head.split('\r\n')) {
    const last = fields.length - 1;
    const prev = fields[last];
    if ((line.startsWith(' ') || line.startsWith('\t')) && prev !== undefined) fields[last] = `${prev}\r\n${line}`;
    else if (line !== '') fields.push(line);
  }
  const content = fields.filter((f) => /^content-/i.test(f));
  const outer = fields.filter((f) => !/^content-/i.test(f));
  if (!content.some((f) => /^content-type:/i.test(f))) content.unshift('Content-Type: text/plain; charset=us-ascii');
  // Header bytes are UTF-8 as message.ts wrote them; read as latin1 and written back as latin1, unchanged.
  return { outer, entity: Buffer.concat([Buffer.from(`${content.join('\r\n')}\r\n\r\n`, 'latin1'), body]) };
}

function joinMessage(outer: readonly string[], e: MimeEntity): Buffer {
  return Buffer.concat([Buffer.from(`${[...outer, ...e.headers].join('\r\n')}\r\n\r\n`, 'latin1'), e.body]);
}

type Row = Awaited<ReturnType<Db['cryptoKey']['findMany']>>[number];

function pgpKeyOf(row: Row, armored: string): OpenPgpKey {
  // As the verifier reads a row: only the primary key whose fingerprint the row records.
  const want = row.fingerprint.replace(/[\s:]/g, '').toUpperCase();
  for (const a of decodeArmors(armored)) {
    if (a.type !== 'PGP PUBLIC KEY BLOCK' && a.type !== 'PGP PRIVATE KEY BLOCK') continue;
    for (const k of parseKeys(a.data)) if (k.primary.fingerprint === want) return k;
  }
  throw new CryptoRefusal(409, 'invalid_key', `The stored key ${row.fingerprint} (${row.address}) could not be read.`);
}

function pgpKeyFromBinary(row: Row, block: Buffer): OpenPgpKey {
  const want = row.fingerprint.replace(/[\s:]/g, '').toUpperCase();
  const key = parseKeys(block).find((k) => k.primary.fingerprint === want);
  if (key === undefined) throw new CryptoRefusal(409, 'invalid_key', `The stored key ${row.fingerprint} (${row.address}) could not be read.`);
  return key;
}

function leafAndChain(row: Row): { leaf: Certificate; chain: Certificate[] } {
  const [leaf, ...chain] = certificatesFromPem(row.publicKey);
  if (leaf === undefined) throw new CryptoRefusal(409, 'invalid_key', `The stored certificate for ${row.address} could not be read.`);
  return { leaf, chain };
}

function privateObject(secret: Buffer | string): KeyObject {
  return typeof secret === 'string' ? createPrivateKey(secret) : createPrivateKey({ key: secret, format: 'der', type: 'pkcs8' });
}

export interface ProtectInput {
  accountId: string;
  /** The From address, lowercased. */
  from: string;
  /** Every envelope recipient (To, Cc and Bcc), lowercased. */
  recipients: readonly string[];
  crypto: CryptoRequest;
  now: Date;
}

/** The account's usable (not revoked, not expired) keys of `kind`. */
async function usableRows(db: Db, accountId: string, kind: CryptoKind, now: Date): Promise<Row[]> {
  const rows = await db.cryptoKey.findMany({ where: { accountId, kind, revokedAt: null }, orderBy: { createdAt: 'desc' } });
  return rows.filter((r) => r.expiresAt === null || r.expiresAt.getTime() > now.getTime());
}

/** The own key for the From address, else the newest own key of that kind; with a private half for signing. */
function ownRow(rows: readonly Row[], from: string, needPrivate: boolean): Row | null {
  const own = rows.filter((r) => r.owner === 'own' && (!needPrivate || r.sealedPrivate !== null));
  return own.find((r) => r.address === from) ?? own[0] ?? null;
}

/**
 * `raw` (the composed message) signed and/or encrypted as `input.crypto` asks. Throws CryptoRefusal
 * when it cannot be done as asked — a missing key is never a reason to send it unprotected.
 */
export async function protectMessage(db: Db, kek: Kek | null, raw: Buffer, input: ProtectInput): Promise<Buffer> {
  const { sign, encrypt } = input.crypto;
  if (sign === undefined && encrypt === undefined) return raw;
  if (sign !== undefined && encrypt !== undefined && sign !== encrypt) throw new CryptoRefusal(400, 'crypto_mixed', 'Sign and encrypt with the same kind: both OpenPGP or both S/MIME.');
  const kind = sign ?? encrypt ?? 'pgp';
  const rows = await usableRows(db, input.accountId, kind, input.now);
  const { outer, entity } = splitMessage(raw);
  let current: MimeEntity | null = null;
  let content = entity;

  if (sign !== undefined) {
    const row = ownRow(rows, input.from, true);
    if (row === null) throw new CryptoRefusal(409, 'signing_key_missing', `You have no ${LABEL[kind]} key of your own to sign with. Generate or import one on the Keys screen.`);
    const secret = openPrivateKey(kek, row);
    if (secret === null) throw new CryptoRefusal(503, 'private_key_unavailable', 'Your private key could not be opened (the KEK is not loaded), so nothing was sent.');
    try {
      if (kind === 'pgp') {
        const key = typeof secret === 'string' ? pgpKeyOf(row, secret) : pgpKeyFromBinary(row, secret);
        current = pgpMimeSign(content, key, { created: input.now });
      } else {
        const { leaf, chain } = leafAndChain(row);
        current = smimeSign(content, { certificate: leaf, privateKey: privateObject(secret), chain }, { signingTime: input.now });
      }
    } catch (err) {
      if (err instanceof CryptoRefusal) throw err;
      if (err instanceof PgpError || err instanceof CmsError) throw new CryptoRefusal(409, 'signing_key_unusable', `Your ${LABEL[kind]} key cannot sign (${err.reason}).`);
      throw err;
    }
    content = entityBytes(current);
  }

  if (encrypt !== undefined) {
    const recipients = [...new Set(input.recipients.map((r) => r.toLowerCase()))];
    const missing = recipients.filter((r) => !rows.some((row) => row.address === r));
    if (missing.length > 0) {
      throw new CryptoRefusal(409, 'recipient_keys_missing', `Not sent: no ${LABEL[kind]} key for ${missing.join(', ')}. Import their key on the Keys screen, or send without encryption.`, missing);
    }
    const own = ownRow(rows, input.from, false);
    if (own === null) throw new CryptoRefusal(409, 'own_key_missing', `You have no ${LABEL[kind]} key of your own: encrypted mail is always encrypted to you too, so your Sent copy opens.`);
    const chosen = [...rows.filter((row) => recipients.includes(row.address)), own].filter((row, i, all) => all.findIndex((o) => o.id === row.id) === i);
    try {
      current = kind === 'pgp' ? pgpMimeEncrypt(content, chosen.map((row) => pgpKeyOf(row, row.publicKey)), { now: input.now }) : smimeEncrypt(content, chosen.map((row) => leafAndChain(row).leaf));
    } catch (err) {
      if (err instanceof CryptoRefusal) throw err;
      if (err instanceof PgpError || err instanceof CmsError) throw new CryptoRefusal(409, 'recipient_key_unusable', `Not sent: a recipient's ${LABEL[kind]} key cannot be encrypted to (${err.message}).`);
      throw err;
    }
  }
  if (current === null) return raw;
  return joinMessage(outer, current);
}
