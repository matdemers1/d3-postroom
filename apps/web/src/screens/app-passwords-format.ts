// Small pure helpers for the app-passwords screen (PST-T-10.3 / PST-REQ-153; PST-T-17.9). Kept out of
// AppPasswords.tsx so they can be unit-tested without pulling in @d3cloud/ui's CSS. The times
// themselves are drawn by the shared RelativeTime ("3 min ago", the full time on hover).
import type { AppPassword, AppPasswordScope } from '../api';

/** What a new password may do unless you untick something: read and send mail. */
export const DEFAULT_SCOPES: readonly AppPasswordScope[] = ['imap', 'smtp'];

const SCOPE_ORDER: readonly AppPasswordScope[] = ['imap', 'smtp', 'dav', 'sieve'];
const SCOPE_NAME: Record<AppPasswordScope, string> = { imap: 'IMAP', smtp: 'SMTP', dav: 'DAV', sieve: 'Sieve' };

/**
 * The scope tag on a row, or null when the password has the default scopes (IMAP and SMTP): a tag on
 * every row that says the same thing says nothing. Otherwise it names what this one is limited or
 * widened to: "IMAP only", "SMTP only", "IMAP · SMTP · DAV".
 */
export function scopeSummary(scopes: readonly AppPasswordScope[]): string | null {
  const set = new Set(scopes);
  const sorted = SCOPE_ORDER.filter((s) => set.has(s));
  if (sorted.length === DEFAULT_SCOPES.length && DEFAULT_SCOPES.every((s) => set.has(s))) return null;
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return `${SCOPE_NAME[sorted[0] as AppPasswordScope]} only`;
  return sorted.map((s) => SCOPE_NAME[s]).join(' · ');
}

/** One fact on a password's description line. */
export type PasswordFact = { kind: 'used'; at: string; ip: string | null } | { kind: 'never-used' } | { kind: 'created'; at: string };

/**
 * The description line, most useful fact first: when it was last used (and from where), or that it
 * never has been; then when it was made. "Used 3 min ago from 203.0.113.7 · created Sep 24".
 */
export function passwordFacts(p: Pick<AppPassword, 'createdAt' | 'lastUsedAt' | 'lastUsedIp'>): PasswordFact[] {
  const use: PasswordFact = p.lastUsedAt === null ? { kind: 'never-used' } : { kind: 'used', at: p.lastUsedAt, ip: p.lastUsedIp };
  return [use, { kind: 'created', at: p.createdAt }];
}
