// PST-T-15.6: the verdict under "New password" on Settings › Account. @d3cloud/ui's PasswordStrength
// draws the bars and speaks the verdict; judging the password is the app's (D-082). This is a hint
// while typing, not the policy: the server still refuses a short or breached password and says which
// rule failed, so nothing here claims a breach check it cannot make. Pure and DOM-free, so it is
// unit-tested.
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

const plural = (n: number): string => `${String(n)} ${n === 1 ? 'character' : 'characters'}`;

/**
 * 0 with nothing typed; 1 while under the minimum, or for a long run of the same few characters;
 * from the minimum, 2 plus a point each for 16+ characters, 20+ characters, and three or more
 * character classes, capped at 4.
 */
export function scorePassword(password: string, min: number = MIN_PASSWORD): StrengthVerdict {
  const length = Array.from(password).length;
  if (length === 0) return { score: 0, label: `At least ${plural(min)}.` };
  if (length < min) return { score: 1, label: `Too short · ${String(length)} of ${plural(min)}` };
  if (new Set(password.toLowerCase()).size < 4) return { score: 1, label: `Too predictable · ${plural(length)}` };
  let points = 2;
  if (length >= 16) points += 1;
  if (length >= 20) points += 1;
  if (characterClasses(password) >= 3) points += 1;
  const score = Math.min(points, 4) as PasswordStrengthScore;
  const word = score === 4 ? 'Strong' : score === 3 ? 'Good' : 'Fair';
  return { score, label: `${word} · ${plural(length)}` };
}
