// text-match (RFC 4791 §9.7.5, RFC 6352 §10.5.4) with the collations of RFC 4790 / RFC 5051, and
// the UTC date-time form time-range attributes use (RFC 4791 §9.9).
import { DavRequestError } from './errors.js';

export type Collation = 'i;octet' | 'i;ascii-casemap' | 'i;unicode-casemap';
export type MatchType = 'equals' | 'contains' | 'starts-with' | 'ends-with';

export const COLLATIONS: readonly Collation[] = ['i;octet', 'i;ascii-casemap', 'i;unicode-casemap'];

export interface TextMatch {
  readonly value: string;
  readonly collation: Collation;
  readonly negate: boolean;
  /** CalDAV text-match is always a substring match (`contains`). */
  readonly matchType: MatchType;
}

export function isCollation(c: string): c is Collation {
  return (COLLATIONS as readonly string[]).includes(c);
}

/** The form two strings are compared in under a collation. */
export function foldForCollation(s: string, collation: Collation): string {
  switch (collation) {
    case 'i;octet':
      return s;
    case 'i;ascii-casemap':
      return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
    case 'i;unicode-casemap':
      // RFC 5051 approximated with JavaScript's full case mapping (ß → SS → ss) and NFKD.
      return s.toUpperCase().toLowerCase().normalize('NFKD');
  }
}

/** Does `value` satisfy the text-match (negate-condition applied)? */
export function textMatches(value: string, tm: TextMatch): boolean {
  const v = foldForCollation(value, tm.collation);
  const p = foldForCollation(tm.value, tm.collation);
  let hit: boolean;
  switch (tm.matchType) {
    case 'equals':
      hit = v === p;
      break;
    case 'contains':
      hit = v.includes(p);
      break;
    case 'starts-with':
      hit = v.startsWith(p);
      break;
    case 'ends-with':
      hit = v.endsWith(p);
      break;
  }
  return tm.negate ? !hit : hit;
}

/**
 * `YYYYMMDDTHHMMSSZ` → UTC milliseconds. time-range values must be UTC (RFC 4791 §9.9); anything
 * else is refused with `condition` (the caller's CALDAV:valid-filter).
 */
export function parseUtcDateTime(value: string, condition?: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim());
  if (m === null) throw new DavRequestError(403, `time-range value "${value.slice(0, 30)}" is not a UTC date-time`, condition);
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
    throw new DavRequestError(403, `time-range value "${value.slice(0, 30)}" is not a real date-time`, condition);
  }
  return ms;
}

/** UTC milliseconds → `YYYYMMDDTHHMMSSZ`. */
export function formatUtcDateTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
