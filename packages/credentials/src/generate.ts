// App password format. A generated password is 28 lowercase base32 characters: an 8-character
// public prefix (40 bits, stored in the clear so verification looks up one row rather than hashing
// every candidate) followed by a 20-character secret (100 bits, only ever stored as a hash).
//
// It is shown in groups of four — `abcd-efgh-ijkl-mnop-qrst-uvwx-yz23` — for typing on a phone.
// The first two groups are the prefix, so the displayed form is also `<prefix>-<secret>` with the
// secret's own separators. Parsing ignores case, dashes and whitespace, so a user who types it in
// upper case, with spaces, or without separators at all is still understood.
import { randomBytes } from 'node:crypto';

/** RFC 4648 base32, lowercased: no 0/1/8/9, so no O-vs-0 or l-vs-1 confusion on a phone keyboard. */
export const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const PREFIX_LENGTH = 8;
export const SECRET_LENGTH = 20;
const TOTAL = PREFIX_LENGTH + SECRET_LENGTH;
const GROUP = 4;

export interface GeneratedAppPassword {
  /** The public lookup prefix, stored in the clear. */
  readonly prefix: string;
  /** Prefix + secret, no separators: what gets hashed. */
  readonly normalized: string;
  /** The grouped form handed to the user once. */
  readonly display: string;
}

/** `count` uniformly random base32 characters. 256 is a multiple of 32, so `byte & 31` is unbiased. */
export function randomBase32(count: number, random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(count);
  let out = '';
  for (let i = 0; i < count; i++) out += BASE32_ALPHABET[(bytes[i] ?? 0) & 31] ?? '';
  return out;
}

/** Split into groups of four joined by dashes. */
export function groupForDisplay(normalized: string): string {
  const groups: string[] = [];
  for (let i = 0; i < normalized.length; i += GROUP) groups.push(normalized.slice(i, i + GROUP));
  return groups.join('-');
}

export function generateAppPassword(random: (n: number) => Buffer = randomBytes): GeneratedAppPassword {
  const normalized = randomBase32(TOTAL, random);
  return { prefix: normalized.slice(0, PREFIX_LENGTH), normalized, display: groupForDisplay(normalized) };
}

export interface ParsedAppPassword {
  readonly prefix: string;
  readonly normalized: string;
}

/**
 * The prefix and normalized form of a presented password, or null when it cannot be an app
 * password at all (wrong length or a character outside base32 once case, dashes and whitespace are
 * dropped). Null is not a shortcut to a fast rejection: the verifier still hashes a decoy.
 */
export function parseAppPassword(input: string): ParsedAppPassword | null {
  if (input.length > 128) return null;
  const normalized = input.toLowerCase().replace(/[\s-]/g, '');
  if (normalized.length !== TOTAL) return null;
  if (!/^[a-z2-7]+$/.test(normalized)) return null;
  return { prefix: normalized.slice(0, PREFIX_LENGTH), normalized };
}
