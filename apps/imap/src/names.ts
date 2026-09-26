// Mailbox names on the IMAP side (PST-REQ-070): the hierarchy delimiter, INBOX's case rule, LIST
// patterns and the special-use attributes (RFC 6154).
//
// Names are stored as UTF-8 in the database. The wire form — modified UTF-7 under IMAP4rev1, UTF-8
// once IMAP4rev2 or UTF8=ACCEPT is enabled — is the parser's and the writer's business, never ours.
import type { SpecialUse } from '@postroom/db';

export const DELIMITER = '/';

/** Octets of UTF-8 a stored name may use; long enough for any real hierarchy. */
export const MAX_NAME_BYTES = 512;

/** INBOX is case-insensitive, and so is the first level of its children ("inbox/x" is "INBOX/x"). */
export function canonicalName(name: string): string {
  if (name.length >= 5 && name.slice(0, 5).toUpperCase() === 'INBOX' && (name.length === 5 || name[5] === DELIMITER)) {
    return `INBOX${name.slice(5)}`;
  }
  return name;
}

/**
 * Why `name` cannot be created (or renamed to), or null when it can. A trailing delimiter is
 * allowed on CREATE (RFC 3501: it declares the intent to create children) and is stripped by
 * `stripTrailingDelimiter` before this check.
 */
export function invalidNameReason(name: string): string | null {
  if (name.length === 0) return 'Mailbox name is empty';
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) return 'Mailbox name is too long';
  if (name.startsWith(DELIMITER)) return 'Mailbox name may not start with the hierarchy delimiter';
  if (name.endsWith(DELIMITER)) return 'Mailbox name may not end with the hierarchy delimiter';
  if (name.includes(`${DELIMITER}${DELIMITER}`)) return 'Mailbox name has an empty level';
  if (/[*%]/.test(name)) return 'Mailbox name may not contain * or %';
  if (name.split(DELIMITER).some((level) => level === '.' || level === '..')) return 'Mailbox name may not have a level named . or ..';
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Mailbox name may not contain control characters';
  return null;
}

export function stripTrailingDelimiter(name: string): string {
  let n = name;
  while (n.length > 1 && n.endsWith(DELIMITER)) n = n.slice(0, -1);
  return n;
}

/** "a/b/c" → ["a", "a/b"]. */
export function parentsOf(name: string): string[] {
  const out: string[] = [];
  let at = name.indexOf(DELIMITER);
  while (at > 0) {
    out.push(name.slice(0, at));
    at = name.indexOf(DELIMITER, at + 1);
  }
  return out;
}

/** True when `name` is `parent` or below it. */
export function isSelfOrChild(name: string, parent: string): boolean {
  return name === parent || name.startsWith(`${parent}${DELIMITER}`);
}

/**
 * RFC 3501 §6.3.8: the reference and the pattern are joined, `*` matches anything and `%` anything
 * but the delimiter. INBOX matches case-insensitively.
 */
export function listPattern(reference: string, pattern: string): RegExp {
  let full = reference.length === 0 ? pattern : reference.endsWith(DELIMITER) && pattern.startsWith(DELIMITER) ? reference + pattern.slice(1) : reference + pattern;
  full = canonicalListPattern(full);
  let re = '^';
  for (const ch of full) {
    if (ch === '*') re += '.*';
    else if (ch === '%') re += `[^${escapeRegex(DELIMITER)}]*`;
    else re += escapeRegex(ch);
  }
  return new RegExp(`${re}$`, 'su');
}

/** A pattern starting with any case of "INBOX" (then the end, the delimiter or a wildcard) matches INBOX. */
function canonicalListPattern(pattern: string): string {
  if (pattern.length >= 5 && pattern.slice(0, 5).toUpperCase() === 'INBOX') {
    const next = pattern[5];
    if (next === undefined || next === DELIMITER || next === '*' || next === '%') return `INBOX${pattern.slice(5)}`;
  }
  return pattern;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** RFC 6154 attribute for a special use. INBOX and Rejects have none. */
export function specialUseAttribute(use: SpecialUse | null): string | null {
  switch (use) {
    case 'sent':
      return '\\Sent';
    case 'drafts':
      return '\\Drafts';
    case 'trash':
      return '\\Trash';
    case 'junk':
      return '\\Junk';
    case 'archive':
      return '\\Archive';
    default:
      return null;
  }
}

/** The special use a CREATE (USE (...)) attribute asks for, or undefined when we do not support it. */
export function specialUseFromAttribute(attr: string): SpecialUse | undefined {
  switch (attr.toLowerCase()) {
    case '\\sent':
      return 'sent';
    case '\\drafts':
      return 'drafts';
    case '\\trash':
      return 'trash';
    case '\\junk':
      return 'junk';
    case '\\archive':
      return 'archive';
    default:
      return undefined;
  }
}
