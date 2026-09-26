// Hashing app passwords: Argon2id with the same server-side pepper as the account password
// (argon2's `secret` input — mixed in, never stored), but with lighter parameters.
//
// Why lighter: the account password is chosen by a human and the KDF cost is what stands between a
// stolen hash and a dictionary. An app password is 100 random bits, so no dictionary exists and the
// cost adds nothing an attacker notices — while IMAP clients reconnect all day and every connection
// pays it. OWASP's lightest Argon2id profile (19 MiB, two passes, one lane) keeps a protocol login
// in the low milliseconds and still makes the hash a real Argon2id hash.
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';

export const APP_PASSWORD_ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const secretOf = (pepper: string): Buffer => Buffer.from(pepper, 'utf8');

/** Hash the normalized password (see `parseAppPassword`). */
export async function hashAppPassword(normalized: string, pepper: string): Promise<string> {
  return argon2.hash(normalized, { ...APP_PASSWORD_ARGON2_OPTIONS, secret: secretOf(pepper) });
}

/** False, never a throw, for a malformed stored hash: a corrupt row is a failed login, not a crash. */
export async function verifyAppPasswordHash(hash: string, normalized: string, pepper: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, normalized, { secret: secretOf(pepper) });
  } catch {
    return false;
  }
}

// Verified when there is no candidate row, so a miss costs the same as a wrong password.
const decoys = new Map<string, Promise<string>>();

export function decoyAppPasswordHash(pepper: string): Promise<string> {
  let decoy = decoys.get(pepper);
  if (decoy === undefined) {
    decoy = hashAppPassword(`decoy${randomBytes(16).toString('hex')}`, pepper);
    decoys.set(pepper, decoy);
  }
  return decoy;
}
