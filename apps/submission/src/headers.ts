// The submitted message's header block: who it claims to be from, and the fix-ups a submission
// server makes before the message leaves (RFC 6409 §8): add Message-ID and Date when missing, and
// strip Bcc so blind recipients stay blind.
//
// Only the header block is ever held in memory (bounded by the caller); the body streams past.
// This is deliberately not a MIME parser: it needs field names, the From address list, and a few
// values, and nothing else.
import { randomUUID } from 'node:crypto';
import { parseHeaderFields, type HeaderField } from '@postroom/auth-checks';

const CRLF = Buffer.from('\r\n', 'latin1');

/** A field's value: after the first colon, unfolded, decoded as UTF-8, trimmed. */
export function fieldValue(field: HeaderField): string {
  const text = field.raw.toString('utf8');
  const colon = text.indexOf(':');
  if (colon === -1) return '';
  return text
    .slice(colon + 1)
    .replace(/\r\n(?=[ \t])/g, '')
    .trim();
}

/**
 * The addr-specs in an RFC 5322 address list (`From:`, `To:` …): angle-addrs, bare addr-specs and
 * group members, with display names, quoted strings and comments skipped. Returns null when the
 * list is malformed (unbalanced quotes, comments or brackets) or an entry is not `local@domain`.
 */
export function parseAddressList(value: string): string[] | null {
  const out: string[] = [];
  let bare = '';
  let angle: string | null = null;
  let inAngle = false;
  const state = { bad: false };

  const flush = (): void => {
    const candidate = (angle ?? bare).trim();
    angle = null;
    bare = '';
    if (candidate === '') return; // an empty group, or a trailing comma
    // Obsolete source route inside an angle-addr: <@a,@b:user@c>.
    const spec = candidate.startsWith('@') ? candidate.slice(candidate.lastIndexOf(':') + 1) : candidate;
    const at = spec.lastIndexOf('@');
    if (at <= 0 || at === spec.length - 1 || /\s/.test(spec)) {
      state.bad = true;
      return;
    }
    out.push(spec);
  };

  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c === '"') {
      // quoted-string: a display name, or a quoted local part.
      let j = i + 1;
      let q = '"';
      for (; j < value.length; j++) {
        const d = value.charAt(j);
        if (d === '\\') {
          q += value.slice(j, j + 2);
          j++;
          continue;
        }
        q += d;
        if (d === '"') break;
      }
      if (j >= value.length) return null;
      if (inAngle) angle = (angle ?? '') + q;
      else bare += q;
      i = j;
      continue;
    }
    if (c === '(') {
      let depth = 1;
      let j = i + 1;
      for (; j < value.length && depth > 0; j++) {
        const d = value.charAt(j);
        if (d === '\\') j++;
        else if (d === '(') depth++;
        else if (d === ')') depth--;
      }
      if (depth > 0) return null;
      i = j - 1;
      continue;
    }
    if (inAngle) {
      if (c === '>') inAngle = false;
      else if (c === '<') return null;
      else angle = (angle ?? '') + c;
      continue;
    }
    if (c === '<') {
      if (angle !== null) return null; // two angle-addrs in one mailbox
      inAngle = true;
      angle = '';
      bare = '';
    } else if (c === '>') {
      return null;
    } else if (c === ',' || c === ';') {
      flush();
    } else if (c === ':') {
      bare = ''; // a group's display name ends here
    } else if (angle === null) {
      bare += c;
    }
  }
  if (inAngle) return null;
  flush();
  return state.bad ? null : out;
}

/** RFC 5322 §3.3 date-time in UTC: `Fri, 25 Sep 2026 12:00:00 +0000`. */
export function formatRfc5322Date(date: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${days[date.getUTCDay()] ?? ''}, ${String(date.getUTCDate())} ${months[date.getUTCMonth()] ?? ''} ` +
    `${String(date.getUTCFullYear())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

export type HeaderInspection =
  | {
      readonly ok: true;
      readonly fields: readonly HeaderField[];
      /** Every mailbox in the (single) From field. */
      readonly from: readonly string[];
      readonly messageId: string | undefined;
      readonly subject: string | undefined;
    }
  | { readonly ok: false; readonly reason: 'no-from' | 'multiple-from' | 'bad-from' };

/** Read what submission needs from a header block (as `splitMessage` returns it). */
export function inspectHeaders(headerBlock: Buffer): HeaderInspection {
  const fields = parseHeaderFields(headerBlock);
  const froms = fields.filter((f) => f.key === 'from');
  if (froms.length === 0) return { ok: false, reason: 'no-from' };
  if (froms.length > 1) return { ok: false, reason: 'multiple-from' };
  const from = parseAddressList(fieldValue(froms[0] as HeaderField));
  if (from === null || from.length === 0) return { ok: false, reason: 'bad-from' };
  const first = (key: string): string | undefined => {
    const f = fields.find((x) => x.key === key);
    return f === undefined ? undefined : fieldValue(f);
  };
  return { ok: true, fields, from, messageId: first('message-id'), subject: first('subject') };
}

export interface RewriteOptions {
  /** Domain for a generated Message-ID (the sender's). */
  readonly domain: string;
  readonly now: Date;
}

export interface RewrittenHeaders {
  /** The new header block, every field CRLF-terminated, without the blank separator line. */
  readonly block: Buffer;
  readonly messageId: string;
  readonly addedMessageId: boolean;
  readonly addedDate: boolean;
  readonly strippedBcc: number;
}

/** Drop Bcc/Resent-Bcc; append Message-ID and Date when absent. Other fields keep their bytes. */
export function rewriteHeaders(fields: readonly HeaderField[], options: RewriteOptions): RewrittenHeaders {
  // An empty Message-ID is dropped and replaced rather than left beside the new one.
  const kept = fields.filter(
    (f) => f.key !== 'bcc' && f.key !== 'resent-bcc' && !(f.key === 'message-id' && fieldValue(f) === ''),
  );
  const parts: Buffer[] = [];
  for (const f of kept) parts.push(f.raw, CRLF);
  const existingId = kept.find((f) => f.key === 'message-id');
  let messageId = existingId === undefined ? '' : fieldValue(existingId);
  const addedMessageId = messageId === '';
  if (addedMessageId) {
    messageId = `<${randomUUID()}@${options.domain}>`;
    parts.push(Buffer.from(`Message-ID: ${messageId}\r\n`, 'latin1'));
  }
  const addedDate = !kept.some((f) => f.key === 'date');
  if (addedDate) parts.push(Buffer.from(`Date: ${formatRfc5322Date(options.now)}\r\n`, 'latin1'));
  return {
    block: Buffer.concat(parts),
    messageId,
    addedMessageId,
    addedDate,
    strippedBcc: fields.filter((f) => f.key === 'bcc' || f.key === 'resent-bcc').length,
  };
}
