// This account's OpenPGP keys and S/MIME certificates (crypto_key rows) as @postroom/pgp's
// analyzer takes them, and the sealing of their private halves under the KEK (PST-T-12.1,
// PST-REQ-160; secrets at rest, PST-REQ-010 / PST-ADR-009).
//
// A private key is sealed with @postroom/crypto's KEK-sealed format (0x01: kekId, nonce, AES-256-GCM)
// and the whole sealed value is stored in `sealed_private`; `kek_id` records which KEK sealed it,
// and `wrapped_dek` / `nonce` stay null (the sealed form carries its own nonce and needs no DEK for
// a few kilobytes). The AAD binds the value to its row — account, kind and fingerprint — so a
// sealed key copied onto another account's row, or another key's row, does not open.
//
// A private key is opened only when a message names that key as a recipient, and only for the
// length of one Inspect request; nothing here caches it.

import { openWithKek, sealedKekId, sealWithKek, type Kek } from '@postroom/crypto';
import type { Db } from '@postroom/db';
import type { KnownKey } from '@postroom/pgp';

export type CryptoKeyKind = 'pgp' | 'smime';

/** The AAD a sealed private key is bound to. */
export function privateKeyAad(accountId: string, kind: CryptoKeyKind, fingerprint: string): string {
  return `postroom:crypto-key:v1:${accountId}:${kind}:${fingerprint.toLowerCase()}`;
}

/** Seal a private key (armored OpenPGP secret key, or PKCS#8 PEM) for a crypto_key row. */
export function sealPrivateKey(kek: Kek, accountId: string, kind: CryptoKeyKind, fingerprint: string, plaintext: Uint8Array | string): { sealedPrivate: Buffer; kekId: string } {
  const bytes = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  return { sealedPrivate: sealWithKek(kek, bytes, privateKeyAad(accountId, kind, fingerprint)), kekId: kek.id };
}

interface SealedRow {
  accountId: string;
  kind: string;
  fingerprint: string;
  sealedPrivate: Uint8Array | null;
}

/**
 * Open a row's private key. Null when there is none, the KEK is not loaded, or it was sealed under
 * a different KEK or for a different row (authentication fails) — never a throw, so one bad row
 * cannot take the Inspect drawer down with it.
 */
export function openPrivateKey(kek: Kek | null, row: SealedRow): Buffer | string | null {
  if (kek === null || row.sealedPrivate === null) return null;
  if (row.kind !== 'pgp' && row.kind !== 'smime') return null;
  if (sealedKekId(row.sealedPrivate) !== kek.id) return null;
  let plain: Buffer;
  try {
    plain = openWithKek(kek, row.sealedPrivate, privateKeyAad(row.accountId, row.kind, row.fingerprint));
  } catch {
    return null;
  }
  // Armored and PEM keys are text; anything else is binary (an OpenPGP key block or PKCS#8 DER).
  return plain.subarray(0, 5).toString('latin1') === '-----' ? plain.toString('utf8') : plain;
}

/** Every usable (not revoked) key of the account, with a lazy opener for its private half. */
export async function loadAccountKeys(db: Db, accountId: string, kek: Kek | null): Promise<KnownKey[]> {
  const rows = await db.cryptoKey.findMany({ where: { accountId, revokedAt: null }, orderBy: { createdAt: 'asc' } });
  const out: KnownKey[] = [];
  for (const row of rows) {
    if ((row.kind !== 'pgp' && row.kind !== 'smime') || (row.owner !== 'own' && row.owner !== 'contact')) continue;
    out.push({
      id: row.id,
      kind: row.kind,
      owner: row.owner,
      address: row.address.toLowerCase(),
      fingerprint: row.fingerprint,
      publicKey: row.publicKey,
      openPrivate: row.owner === 'own' && row.sealedPrivate !== null ? () => Promise.resolve(openPrivateKey(kek, row)) : undefined,
    });
  }
  return out;
}
