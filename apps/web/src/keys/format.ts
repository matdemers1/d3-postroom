// The Keys screen's and the composer's crypto rules (PST-T-12.2, PST-REQ-161), pure and unit-tested:
// which keys are usable, whether Sign / Encrypt can be offered for a message and why not, which
// recipients lack a key, and how a refusal reads. The server decides again on send (a recipient
// without a key is a 409, never a plaintext send); this only says so before the person presses Send.
import { ApiError } from '../api';
import { addressOf, splitAddresses } from '../mail/format';
import type { CryptoKeyJson, KeyKind } from './api';

export const KIND_LABEL: Readonly<Record<KeyKind, string>> = { pgp: 'OpenPGP', smime: 'S/MIME' };

export type KeyStatus = 'active' | 'revoked' | 'expired';

export function keyStatus(key: Pick<CryptoKeyJson, 'revokedAt' | 'expiresAt'>, now: Date = new Date()): KeyStatus {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && new Date(key.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** A fingerprint as people compare them: groups of four, upper case. */
export function formatFingerprint(fp: string): string {
  const clean = fp.replace(/[\s:]/g, '').toUpperCase();
  return (clean.match(/.{1,4}/g) ?? []).join(' ');
}

/** The distinct lowercased addresses in the composer's To, Cc and Bcc fields. */
export function recipientAddresses(fields: { to: string; cc: string; bcc: string }): string[] {
  const all = [...splitAddresses(fields.to), ...splitAddresses(fields.cc), ...splitAddresses(fields.bcc)].map(addressOf).filter((a) => a.includes('@'));
  return [...new Set(all)];
}

export interface CryptoOption {
  available: boolean;
  /** Why not, when it is not. */
  reason: string | null;
}

export interface CryptoAvailability {
  sign: CryptoOption;
  encrypt: CryptoOption & { missing: string[] };
}

const usable = (keys: readonly CryptoKeyJson[], kind: KeyKind, now: Date): CryptoKeyJson[] => keys.filter((k) => k.kind === kind && keyStatus(k, now) === 'active');

/**
 * Whether the composer can sign and encrypt this message with `kind`: signing needs an own key with
 * its private half; encrypting needs an own key (mail is always encrypted to the sender too) and a
 * key for every recipient.
 */
export function cryptoAvailability(keys: readonly CryptoKeyJson[], kind: KeyKind, recipients: readonly string[], now: Date = new Date()): CryptoAvailability {
  const live = usable(keys, kind, now);
  const own = live.filter((k) => k.owner === 'own');
  const label = KIND_LABEL[kind];
  const sign: CryptoOption = own.some((k) => k.hasPrivate) ? { available: true, reason: null } : { available: false, reason: `You have no ${label} key of your own. Add one on the Keys screen.` };
  const missing = recipients.filter((r) => !live.some((k) => k.address === r.toLowerCase()));
  let encrypt: CryptoAvailability['encrypt'];
  if (own.length === 0) encrypt = { available: false, reason: `Encrypted mail is also encrypted to you, and you have no ${label} key of your own.`, missing };
  else if (missing.length > 0) encrypt = { available: false, reason: `No ${label} key for ${missing.join(', ')}. Import their key on the Keys screen.`, missing };
  else encrypt = { available: true, reason: null, missing };
  return { sign, encrypt };
}

/** The send body's `crypto` member, or undefined when neither is on (or not available). */
export function cryptoRequest(kind: KeyKind, sign: boolean, encrypt: boolean, availability: CryptoAvailability): { sign?: KeyKind; encrypt?: KeyKind } | undefined {
  const s = sign && availability.sign.available;
  // Encrypt is sent whenever it is ticked: if a key went missing since, the server refuses (409)
  // rather than this quietly sending it in the clear.
  if (!s && !encrypt) return undefined;
  return { ...(s ? { sign: kind } : {}), ...(encrypt ? { encrypt: kind } : {}) };
}

/** How a refused key or crypto request reads. */
export function keyErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Postroom did not answer. Check your connection and try again.';
  const body = error.body as { message?: unknown; recipients?: unknown } | null;
  const message = typeof body?.message === 'string' ? body.message : null;
  switch (error.code) {
    case 'recipient_keys_missing': {
      const who = Array.isArray(body?.recipients) ? (body.recipients as unknown[]).filter((r): r is string => typeof r === 'string') : [];
      return `Not sent: there is no key for ${who.length > 0 ? who.join(', ') : 'some recipients'}. Import their key on the Keys screen, or turn Encrypt off.`;
    }
    case 'signing_key_missing':
      return 'Not sent: you have no key of your own to sign with. Add one on the Keys screen, or turn Sign off.';
    case 'own_key_missing':
      return 'Not sent: encrypted mail is also encrypted to you, and you have no key of your own of that kind.';
    case 'crypto_mixed':
      return 'Sign and encrypt with the same kind of key: both OpenPGP or both S/MIME.';
    case 'private_key_unavailable':
      return 'Your private key could not be opened on the server, so nothing was sent.';
    case 'step_up_required':
      return 'Confirm it is you first.';
    case 'duplicate_key':
      return 'That key is already in your keys.';
    case 'address_not_owned':
      return 'A key can only be made for one of your own addresses.';
    default:
      return message ?? `That did not work (${error.code}).`;
  }
}

/** True for the refusals the crypto step of a send makes. */
export function isCryptoRefusal(error: unknown): boolean {
  return error instanceof ApiError && ['recipient_keys_missing', 'signing_key_missing', 'own_key_missing', 'crypto_mixed', 'private_key_unavailable', 'recipient_key_unusable', 'signing_key_unusable'].includes(error.code);
}

/** Own keys first, then contacts; within each by address. */
export function sortKeys(keys: readonly CryptoKeyJson[]): CryptoKeyJson[] {
  return [...keys].sort((a, b) => (a.owner === b.owner ? a.address.localeCompare(b.address) || a.createdAt.localeCompare(b.createdAt) : a.owner === 'own' ? -1 : 1));
}

/** What an import text is, by its armor: a secret OpenPGP key, a public one, a certificate, or not a key. */
export function sniffImport(text: string): 'pgp-secret' | 'pgp-public' | 'certificate' | 'unknown' {
  if (text.includes('-----BEGIN PGP PRIVATE KEY BLOCK-----')) return 'pgp-secret';
  if (text.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----')) return 'pgp-public';
  if (text.includes('-----BEGIN CERTIFICATE-----')) return 'certificate';
  return 'unknown';
}
