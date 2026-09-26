// RFC 5322 §2.2 header fields: raw bytes preserved, values unfolded, 8-bit bytes decoded as UTF-8
// (RFC 6532) when they are valid UTF-8 and as Latin-1 otherwise.

import { isUtf8 } from 'node:buffer';
import { decodeEncodedWords } from './encoded-word.js';

export interface HeaderField {
  /** The field name as written (case preserved, surrounding whitespace removed). */
  readonly name: string;
  /** The field name lowercased, for lookup. */
  readonly key: string;
  /** Unfolded value: line breaks removed, leading and trailing whitespace trimmed. Not RFC 2047-decoded. */
  readonly value: string;
  /** The field exactly as received, from the first byte of the name to the end of its last line (line breaks inside kept, the final one not). */
  readonly raw: Buffer;
  /** True when the value held 8-bit bytes that were not valid UTF-8 and were read as Latin-1. */
  readonly latin1: boolean;
  /** True when the field exceeded the per-field cap and was truncated. */
  readonly truncated: boolean;
}

/** An ordered, case-insensitive view over a header block. */
export class HeaderList {
  readonly fields: readonly HeaderField[];

  constructor(fields: readonly HeaderField[] = []) {
    this.fields = fields;
  }

  /** The first field's unfolded value, or null. */
  get(name: string): string | null {
    const key = name.toLowerCase();
    for (const f of this.fields) if (f.key === key) return f.value;
    return null;
  }

  /** Every value of the named field, in order. */
  getAll(name: string): string[] {
    const key = name.toLowerCase();
    return this.fields.filter((f) => f.key === key).map((f) => f.value);
  }

  /** The first value with RFC 2047 encoded-words decoded (for unstructured fields such as Subject). */
  getDecoded(name: string): string | null {
    const value = this.get(name);
    return value === null ? null : decodeEncodedWords(value);
  }

  has(name: string): boolean {
    return this.get(name) !== null;
  }

  get size(): number {
    return this.fields.length;
  }
}

const COLON = 0x3a;

/**
 * Does this raw line (without its line break) start a header field? A field name is one or more
 * printable ASCII characters other than colon; obsolete syntax (RFC 5322 §4.5) allows whitespace
 * between the name and the colon.
 */
export function isFieldStart(line: Uint8Array): boolean {
  let i = 0;
  while (i < line.length) {
    const c = line[i] as number;
    if (c === COLON) break;
    if (c < 0x21 || c > 0x7e) break;
    i++;
  }
  if (i === 0) return false;
  let j = i;
  while (j < line.length && (line[j] === 0x20 || line[j] === 0x09)) j++;
  return line[j] === COLON;
}

/** Is this line a continuation (folded) line? */
export function isContinuation(line: Uint8Array): boolean {
  return line.length > 0 && (line[0] === 0x20 || line[0] === 0x09);
}

/** Decode raw header bytes: UTF-8 when valid (RFC 6532), otherwise Latin-1. */
export function decodeHeaderBytes(bytes: Uint8Array): { text: string; latin1: boolean } {
  let ascii = true;
  for (const c of bytes) {
    if (c > 0x7f) {
      ascii = false;
      break;
    }
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (ascii || isUtf8(buf)) return { text: buf.toString('utf8'), latin1: false };
  return { text: buf.toString('latin1'), latin1: true };
}

/** Unfold (RFC 5322 §2.2.3): remove every CRLF (or bare LF / CR) — the whitespace after it stays. */
export function unfold(text: string): string {
  return text.replace(/\r?\n|\r/g, '');
}

/** Build a field from its raw bytes (name, colon, value, internal line breaks; no final line break). */
export function makeField(raw: Buffer, truncated = false): HeaderField {
  const colon = raw.indexOf(COLON);
  const nameBytes = colon < 0 ? raw : raw.subarray(0, colon);
  const valueBytes = colon < 0 ? Buffer.alloc(0) : raw.subarray(colon + 1);
  const name = nameBytes.toString('latin1').trim();
  const { text, latin1 } = decodeHeaderBytes(valueBytes);
  const value = unfold(text).replace(/^[ \t]+|[ \t]+$/g, '');
  return { name, key: name.toLowerCase(), value, raw, latin1, truncated };
}

/**
 * Parse a complete header block (everything before the blank line) into fields. Lines that are
 * neither a field nor a continuation are skipped. Used for small, already-bounded blocks; the
 * streaming parser builds fields line by line itself.
 */
export function parseHeaderBlock(block: Uint8Array): HeaderList {
  const buf = Buffer.from(block.buffer, block.byteOffset, block.length);
  const fields: HeaderField[] = [];
  let start = -1;
  let end = -1;
  let pos = 0;
  while (pos < buf.length) {
    let lf = buf.indexOf(0x0a, pos);
    if (lf < 0) lf = buf.length;
    const lineEnd = lf > pos && buf[lf - 1] === 0x0d ? lf - 1 : lf;
    const line = buf.subarray(pos, lineEnd);
    if (line.length === 0) break;
    if (isContinuation(line) && start >= 0) {
      end = lineEnd;
    } else if (isFieldStart(line)) {
      if (start >= 0) fields.push(makeField(Buffer.from(buf.subarray(start, end))));
      start = pos;
      end = lineEnd;
    }
    pos = lf + 1;
  }
  if (start >= 0) fields.push(makeField(Buffer.from(buf.subarray(start, end))));
  return new HeaderList(fields);
}
