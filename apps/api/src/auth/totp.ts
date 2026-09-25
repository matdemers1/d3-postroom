// TOTP (RFC 6238), with the shared secret sealed under the KEK at rest (PST-ADR-009) and every
// accepted step burnt, so a code read over someone's shoulder is good for one use at most.
import { openWithKek, sealWithKek, type Kek } from '@postroom/crypto';
import type { Prisma } from '@postroom/db';
import { Secret, TOTP } from 'otpauth';

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
/** One step either side, for clock skew. */
export const TOTP_WINDOW = 1;

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: 'Postroom',
    label,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function provisioningUri(secretBase32: string, label: string): string {
  return totpFor(secretBase32, label).toString();
}

/** The step a code matches at `now`, or null. Replay is the caller's check, against the last step. */
export function matchStep(secretBase32: string, code: string, now: Date): number | null {
  const token = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(token)) return null;
  const delta = totpFor(secretBase32, 'x').validate({ token, window: TOTP_WINDOW, timestamp: now.getTime() });
  if (delta === null) return null;
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD) + delta;
}

// AAD binds a sealed secret to its account: a row copied onto another account will not open.
export function sealTotpSecret(kek: Kek, secretBase32: string, accountId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(sealWithKek(kek, Buffer.from(secretBase32, 'utf8'), `totp:${accountId}`));
}

export function openTotpSecret(kek: Kek, sealed: Uint8Array, accountId: string): string {
  return openWithKek(kek, sealed, `totp:${accountId}`).toString('utf8');
}

type Tx = Prisma.TransactionClient;

/**
 * Accept `step` only if it is newer than the last one this account used, and burn it. Returns
 * false for a replay. Run inside the transaction that acts on the code: the conditional update is
 * one statement, so two concurrent uses of one code cannot both win.
 */
export async function burnStep(tx: Tx, accountId: string, step: number): Promise<boolean> {
  const { count } = await tx.account.updateMany({
    where: { id: accountId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }] },
    data: { totpLastStep: BigInt(step) },
  });
  return count === 1;
}
