// Charset handling. Node 22 ships full ICU, so the WHATWG `TextDecoder` already understands every
// charset real mail uses (windows-1252, iso-8859-x, shift_jis, euc-kr, gb18030, big5, koi8-r,
// iso-2022-jp, utf-16…) under their WHATWG labels. This module only normalises the names mail
// software writes that are not WHATWG labels, and falls back to UTF-8 (with replacement characters
// and a warning) for anything unknown — never throwing, because an unknown charset is not a reason
// to lose a message.

import { TextDecoder } from 'node:util';

/** Aliases seen in real mail that are not WHATWG encoding labels. */
const ALIASES: Readonly<Record<string, string>> = {
  'cp932': 'shift_jis',
  'ms932': 'shift_jis',
  'sjis': 'shift_jis',
  'cp936': 'gbk',
  'ms936': 'gbk',
  'cp949': 'euc-kr',
  'ms949': 'euc-kr',
  'ks_c_5601': 'euc-kr',
  'cp950': 'big5',
  'ms950': 'big5',
  'big5-hkscs': 'big5',
  'ascii': 'us-ascii',
  '646': 'us-ascii',
  'ansi': 'windows-1252',
  'utf8mb4': 'utf-8',
  'unicode': 'utf-16le',
  'ucs-2': 'utf-16le',
};

const resolved = new Map<string, string | null>();

function tryLabel(label: string): string | null {
  try {
    return new TextDecoder(label).encoding;
  } catch (err) {
    if (err instanceof RangeError) return null; // an unsupported label: the documented failure
    throw err;
  }
}

/**
 * Resolve a charset name from a header or parameter to a `TextDecoder` encoding name, or `null` if
 * no decoder exists for it. Quotes, whitespace, case, and the common `x-`/`cp125x`/underscore
 * variants are normalised.
 */
export function resolveCharset(name: string): string | null {
  const key = name.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
  if (key === '') return null;
  const cached = resolved.get(key);
  if (cached !== undefined) return cached;
  const candidates = [key];
  const alias = ALIASES[key];
  if (alias !== undefined) candidates.push(alias);
  const cp = /^(?:cp|ms|windows_?)-?(125\d)$/.exec(key);
  if (cp?.[1] !== undefined) candidates.push(`windows-${cp[1]}`);
  if (key.startsWith('x-')) candidates.push(key.slice(2));
  if (key.includes('_')) candidates.push(key.replace(/_/g, '-'));
  const iso = /^iso-?8859[-_]?(\d+)$/.exec(key);
  if (iso?.[1] !== undefined) candidates.push(`iso-8859-${iso[1]}`);
  let found: string | null = null;
  for (const candidate of candidates) {
    found = tryLabel(candidate);
    if (found !== null) break;
  }
  if (resolved.size < 256) resolved.set(key, found);
  return found;
}

/**
 * Decode a whole buffer. Always through `{ stream: true }` and a final flush: Node 22.13's
 * non-streaming `TextDecoder('windows-1252').decode()` takes a Latin-1 fast path and turns
 * 0x80–0x9F (curly quotes, the euro sign) into C1 controls; the streaming path is correct.
 */
export function decodeWith(encoding: string, bytes: Uint8Array): string {
  const decoder = new TextDecoder(encoding);
  return decoder.decode(bytes, { stream: true }) + decoder.decode();
}

export interface DecodedText {
  text: string;
  /** The encoding actually used. */
  encoding: string;
  /** Set when the charset was unknown and UTF-8 was used instead. */
  unknownCharset: string | null;
}

/** Decode a complete byte sequence in `charset` (default UTF-8), never throwing. */
export function decodeBytes(bytes: Uint8Array, charset: string | null): DecodedText {
  const encoding = charset === null ? 'utf-8' : resolveCharset(charset);
  if (encoding === null) {
    return { text: decodeWith('utf-8', bytes), encoding: 'utf-8', unknownCharset: charset };
  }
  return { text: decodeWith(encoding, bytes), encoding, unknownCharset: null };
}

/**
 * A streaming text decoder for one text part: feed transfer-decoded bytes, receive UTF-16 strings.
 * Multi-byte sequences split across chunks are carried by the underlying `TextDecoder`
 * (`{ stream: true }`), so the carry is a handful of bytes.
 */
export class TextPartDecoder {
  readonly encoding: string;
  readonly unknownCharset: string | null;
  private readonly decoder: TextDecoder;

  constructor(charset: string | null) {
    const encoding = charset === null ? 'utf-8' : resolveCharset(charset);
    this.encoding = encoding ?? 'utf-8';
    this.unknownCharset = encoding === null ? charset : null;
    this.decoder = new TextDecoder(this.encoding);
  }

  write(chunk: Uint8Array): string {
    return this.decoder.decode(chunk, { stream: true });
  }

  end(): string {
    return this.decoder.decode();
  }
}
