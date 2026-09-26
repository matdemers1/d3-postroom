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
// Bcc (PST-T-12.6): an encrypted message names its recipients' keys, so one copy for everyone would
// tell the To/Cc recipients who was Bcc'd. Instead:
//   separate  (a send that goes now; both schemes) the main copy is encrypted to To/Cc + the sender
//             and goes to the To/Cc envelope; each Bcc recipient gets a copy of its own, encrypted to
//             that recipient + the sender, queued to that one address. The Sent folder keeps the main
//             copy. A signature is made once and every copy carries it.
//   hidden    (a held send: undo window or scheduled — one blob is held and released) OpenPGP only:
//             one copy whose Bcc PKESKs carry the wildcard key ID (RFC 9580 §5.1), so they name no
//             one. S/MIME has no equivalent (a RecipientInfo always names its certificate), so a held
//             S/MIME-encrypted send with Bcc is refused (409 smime_bcc_held): send it now instead.
// Signing (RFC 3156 §3, RFC 8551 §3.1.1): @postroom/pgp makes the entity 7bit-safe before it signs,
// so a relay that strips trailing whitespace or re-wraps lines cannot break the signature.
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
  /** The To and Cc envelope recipients, lowercased. */
  recipients: readonly string[];
  /** The Bcc envelope recipients (those not also To/Cc), lowercased. */
  bcc?: readonly string[];
  /** How an encrypted message hides its Bcc recipients (see above). Default: separate. */
  bccMode?: 'separate' | 'hidden';
  crypto: CryptoRequest;
  now: Date;
}

/** One queued copy for one Bcc recipient: its own encryption, its own envelope. */
export interface BccCopy {
  address: string;
  raw: Buffer;
}

export interface ProtectedMessage {
  /** For the To/Cc envelope (and, when bccCopies is empty, for Bcc too); the Sent copy. */
  main: Buffer;
  /** Non-empty only for an encrypted send with Bcc in `separate` mode. */
  bccCopies: BccCopy[];
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
 * `raw` (the composed message) signed and/or encrypted as `input.crypto` asks — the main copy, and
 * for an encrypted send with Bcc (separate mode) one copy per Bcc recipient. Throws CryptoRefusal
 * when it cannot be done as asked — a missing key is never a reason to send it unprotected.
 */
export async function protectMessage(db: Db, kek: Kek | null, raw: Buffer, input: ProtectInput): Promise<ProtectedMessage> {
  const { sign, encrypt } = input.crypto;
  if (sign === undefined && encrypt === undefined) return { main: raw, bccCopies: [] };
  if (sign !== undefined && encrypt !== undefined && sign !== encrypt) throw new CryptoRefusal(400, 'crypto_mixed', 'Sign and encrypt with the same kind: both OpenPGP or both S/MIME.');
  const kind = sign ?? encrypt ?? 'pgp';
  const rows = await usableRows(db, input.accountId, kind, input.now);
  const { outer, entity } = splitMessage(raw);
  let signed: MimeEntity | null = null;
  let content = entity;

  if (sign !== undefined) {
    const row = ownRow(rows, input.from, true);
    if (row === null) throw new CryptoRefusal(409, 'signing_key_missing', `You have no ${LABEL[kind]} key of your own to sign with. Generate or import one on the Keys screen.`);
    const secret = openPrivateKey(kek, row);
    if (secret === null) throw new CryptoRefusal(503, 'private_key_unavailable', 'Your private key could not be opened (the KEK is not loaded), so nothing was sent.');
    try {
      if (kind === 'pgp') {
        const key = typeof secret === 'string' ? pgpKeyOf(row, secret) : pgpKeyFromBinary(row, secret);
        signed = pgpMimeSign(content, key, { created: input.now });
      } else {
        const { leaf, chain } = leafAndChain(row);
        signed = smimeSign(content, { certificate: leaf, privateKey: privateObject(secret), chain }, { signingTime: input.now });
      }
    } catch (err) {
      if (err instanceof CryptoRefusal) throw err;
      if (err instanceof PgpError || err instanceof CmsError) throw new CryptoRefusal(409, 'signing_key_unusable', `Your ${LABEL[kind]} key cannot sign (${err.reason}).`);
      throw err;
    }
    content = entityBytes(signed);
  }

  if (encrypt === undefined) return { main: signed === null ? raw : joinMessage(outer, signed), bccCopies: [] };

  const named = [...new Set(input.recipients.map((r) => r.toLowerCase()))];
  const bcc = [...new Set((input.bcc ?? []).map((r) => r.toLowerCase()))].filter((r) => !named.includes(r));
  const missing = [...named, ...bcc].filter((r) => !rows.some((row) => row.address === r));
  if (missing.length > 0) {
    throw new CryptoRefusal(409, 'recipient_keys_missing', `Not sent: no ${LABEL[kind]} key for ${missing.join(', ')}. Import their key on the Keys screen, or send without encryption.`, missing);
  }
  const own = ownRow(rows, input.from, false);
  if (own === null) throw new CryptoRefusal(409, 'own_key_missing', `You have no ${LABEL[kind]} key of your own: encrypted mail is always encrypted to you too, so your Sent copy opens.`);
  const mode = input.bccMode ?? 'separate';
  if (mode === 'hidden' && kind === 'smime' && bcc.length > 0) {
    throw new CryptoRefusal(409, 'smime_bcc_held', 'An S/MIME-encrypted message names every recipient’s certificate, so its Bcc recipients get copies of their own — which a held (undo or scheduled) send cannot do. Send it now, or without Bcc.');
  }
  const rowsFor = (addresses: readonly string[]): Row[] => [...rows.filter((row) => addresses.includes(row.address)), own].filter((row, i, all) => all.findIndex((o) => o.id === row.id) === i);
  const encryptTo = (to: readonly Row[], hidden: readonly Row[] = []): MimeEntity => {
    try {
      if (kind === 'pgp') {
        const hiddenKeys = hidden.filter((h) => !to.some((t) => t.id === h.id)).map((row) => pgpKeyOf(row, row.publicKey));
        return pgpMimeEncrypt(content, to.map((row) => pgpKeyOf(row, row.publicKey)), { now: input.now, ...(hiddenKeys.length > 0 ? { hidden: hiddenKeys } : {}) });
      }
      return smimeEncrypt(content, to.map((row) => leafAndChain(row).leaf));
    } catch (err) {
      if (err instanceof CryptoRefusal) throw err;
      if (err instanceof PgpError || err instanceof CmsError) throw new CryptoRefusal(409, 'recipient_key_unusable', `Not sent: a recipient's ${LABEL[kind]} key cannot be encrypted to (${err.message}).`);
      throw err;
    }
  };

  if (mode === 'hidden') {
    const bccRows = rows.filter((row) => bcc.includes(row.address));
    return { main: joinMessage(outer, encryptTo(rowsFor(named), bccRows)), bccCopies: [] };
  }
  const main = joinMessage(outer, encryptTo(rowsFor(named)));
  const bccCopies = bcc.map((address) => ({ address, raw: joinMessage(outer, encryptTo(rowsFor([address]))) }));
  return { main, bccCopies };
}
