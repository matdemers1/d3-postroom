// PST-T-15.6: the verdict under "New password" on Settings › Account. @d3cloud/ui's PasswordStrength
// draws the bars and speaks the verdict; judging the password is the app's (D-082). This is a hint
// while typing, not the policy: the server still refuses a short, common or system-word password and
// says which rule failed. So the words describe only what the client can know — length, variety, and
// the server's own list of system words — and never say "Strong": the server refuses 20-character
// passwords from its common list that length and variety alone would praise. Pure and DOM-free, so it
// is unit-tested.
import type { PasswordStrengthScore } from '@d3cloud/ui';

/** The account password policy's floor (the server enforces the same). */
export const MIN_PASSWORD = 12;

export interface StrengthVerdict {
  score: PasswordStrengthScore;
  /** The words beside the bars: the accessible signal, since the bars are only colour and length. */
  label: string;
}

/** How many of lower case, upper case, digits and everything else (spaces, symbols) appear. */
export function characterClasses(password: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
}

/** The server's context-specific words (apps/api/src/auth/password-policy.ts CONTEXT_WORDS, ASVS
 * 6.2.11), mirrored so the hint can say so before the server does. The server also refuses the mail
 * domain's first label, which the caller passes in. */
export const CONTEXT_WORDS: readonly string[] = ['postroom', 'd3cloud', 'd3auth', 'demers', 'webmail', 'mailserver'];

const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The first system word the password is built on, if any (the server's rule, applied the same way). */
export function contextWordIn(password: string, domain?: string | null): string | null {
  const label = domain?.split('.')[0];
  const words = [...CONTEXT_WORDS, ...(label === undefined || label === '' ? [] : [label])].map(squash).filter((w) => w.length >= 4);
  const squashed = squash(password);
  return words.find((w) => squashed.includes(w)) ?? null;
}

const plural = (n: number): string => `${String(n)} ${n === 1 ? 'character' : 'characters'}`;

/**
 * 0 with nothing typed; 1 while under the minimum, or for a long run of the same few characters;
 * 1 for a password built on a system word the server refuses; from the minimum, 2 plus a point each
 * for 16+ characters, 20+ characters, and three or more character classes, capped at 4.
 */
export function scorePassword(password: string, min: number = MIN_PASSWORD, domain?: string | null): StrengthVerdict {
  const length = Array.from(password).length;
  if (length === 0) return { score: 0, label: `At least ${plural(min)}.` };
  if (length < min) return { score: 1, label: `Too short · ${String(length)} of ${plural(min)}` };
  if (new Set(password.toLowerCase()).size < 4) return { score: 1, label: `Too predictable · ${plural(length)}` };
  const word = contextWordIn(password, domain);
  if (word !== null) return { score: 1, label: `Built on “${word}”, which is refused · ${plural(length)}` };
  let points = 2;
  if (length >= 16) points += 1;
  if (length >= 20) points += 1;
  if (characterClasses(password) >= 3) points += 1;
  const score = Math.min(points, 4) as PasswordStrengthScore;
  const words = score === 4 ? 'Long and varied' : score === 3 ? 'Longer' : 'Meets the minimum';
  return { score, label: `${words} · ${plural(length)}` };
}
