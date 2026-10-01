// TOTP recovery codes (PST-T-16.7, PST-REQ-197). Ten single-use codes are issued when an account
// completes TOTP enrolment, and again whenever it regenerates them from Security & devices; each is
// accepted once, in place of a TOTP code, at sign-in. They are a second factor, so they are treated
// like passwords: only an Argon2id hash with the server pepper is stored, and the plain codes are
// returned once, in the response that issues them.
//
// A code is ten symbols from Crockford's base32 alphabet (no I, L, O or U, so nothing reads as
// something else), shown as two groups of five. Ten symbols of five bits each is 50 bits, drawn from
// the OS CSPRNG. Input is forgiving the way Crockford intends: case, spaces and dashes are ignored,
// and I/L read as 1 and O as 0.
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@postroom/db';
import { hashPassword, verifyPassword } from './passwords.js';

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 10;
/** Crockford's base32: 32 symbols, so a random byte masked to five bits is unbiased. */
export const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** One code, normalised (ten symbols, no dash): what is hashed and what is compared. */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = '';
  for (const byte of bytes) code += RECOVERY_ALPHABET.charAt(byte & 31);
  return code;
}

/** `count` distinct codes. A repeat at 50 bits is vanishingly rare, but a set never holds one. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

/** How a code is shown: two groups of five, `ABCDE-FGHJK`. */
export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * The normalised code a person typed, or null when it cannot be a recovery code (so it is tried as
 * a TOTP code instead). Case, whitespace and dashes are ignored; I and L read as 1, O as 0.
 */
export function normalizeRecoveryCode(input: string): string | null {
  const code = input
    .toUpperCase()
    .replace(/[\s\-‐‑‒–—]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (code.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of code) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return code;
}

/**
 * Hash each code with the password helper (Argon2id, pepper as its secret). One at a time: each
 * hash is 64 MiB, and ten in parallel would be 640 MiB at once.
 */
export async function hashRecoveryCodes(codes: readonly string[], pepper: string): Promise<string[]> {
  const hashes: string[] = [];
  for (const code of codes) hashes.push(await hashPassword(code, pepper));
  return hashes;
}

export interface StoredRecoveryCode {
  id: string;
  codeHash: string;
}

/** The id of the unused code `code` matches, or null. `code` must already be normalised. */
export async function matchRecoveryCode(
  unused: readonly StoredRecoveryCode[],
  code: string,
  pepper: string,
): Promise<string | null> {
  for (const row of unused) {
    if (await verifyPassword(row.codeHash, code, pepper)) return row.id;
  }
  return null;
}

type Tx = Prisma.TransactionClient;

/**
 * Spend one code. Returns false when it was already used: the conditional update is one statement
 * (`WHERE used_at IS NULL`), so two concurrent uses of one code cannot both win. Run inside the
 * transaction that issues the session.
 */
export async function spendRecoveryCode(tx: Tx, accountId: string, id: string, at: Date): Promise<boolean> {
  const { count } = await tx.recoveryCode.updateMany({
    where: { id, accountId, usedAt: null },
    data: { usedAt: at },
  });
  return count === 1;
}

/**
 * Replace an account's whole set with `hashes`, inside the caller's transaction: the old codes stop
 * working in the same commit the new ones start. Returns how many old codes were removed.
 */
export async function replaceRecoveryCodes(tx: Tx, accountId: string, hashes: readonly string[], at: Date): Promise<number> {
  const { count } = await tx.recoveryCode.deleteMany({ where: { accountId } });
  await tx.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ accountId, codeHash, createdAt: at })) });
  return count;
}
