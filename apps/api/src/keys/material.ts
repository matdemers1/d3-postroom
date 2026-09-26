// Reading what the Keys screen imports, and deriving a crypto_key row from it (PST-T-12.2,
// PST-REQ-161). Pure: no database. Every refusal is a KeyError with a stable code the route answers
// with, and a message a person can act on.
//
// The row's fingerprint is the PRIMARY key's (OpenPGP) or the certificate's SHA-256 (S/MIME):
// analyzeMessage trusts a row only for the key whose fingerprint it records, so a block holding
// more than one primary key is refused outright rather than stored under one of them.
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import {
  ArmorError,
  certificatesFromPem,
  CmsError,
  decodeArmors,
  encodeArmor,
  isProtectedSecretBlock,
  keyState,
  parseKeys,
  PgpError,
  publicKeyBlock,
  rfc822Names,
  unlockSecretKeyBlock,
  userIdAddress,
  type Certificate,
  type OpenPgpKey,
} from '@postroom/pgp';

export class KeyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** What a crypto_key row is made from. */
export interface KeyRowData {
  kind: 'pgp' | 'smime';
  owner: 'own' | 'contact';
  address: string;
  fingerprint: string;
  algorithm: string;
  publicKey: string;
  /** The private half to seal (armored OpenPGP secret key, or PKCS#8 PEM), for an own key. */
  privatePlain: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  userIds: string[];
}

export function pgpAlgorithm(key: OpenPgpKey): string {
  return [key.primary, ...key.subkeys].map((m) => (m.bits !== null ? `${m.algorithmName}-${String(m.bits)}` : m.algorithmName)).join(' + ');
}

function describe(err: unknown): string {
  if (err instanceof PgpError || err instanceof CmsError) return err.reason;
  return err instanceof Error ? err.message : String(err);
}

/** The single transferable key in armored text, as binary, and whether it is a secret block. */
function oneBlock(armored: string): { data: Buffer; secret: boolean } {
  let blocks;
  try {
    blocks = decodeArmors(armored).filter((b) => b.type === 'PGP PUBLIC KEY BLOCK' || b.type === 'PGP PRIVATE KEY BLOCK');
  } catch (err) {
    throw new KeyError('invalid_key', `That is not a readable armored key (${err instanceof ArmorError ? err.reason : describe(err)}).`);
  }
  if (blocks.length === 0) throw new KeyError('invalid_key', 'No "-----BEGIN PGP PUBLIC KEY BLOCK-----" or PRIVATE KEY BLOCK was found.');
  if (blocks.length > 1) throw new KeyError('multiple_primary_keys', 'Import one key at a time: the text holds more than one key block.');
  const [b] = blocks;
  if (b === undefined) throw new KeyError('invalid_key', 'No key block.');
  return { data: b.data, secret: b.type === 'PGP PRIVATE KEY BLOCK' };
}

function parseOne(data: Buffer): OpenPgpKey {
  let keys: OpenPgpKey[];
  try {
    keys = parseKeys(data);
  } catch (err) {
    throw new KeyError('invalid_key', `The key could not be read (${describe(err)}).`);
  }
  if (keys.length === 0) throw new KeyError('invalid_key', 'The block holds no key.');
  if (keys.length > 1) throw new KeyError('multiple_primary_keys', `The block holds ${String(keys.length)} primary keys; import each separately.`);
  const [k] = keys;
  if (k === undefined) throw new KeyError('invalid_key', 'The block holds no key.');
  return k;
}

function chooseAddress(candidates: readonly string[], wanted: string | undefined, own: readonly string[] | null): string {
  const pool = own === null ? candidates : candidates.filter((a) => own.includes(a));
  if (wanted !== undefined) {
    if (!pool.includes(wanted)) {
      throw new KeyError('address_mismatch', own === null ? `${wanted} is not one of the key’s addresses (${candidates.join(', ') || 'none'}).` : `${wanted} is not both one of your addresses and one of the key’s.`);
    }
    return wanted;
  }
  const first = pool[0];
  if (first === undefined) {
    throw new KeyError('address_mismatch', own === null ? 'The key names no e-mail address; say which address it is for.' : `None of the key’s addresses (${candidates.join(', ') || 'none'}) is one of yours.`);
  }
  return first;
}

/**
 * An armored OpenPGP key → a row. A PUBLIC KEY BLOCK is a contact's key; a PRIVATE KEY BLOCK is
 * the account's own (unlocked with `passphrase` when protected; stored unprotected, sealed).
 */
