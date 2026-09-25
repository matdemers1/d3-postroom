// Argon2id with a server-side pepper (PST-REQ-005). The pepper is argon2's `secret` input: it is
// mixed into the hash but never stored in it, so a stolen database alone does not allow an offline
// attack — the attacker also needs a value that only ever lives in the process environment.
//
// The account password is web-only. IMAP/SMTP/DAV/Sieve accept app passwords and nothing else
// (PST-REQ-027); nothing in this file is reachable from a protocol daemon.
import argon2 from 'argon2';

/** OWASP's second Argon2id profile: 64 MiB, three passes, one lane. */
export const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
} as const;

export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(password: string, pepper: string): Promise<string> {
  return argon2.hash(password, { ...ARGON2_OPTIONS, secret: Buffer.from(pepper, 'utf8') });
}

/** False, never a throw, for a malformed stored hash: a corrupt row is a failed sign-in, not a 500. */
export async function verifyPassword(hash: string, password: string, pepper: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password, { secret: Buffer.from(pepper, 'utf8') });
  } catch {
    return false;
  }
}

// Verified when no account matches, so an unknown login and a wrong password cost the same time.
const decoys = new Map<string, Promise<string>>();

export function decoyHash(pepper: string): Promise<string> {
  let decoy = decoys.get(pepper);
  if (decoy === undefined) {
    decoy = hashPassword(`decoy:${String(Math.random())}`, pepper);
    decoys.set(pepper, decoy);
  }
  return decoy;
}
