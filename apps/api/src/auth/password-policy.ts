// The account password policy (PST-T-4.3; ASVS 5.0 6.2). Checked only when a password is set —
// at first-run setup and on a change — never at sign-in, and never with composition rules. Refused
// when it is:
//
// - **too short or too long** — 12 characters at least; 1024 at most, only so a huge body is not
//   free Argon2id work (ASVS 6.2.1, 6.2.9).
// - **common** — one of the most common breached passwords of policy length (common-passwords.ts;
//   ASVS 6.2.4, 6.2.12).
// - **about this system** — built on a word from CONTEXT_WORDS, the documented context-specific list
//   (ASVS 6.1.2, 6.2.11), or on the first label of the mail domain.
//
// The password is compared lower-cased here, but hashed and verified exactly as typed (6.2.8).
import { COMMON_PASSWORDS_TEXT } from './common-passwords.js';
import { MIN_PASSWORD_LENGTH } from './passwords.js';

export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Context-specific words (ASVS 6.1.2): the product, the ecosystem it belongs to and its operator's
 * name. Generic weak words ("password", "qwerty") are the breached list's job, not this one's.
 * Matched by containment after lower-casing and dropping everything but letters and digits, so
 * "Postroom-2026!" is refused.
 */
export const CONTEXT_WORDS: readonly string[] = [
  'postroom',
  'd3cloud',
  'd3auth',
  'demers',
  'webmail',
  'mailserver',
];

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

let common: Set<string> | undefined;

function commonPasswords(): Set<string> {
  common ??= new Set(
    COMMON_PASSWORDS_TEXT.split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0),
  );
  return common;
}

const squash = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface PasswordContext {
  /** The mail domain, whose first label is also refused (e.g. "d3cloud"). */
  domain?: string | undefined;
}

export type PasswordProblem = 'too_short' | 'too_long' | 'common' | 'context_word';

/** Every reason this password is refused, in a fixed order; empty when it is acceptable. */
export function checkPassword(password: string, context: PasswordContext = {}): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  // Length in grapheme clusters: what a person counts as characters (an emoji is one, not two).
  const length = Array.from(segmenter.segment(password)).length;
  if (length < MIN_PASSWORD_LENGTH) problems.push('too_short');
  if (length > MAX_PASSWORD_LENGTH) problems.push('too_long');
  if (commonPasswords().has(password.toLowerCase())) problems.push('common');

  const squashed = squash(password);
  const domainLabel = context.domain?.split('.')[0];
  const systemWords = [...CONTEXT_WORDS, ...(domainLabel === undefined ? [] : [domainLabel])].map(squash).filter((w) => w.length >= 4);
  if (systemWords.some((word) => squashed.includes(word))) problems.push('context_word');

  return problems;
}