export function pgpRowFromArmored(armored: string, opts: { passphrase?: string | undefined; address?: string | undefined; ownAddresses: readonly string[]; now: Date }): KeyRowData {
  const block = oneBlock(armored);
  let data = block.data;
  if (block.secret) {
    let isProtected: boolean;
    try {
      isProtected = isProtectedSecretBlock(data);
    } catch (err) {
      throw new KeyError('invalid_key', `The key could not be read (${describe(err)}).`);
    }
    if (isProtected) {
      if (opts.passphrase === undefined) throw new KeyError('passphrase_required', 'This secret key is protected by a passphrase. Enter it to import the key; Postroom stores it sealed instead.');
      try {
        data = unlockSecretKeyBlock(data, opts.passphrase);
      } catch (err) {
        if (err instanceof PgpError && err.reason === 'bad-passphrase') throw new KeyError('bad_passphrase', 'That passphrase does not unlock the key.');
        throw new KeyError('unsupported_key', `The secret key cannot be unlocked here (${describe(err)}).`);
      }
    }
  }
  const key = parseOne(data);
  const uidAddresses = [...new Set(key.userIds.map(userIdAddress).filter((a): a is string => a !== null))];
  const state = keyState(key, key.primary);
  const revocation = state.revocations.find((r) => r.of === 'primary') ?? null;
  const common = {
    kind: 'pgp' as const,
    fingerprint: key.primary.fingerprint,
    algorithm: pgpAlgorithm(key),
    publicKey: encodeArmor('PGP PUBLIC KEY BLOCK', publicKeyBlock(data)),
    expiresAt: state.expiresAt,
    revokedAt: revocation === null ? null : (revocation.at ?? opts.now),
    userIds: key.userIds,
  };
  if (!block.secret) return { ...common, owner: 'contact', address: chooseAddress(uidAddresses, opts.address, null), privatePlain: null };
  if (![key.primary, ...key.subkeys].some((m) => m.secretKey !== null)) throw new KeyError('unsupported_key', 'The secret key block carries no secret key Postroom can use (a smartcard stub, or an unsupported algorithm).');
  return { ...common, owner: 'own', address: chooseAddress(uidAddresses, opts.address, opts.ownAddresses), privatePlain: encodeArmor('PGP PRIVATE KEY BLOCK', data) };
}

export function certAlgorithm(key: KeyObject): string {
  const t = key.asymmetricKeyType;
  const d = key.asymmetricKeyDetails;
  if (t === 'rsa') return `RSA-${String(d?.modulusLength ?? 0)}`;
  if (t === 'ec') return `ECDSA ${d?.namedCurve === 'prime256v1' ? 'P-256' : d?.namedCurve === 'secp384r1' ? 'P-384' : (d?.namedCurve ?? '')}`.trim();
  if (t === 'ed25519') return 'Ed25519';
  return t ?? 'unknown';
}

const spki = (k: KeyObject): Buffer => k.export({ type: 'spki', format: 'der' });

/** A PEM certificate (and optional PKCS#8 key) → a row. With the key it is the account's own. */
export function smimeRowFromPem(certificatePem: string, opts: { privateKey?: string | undefined; passphrase?: string | undefined; address?: string | undefined; ownAddresses: readonly string[] }): KeyRowData {
  let certs: Certificate[];
  try {
    certs = certificatesFromPem(certificatePem);
  } catch (err) {
    throw new KeyError('invalid_certificate', `The certificate could not be read (${describe(err)}).`);
  }
  const [leaf] = certs;
  if (leaf === undefined) throw new KeyError('invalid_certificate', 'No "-----BEGIN CERTIFICATE-----" block was found.');
  const names = rfc822Names(leaf);
  const publicKey = certs.map((c) => `-----BEGIN CERTIFICATE-----\n${c.der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`).join('');
  const common = { kind: 'smime' as const, fingerprint: leaf.fingerprint, algorithm: certAlgorithm(leaf.publicKey), publicKey, expiresAt: leaf.notAfter, revokedAt: null, userIds: [leaf.subject] };
  if (opts.privateKey === undefined) return { ...common, owner: 'contact', address: chooseAddress(names, opts.address, null), privatePlain: null };
  let priv: KeyObject;
  try {
    priv = createPrivateKey(opts.passphrase === undefined ? opts.privateKey : { key: opts.privateKey, passphrase: opts.passphrase });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/passphrase|decrypt|bad password/i.test(msg)) throw new KeyError(opts.passphrase === undefined ? 'passphrase_required' : 'bad_passphrase', 'The private key is encrypted; enter the passphrase that unlocks it.');
    throw new KeyError('invalid_private_key', 'The private key could not be read (PEM PKCS#8 or a traditional RSA/EC key).');
  }
  if (!spki(createPublicKey(priv)).equals(spki(leaf.publicKey))) throw new KeyError('key_mismatch', 'The private key does not belong to the certificate.');
  const pkcs8 = priv.export({ type: 'pkcs8', format: 'pem' });
  return { ...common, owner: 'own', address: chooseAddress(names, opts.address, opts.ownAddresses), privatePlain: typeof pkcs8 === 'string' ? pkcs8 : pkcs8.toString('utf8') };
}

/** The user IDs a stored row shows: its OpenPGP user IDs, or its certificate subject. */
export function userIdsOf(kind: string, publicKey: string): string[] {
  try {
    if (kind === 'smime') return certificatesFromPem(publicKey).slice(0, 1).map((c) => c.subject);
    for (const b of decodeArmors(publicKey)) if (b.type === 'PGP PUBLIC KEY BLOCK') return parseKeys(b.data).flatMap((k) => k.userIds);
  } catch {
    // A row that will not parse shows no user IDs; the analyzer names the problem where it matters.
  }
  return [];
}
