// RFC 2047 encoded-words: `=?charset?B|Q?text?=`, decoding and encoding.
//
// Decoding is deliberately lenient in the ways real mail requires: encoded-words are recognised
// even when not separated from surrounding text by whitespace, whitespace between two adjacent
// encoded-words is dropped (§6.2), and adjacent words in the same charset have their *bytes* joined
// before decoding, because senders routinely split a multi-byte character across two words. A
// malformed word is left exactly as it was written.

import { decodeWith, resolveCharset } from './charset.js';

const WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
const B64_PAYLOAD = /^[A-Za-z0-9+/]*={0,2}$/;

interface Piece {
  bytes: Buffer;
  charset: string;
}

function decodeQ(text: string): Buffer | null {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 0x5f) {
      out.push(0x20);
    } else if (ch === 0x3d) {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      out.push(parseInt(hex, 16));
      i += 2;
    } else if (ch > 0x7e) {
      // Raw 8-bit inside an encoded-word: keep it as UTF-8 bytes.
      out.push(...Buffer.from(text[i] ?? '', 'utf8'));
    } else {
      out.push(ch);
    }
  }
  return Buffer.from(out);
}

function decodeB(text: string): Buffer | null {
  if (!B64_PAYLOAD.test(text) || text.replace(/=+$/, '').length % 4 === 1) return null;
  return Buffer.from(text, 'base64');
}

function decodeWord(charsetField: string, enc: string, text: string): Piece | null {
  // RFC 2231 §5: the charset may carry a language, `utf-8*en`.
  const star = charsetField.indexOf('*');
  const charset = (star >= 0 ? charsetField.slice(0, star) : charsetField).toLowerCase();
  const bytes = enc === 'b' || enc === 'B' ? decodeB(text) : decodeQ(text);
  if (bytes === null) return null;
  return { bytes, charset };
}

export interface EncodedWordResult {
  text: string;
  /** Charsets that had no decoder; their words were decoded as UTF-8 with replacement. */
  unknownCharsets: string[];
}

function decodePieces(pieces: Piece[], unknown: string[]): string {
  let out = '';
  let i = 0;
  while (i < pieces.length) {
    const first = pieces[i] as Piece;
    const group: Buffer[] = [first.bytes];
    let j = i + 1;
    while (j < pieces.length && (pieces[j] as Piece).charset === first.charset) {
      group.push((pieces[j] as Piece).bytes);
      j++;
    }
    const encoding = resolveCharset(first.charset);
    if (encoding === null && !unknown.includes(first.charset)) unknown.push(first.charset);
    out += decodeWith(encoding ?? 'utf-8', Buffer.concat(group));
    i = j;
  }
  return out;
}

/** Decode every encoded-word in an unstructured header value. */
export function decodeEncodedWordsDetailed(value: string): EncodedWordResult {
  const unknown: string[] = [];
  if (!value.includes('=?')) return { text: value, unknownCharsets: unknown };
  let out = '';
  let last = 0;
  let pending: Piece[] = [];
  WORD.lastIndex = 0;
  for (let m = WORD.exec(value); m !== null; m = WORD.exec(value)) {
    const piece = decodeWord(m[1] as string, m[2] as string, m[3] as string);
    const between = value.slice(last, m.index);
    if (piece === null) {
      // Malformed: literal. It also breaks any run of adjacent words.
      out += decodePieces(pending, unknown) + between + m[0];
      pending = [];
    } else if (pending.length > 0 && /^[ \t\r\n]*$/.test(between)) {
      pending.push(piece); // whitespace between adjacent encoded-words is not displayed
    } else {
      out += decodePieces(pending, unknown) + between;
      pending = [piece];
    }
    last = m.index + m[0].length;
  }
  out += decodePieces(pending, unknown) + value.slice(last);
  return { text: out, unknownCharsets: unknown };
}

/** Decode every encoded-word in an unstructured header value (RFC 2047). */
export function decodeEncodedWords(value: string): string {
  return decodeEncodedWordsDetailed(value).text;
}

// --- Encoding -------------------------------------------------------------------------------------

/** Longest encoded-word RFC 2047 §2 allows. */
const MAX_WORD = 75;

function qSafe(c: number): boolean {
  // RFC 2047 §5(3) — the most restrictive set, valid in every context.
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x21 || c === 0x2a || c === 0x2b || c === 0x2d || c === 0x2f;
}

function qEncode(bytes: Uint8Array): string {
  let out = '';
  for (const c of bytes) {
    if (c === 0x20) out += '_';
    else if (qSafe(c)) out += String.fromCharCode(c);
    else out += '=' + c.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/**
 * Encode `text` as a sequence of UTF-8 encoded-words, each at most 75 characters, never splitting a
 * code point. Chooses Q when most of the text is ASCII, B otherwise. Returns the words; the caller
 * joins them with folding whitespace.
 */
export function encodeWords(text: string): string[] {
  const bytes = Buffer.from(text, 'utf8');
  let unsafe = 0;
  for (const c of bytes) if (!qSafe(c) && c !== 0x20) unsafe++;
  const useB = unsafe * 3 > bytes.length;
  const prefix = useB ? '=?UTF-8?B?' : '=?UTF-8?Q?';
  const room = MAX_WORD - prefix.length - 2;
  const words: string[] = [];
  let current: Buffer[] = [];
  const encodedLength = (parts: Buffer[], extra: Buffer): number => {
    const all = Buffer.concat([...parts, extra]);
    return useB ? Math.ceil(all.length / 3) * 4 : qEncode(all).length;
  };
  for (const ch of text) {
    const cb = Buffer.from(ch, 'utf8');
    if (current.length > 0 && encodedLength(current, cb) > room) {
      const all = Buffer.concat(current);
      words.push(prefix + (useB ? all.toString('base64') : qEncode(all)) + '?=');
      current = [];
    }
    current.push(cb);
  }
  if (current.length > 0 || words.length === 0) {
    const all = Buffer.concat(current);
    words.push(prefix + (useB ? all.toString('base64') : qEncode(all)) + '?=');
  }
  return words;
}
