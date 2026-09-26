// Pure helpers for the IMAP import (PST-T-10.2, PST-REQ-152): where a source folder lands, the
// source's INTERNALDATE as a Date, UID sets, the pinned-fingerprint format, and astring encoding.
import { decodeMailboxName } from '@postroom/imap-proto';

/** Our hierarchy delimiter (apps/imap/src/names.ts). */
export const DELIMITER = '/';

export type ImportSpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';

/** RFC 6154 attributes we map onto our own special-use mailboxes, and their default names. */
export const SPECIAL_USE_BY_ATTRIBUTE: Readonly<Record<string, ImportSpecialUse>> = {
  '\\SENT': 'sent',
  '\\DRAFTS': 'drafts',
  '\\TRASH': 'trash',
  '\\JUNK': 'junk',
  '\\ARCHIVE': 'archive',
};

export const DEFAULT_NAME_BY_SPECIAL_USE: Readonly<Record<ImportSpecialUse, string>> = {
  inbox: 'INBOX',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  junk: 'Junk',
  archive: 'Archive',
};

/** Virtual folders that only re-list mail kept elsewhere (Gmail's All Mail, Starred): skipped unless asked for by name. */
const VIRTUAL_ATTRIBUTES = new Set(['\\ALL', '\\FLAGGED', '\\IMPORTANT']);
const UNSELECTABLE_ATTRIBUTES = new Set(['\\NOSELECT', '\\NONEXISTENT']);

export interface SourceFolder {
  /** The name exactly as the source sent it (modified UTF-7 unless it spoke UTF-8): sent back verbatim. */
  readonly wire: string;
  /** Human form. */
  readonly display: string;
  readonly delimiter: string | null;
  readonly attributes: readonly string[];
}

export interface FolderTarget {
  readonly name: string;
  readonly specialUse: ImportSpecialUse | null;
}

export function isSelectable(folder: SourceFolder): boolean {
  return !folder.attributes.some((a) => UNSELECTABLE_ATTRIBUTES.has(a.toUpperCase()));
}

export function isVirtual(folder: SourceFolder): boolean {
  return folder.attributes.some((a) => VIRTUAL_ATTRIBUTES.has(a.toUpperCase()));
}

/** The display form of a wire name: modified UTF-7 decoded when it is valid, else as sent. */
export function displayName(wire: string): string {
  return decodeMailboxName(wire) ?? wire;
}

/**
 * Where a source folder lands here: INBOX is INBOX; a special-use attribute picks our special-use
 * mailbox (its name resolved by the caller against the account, defaulting to Sent/Drafts/...);
 * anything else keeps its name, re-joined with our delimiter, with empty, `.` and `..` levels
 * dropped (our IMAP server refuses them) and our delimiter inside a level replaced.
 */
export function targetFor(folder: SourceFolder): FolderTarget {
  if (folder.display.toUpperCase() === 'INBOX') return { name: 'INBOX', specialUse: 'inbox' };
  for (const a of folder.attributes) {
    const use = SPECIAL_USE_BY_ATTRIBUTE[a.toUpperCase()];
    if (use !== undefined) return { name: DEFAULT_NAME_BY_SPECIAL_USE[use], specialUse: use };
  }
  const levels = folder.delimiter === null || folder.delimiter === '' ? [folder.display] : folder.display.split(folder.delimiter);
  const clean = levels
    .map((l) => (folder.delimiter === DELIMITER ? l : l.split(DELIMITER).join('_')).replace(/[\r\n\0]/g, ' ').trim())
    .filter((l) => l !== '' && l !== '.' && l !== '..');
  if (clean.length === 0) return { name: 'Imported', specialUse: null };
  // A child of INBOX keeps INBOX's canonical spelling.
  if (clean[0]?.toUpperCase() === 'INBOX') clean[0] = 'INBOX';
  return { name: clean.join(DELIMITER), specialUse: null };
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** RFC 9051 date-time, `"17-Jul-1996 02:44:25 -0700"` (day may be space-padded), as a Date; null if malformed. */
export function parseInternalDate(value: string): Date | null {
  const m = /^\s?(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value);
  if (m === null) return null;
  const [, d, mon, y, hh, mm, ss, sign, zh, zm] = m;
  const month = MONTHS.indexOf((mon ?? '').toUpperCase());
  if (month < 0) return null;
  const offsetMin = (sign === '-' ? -1 : 1) * (Number(zh) * 60 + Number(zm));
  const utc = Date.UTC(Number(y), month, Number(d), Number(hh), Number(mm), Number(ss)) - offsetMin * 60_000;
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Ascending, de-duplicated UIDs as a compact sequence set: `1:5,7,9:12`. */
export function uidSet(uids: readonly number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i] ?? 0;
    let end = start;
    while (sorted[i + 1] === end + 1) {
      end++;
      i++;
    }
    parts.push(start === end ? String(start) : `${String(start)}:${String(end)}`);
    i++;
  }
  return parts.join(',');
}

/**
 * A pinned SHA-256 certificate fingerprint in canonical form (64 upper-case hex digits), from
 * `AB:CD:...`, `abcd...` or with spaces; null when it is not one.
 */
export function normalizeFingerprint(value: string): string | null {
  const hex = value.replace(/[\s:]/g, '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex : null;
}

/** Node's `fingerprint256` (`AB:CD:...`) in the same canonical form. */
export function canonicalFingerprint(nodeFingerprint: string): string {
  return nodeFingerprint.replace(/:/g, '').toUpperCase();
}

/** How an astring goes on the wire: an atom, a quoted string, or (anything else) a literal. */
export type Astring = { readonly kind: 'text'; readonly value: string } | { readonly kind: 'literal'; readonly value: Buffer };

export function astring(value: string | Buffer): Astring {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  // Quotable: 7-bit, no CR/LF/NUL, and short enough that quoting is clearer than a literal.
  const quotable = buf.length > 0 && buf.length < 1000 && buf.every((b) => b >= 0x20 && b < 0x7f);
  if (!quotable) return { kind: 'literal', value: buf };
  return { kind: 'text', value: `"${buf.toString('latin1').replace(/(["\\])/g, '\\$1')}"` };
}
