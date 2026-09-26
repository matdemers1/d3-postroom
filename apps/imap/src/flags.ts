// Message flags as IMAP spells them. System flags are stored in their canonical spelling
// (`\Seen`); keywords keep the client's, and compare case-insensitively (RFC 9051 §2.3.2).
// `\Recent` is never stored: Postroom has no notion of a session that "first saw" a message, so it
// is always empty (RFC 9051 dropped it; under rev1 every message is simply not recent).
import { canonicalFlag, type StoreOperation } from '@postroom/imap-proto';

export const SYSTEM_FLAGS = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'] as const;
export const SEEN = '\\Seen';
export const DELETED = '\\Deleted';

/** Canonical, de-duplicated (case-insensitively), without `\Recent`. */
export function normalizeFlags(flags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of flags) {
    const f = canonicalFlag(raw);
    const key = f.toLowerCase();
    if (key === '\\recent' || seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function hasFlag(flags: readonly string[], flag: string): boolean {
  const key = flag.toLowerCase();
  return flags.some((f) => f.toLowerCase() === key);
}

/** The flags after a STORE. */
export function applyFlags(current: readonly string[], op: StoreOperation, flags: readonly string[]): string[] {
  const change = normalizeFlags(flags);
  if (op === 'set') return change;
  if (op === 'add') return normalizeFlags([...current, ...change]);
  const drop = new Set(change.map((f) => f.toLowerCase()));
  return current.filter((f) => !drop.has(f.toLowerCase()));
}

export function sameFlags(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a.map((f) => f.toLowerCase()));
  return b.every((f) => set.has(f.toLowerCase()));
}

export function isKeyword(flag: string): boolean {
  return !flag.startsWith('\\');
}
