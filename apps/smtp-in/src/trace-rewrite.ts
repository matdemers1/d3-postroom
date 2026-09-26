// PST-T-2.12 / PST-REQ-069: an inbound message can arrive carrying its own forged
// `Authentication-Results` field claiming to be ours (RFC 8601 §5's forgery note — a spam sender
// hoping a downstream filter trusts what it did not itself verify). Before this daemon's own
// Received + Authentication-Results are prepended (data.ts), any Authentication-Results field in
// the *original* header block whose authserv-id (RFC 8601 §2.2: the first token after optional
// CFWS, ignoring an optional version number and any comment) equals our own hostname is renamed to
// `X-Original-Authentication-Results`. Only the field name changes; the value's bytes — including
// its folding — are left exactly as received, so nothing here can smuggle a header of its own.
//
// `Arc-Authentication-Results` is a distinct field name and is never touched: it is protected by
// the ARC seal itself (a break here is caught by ARC verification, not this rewrite). Ordinary
// DKIM signatures rarely cover a plain Authentication-Results field — RFC 6376 recommends against
// signing it — so a forged A-R usually is not DKIM-protected in the first place; when it is, this
// rename still runs (a DKIM signature over a field that is no longer named the way the signature
// expects is exactly the outcome the signer's advice was meant to avoid).
//
// Operates only on the header block already captured (and bounded to `MAX_HEADER_BYTES`, currently
// 1 MiB — see spool.ts) by HeaderTap; the body is streamed past this rewrite untouched.
import { stripComments } from '@postroom/mime';
import type { CapturedHeader } from './spool.js';

const CR = 0x0d;
const LF = 0x0a;
const COLON = 0x3a;
const SP = 0x20;
const TAB = 0x09;

const OUR_FIELD_KEY = 'authentication-results';
export const RENAMED_FIELD_NAME = 'X-Original-Authentication-Results';

function isContinuation(line: Buffer): boolean {
  return line.length > 0 && (line[0] === SP || line[0] === TAB);
}

/**
 * The offset of the colon that ends a field name (RFC 5322 §2.2: printable ASCII other than
 * colon, optionally followed by obsolete whitespace before the colon), or -1 when this line does
 * not start a field.
 */
function fieldColonIndex(line: Buffer): number {
  let i = 0;
  while (i < line.length) {
    const c = line[i] as number;
    if (c === COLON) break;
    if (c <= 0x20 || c > 0x7e) return -1;
    i++;
  }
  if (i === 0 || i >= line.length) return -1;
  return i;
}

interface Field {
  /** Offset of the field name's first byte. */
  readonly nameStart: number;
  /** Offset of the colon on the field's first line. */
  readonly colon: number;
  /** The value, unfolded (every line concatenated in order; a fold's CRLF removed, its leading
   * whitespace kept — RFC 5322 §2.2.3), as raw bytes. */
  readonly rawValue: Buffer;
}

/** Splits an already-bounded, CRLF-terminated header block into fields, by byte offset. */
function splitFields(block: Buffer): Field[] {
  const fields: Field[] = [];
  let pos = 0;
  let current: { nameStart: number; colon: number; valueParts: Buffer[] } | null = null;
  while (pos < block.length) {
    let lf = block.indexOf(LF, pos);
    if (lf < 0) lf = block.length;
    const lineEnd = lf > pos && block[lf - 1] === CR ? lf - 1 : lf;
    const line = block.subarray(pos, lineEnd);
    if (isContinuation(line) && current !== null) {
      current.valueParts.push(line);
    } else {
      if (current !== null) fields.push({ nameStart: current.nameStart, colon: current.colon, rawValue: Buffer.concat(current.valueParts) });
      const colon = fieldColonIndex(line);
      current = colon < 0 ? null : { nameStart: pos, colon: pos + colon, valueParts: [block.subarray(pos + colon + 1, lineEnd)] };
    }
    pos = lf + 1;
  }
  if (current !== null) fields.push({ nameStart: current.nameStart, colon: current.colon, rawValue: Buffer.concat(current.valueParts) });
  return fields;
}

function stripQuotes(token: string): string {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
}

/**
 * `authserv-id [CFWS authres-version]` (RFC 8601 §2.2): the first token of the value once
 * comments are removed, ignoring an optional trailing version number and everything from the
 * first top-level `;` on. Null when the value has no discernible authserv-id.
 */
function authservId(rawValue: Buffer): string | null {
  const text = stripComments(rawValue.toString('latin1'));
  const beforeSemi = (text.split(';', 1)[0] ?? '').trim();
  if (beforeSemi === '') return null;
  const token = (beforeSemi.split(/\s+/, 1)[0] ?? '').trim();
  return token === '' ? null : stripQuotes(token).toLowerCase();
}

/**
 * Renames every `Authentication-Results` field whose authserv-id equals `ourHostname` to
 * `X-Original-Authentication-Results`, leaving every other byte — including any legitimate
 * Authentication-Results from a different authserv-id, and Arc-Authentication-Results — identical.
 */
export function rewriteAuthenticationResults(block: Buffer, ourHostname: string): Buffer {
  const ourId = ourHostname.toLowerCase();
  const renames: { start: number; end: number }[] = [];
  for (const field of splitFields(block)) {
    const name = block.subarray(field.nameStart, field.colon).toString('latin1').trim().toLowerCase();
    if (name !== OUR_FIELD_KEY) continue;
    if (authservId(field.rawValue) !== ourId) continue;
    renames.push({ start: field.nameStart, end: field.colon });
  }
  if (renames.length === 0) return block;
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const r of renames) {
    parts.push(block.subarray(cursor, r.start));
    parts.push(Buffer.from(RENAMED_FIELD_NAME, 'latin1'));
    cursor = r.end;
  }
  parts.push(block.subarray(cursor));
  return Buffer.concat(parts);
}

/**
 * The final stored message: our trace headers, then the (rewritten) original header block, then
 * the rest of the body streamed from the spool untouched. `spoolBytes` is the spool's own plaintext
 * stream (a fresh one, since the spool can only be opened once per read).
 */
export async function* streamFinalMessage(
  trace: Buffer,
  header: CapturedHeader,
  spoolBytes: AsyncIterable<unknown>,
  ourHostname: string,
): AsyncGenerator<Buffer> {
  yield trace;
  if (header.block === null) {
    // The header exceeded the cap (already un-rewritable, and the decision engine treats this as
    // `headerTooLarge`); stream the spool exactly as received rather than guess at a boundary.
    for await (const chunk of spoolBytes) yield chunk as Buffer;
    return;
  }
  yield rewriteAuthenticationResults(header.block, ourHostname);
  if (header.headerOnly) return;
  let skip = header.block.length;
  for await (const chunk of spoolBytes) {
    const buf = chunk as Buffer;
    if (skip <= 0) {
      yield buf;
      continue;
    }
    if (buf.length <= skip) {
      skip -= buf.length;
      continue;
    }
    yield buf.subarray(skip);
    skip = 0;
  }
}
