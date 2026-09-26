// ASCII armor (RFC 9580 §6), radix-64 (RFC 4648 §4) and CRC-24, and the Cleartext Signature
// Framework (RFC 9580 §7). Written here rather than borrowed from Buffer's base64 so the decoder is
// strict about what it accepts: an armored block with a character outside the alphabet, bad
// padding, or a checksum that does not match is a named ArmorError, not a silently shorter key.

import { ArmorError } from './errors.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DECODE = new Int16Array(256).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

/** RFC 4648 base64 with padding. */
export function radix64Encode(data: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= data.length; i += 3) {
    const n = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    out += ALPHABET.charAt(n >>> 18) + ALPHABET.charAt((n >>> 12) & 63) + ALPHABET.charAt((n >>> 6) & 63) + ALPHABET.charAt(n & 63);
  }
  const left = data.length - i;
  if (left === 1) {
    const n = (data[i] ?? 0) << 16;
    out += `${ALPHABET.charAt(n >>> 18)}${ALPHABET.charAt((n >>> 12) & 63)}==`;
  } else if (left === 2) {
    const n = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8);
    out += `${ALPHABET.charAt(n >>> 18)}${ALPHABET.charAt((n >>> 12) & 63)}${ALPHABET.charAt((n >>> 6) & 63)}=`;
  }
  return out;
}

/** Strict RFC 4648 base64: whitespace between quanta is ignored, anything else outside the alphabet is refused. */
export function radix64Decode(text: string): Buffer {
  const vals: number[] = [];
  let pad = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) continue;
    if (c === 0x3d) {
      pad++;
      continue;
    }
    if (pad > 0) throw new ArmorError('radix64-data-after-padding');
    const v = c < 256 ? (DECODE[c] ?? -1) : -1;
    if (v < 0) throw new ArmorError('radix64-invalid-character', `invalid radix-64 character at ${String(i)}`);
    vals.push(v);
  }
  if (pad > 2) throw new ArmorError('radix64-bad-padding');
  const rem = vals.length % 4;
  if (rem === 1) throw new ArmorError('radix64-bad-length');
  if (pad > 0 && (rem + pad) % 4 !== 0) throw new ArmorError('radix64-bad-padding');
  const out = Buffer.alloc(Math.floor((vals.length * 6) / 8));
  let o = 0;
  let i = 0;
  for (; i + 4 <= vals.length; i += 4) {
    const n = ((vals[i] ?? 0) << 18) | ((vals[i + 1] ?? 0) << 12) | ((vals[i + 2] ?? 0) << 6) | (vals[i + 3] ?? 0);
    out[o++] = n >>> 16;
    out[o++] = (n >>> 8) & 255;
    out[o++] = n & 255;
  }
  if (rem === 2) {
    const n = ((vals[i] ?? 0) << 18) | ((vals[i + 1] ?? 0) << 12);
    if ((n & 0xffff) !== 0) throw new ArmorError('radix64-nonzero-trailing-bits');
    out[o] = n >>> 16;
  } else if (rem === 3) {
    const n = ((vals[i] ?? 0) << 18) | ((vals[i + 1] ?? 0) << 12) | ((vals[i + 2] ?? 0) << 6);
    if ((n & 0xff) !== 0) throw new ArmorError('radix64-nonzero-trailing-bits');
    out[o] = n >>> 16;
    out[o + 1] = (n >>> 8) & 255;
  }
  return out;
}

const CRC24_INIT = 0xb704ce;
const CRC24_POLY = 0x1864cfb;

/** RFC 9580 §6.1.1. */
export function crc24(data: Uint8Array): number {
  let crc = CRC24_INIT;
  for (const b of data) {
    crc ^= b << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= CRC24_POLY;
    }
  }
  return crc & 0xffffff;
}

export type ArmorType = 'PGP MESSAGE' | 'PGP PUBLIC KEY BLOCK' | 'PGP PRIVATE KEY BLOCK' | 'PGP SIGNATURE' | (string & {});

export interface Armored {
  type: ArmorType;
  headers: [string, string][];
  data: Buffer;
  /** true: a checksum was present and matched. null: none was present (RFC 9580 makes it optional). */
  checksum: true | null;
}

export function encodeArmor(type: ArmorType, data: Uint8Array, headers: readonly [string, string][] = []): string {
  const lines = [`-----BEGIN ${type}-----`];
  for (const [k, v] of headers) lines.push(`${k}: ${v}`);
  lines.push('');
  const body = radix64Encode(data);
  for (let i = 0; i < body.length; i += 64) lines.push(body.slice(i, i + 64));
  const crc = crc24(data);
  lines.push(`=${radix64Encode(Uint8Array.of(crc >>> 16, (crc >>> 8) & 255, crc & 255))}`);
  lines.push(`-----END ${type}-----`);
  return `${lines.join('\n')}\n`;
}

const BEGIN = /^-----BEGIN ([A-Z0-9 ,/]+)-----[ \t]*$/;
const END = /^-----END ([A-Z0-9 ,/]+)-----[ \t]*$/;
const HEADER = /^([!-9;-~]+): (.*)$/;

function splitLines(text: string): string[] {
  return text.split(/\r?\n|\r/);
}

/** Decode every armored block in `text`, in order. Throws ArmorError on the first malformed one. */
export function decodeArmors(text: string, maxBlocks = 64): Armored[] {
  const lines = splitLines(text);
  const out: Armored[] = [];
  let i = 0;
  while (i < lines.length) {
    const begin = BEGIN.exec(lines[i] ?? '');
    if (begin === null) {
      i++;
      continue;
    }
    if (out.length >= maxBlocks) throw new ArmorError('armor-too-many-blocks');
    const type = begin[1] ?? '';
    // A cleartext-signed header opens a cleartext block, not a radix-64 one: skip it.
    if (type === 'PGP SIGNED MESSAGE') {
      i++;
      continue;
    }
    i++;
    const headers: [string, string][] = [];
    for (; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.trim() === '') {
        i++;
        break;
      }
      const h = HEADER.exec(line);
      if (h === null) {
        // RFC 9580 §6.2: a missing blank line is tolerated when the line is clearly body.
        break;
      }
      headers.push([h[1] ?? '', h[2] ?? '']);
    }
    let body = '';
    let crcText: string | null = null;
    let ended = false;
    for (; i < lines.length; i++) {
      const line = (lines[i] ?? '').trim();
      const end = END.exec(line);
      if (end !== null) {
        if (end[1] !== type) throw new ArmorError('armor-mismatched-end', `BEGIN ${type} closed by END ${end[1] ?? ''}`);
        ended = true;
        i++;
        break;
      }
      if (crcText !== null) {
        if (line === '') continue;
        throw new ArmorError('armor-data-after-checksum');
      }
      if (line.startsWith('=') && line.length === 5) {
        crcText = line.slice(1);
        continue;
      }
      body += line;
    }
    if (!ended) throw new ArmorError('armor-unterminated', `no END ${type} line`);
    const data = radix64Decode(body);
    let checksum: true | null = null;
    if (crcText !== null) {
      const c = radix64Decode(crcText);
      if (c.length !== 3) throw new ArmorError('armor-bad-checksum-length');
      const want = ((c[0] ?? 0) << 16) | ((c[1] ?? 0) << 8) | (c[2] ?? 0);
      if (want !== crc24(data)) throw new ArmorError('armor-checksum-mismatch');
      checksum = true;
    }
    out.push({ type, headers, data, checksum });
  }
  return out;
}

/** The first armored block in `text`, or null when there is none. */
export function decodeArmor(text: string): Armored | null {
  return decodeArmors(text, 1)[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Cleartext Signature Framework (RFC 9580 §7)

export interface Cleartext {
  /** The Hash: armor header values, if any (informational; the signature packet names its hash). */
  hashes: string[];
  /** The canonical signed text: dash-escapes removed, trailing whitespace stripped from every line, lines joined by CRLF, no final line ending. */
  signedText: Buffer;
  /** The PGP SIGNATURE block that follows, decoded. */
  signature: Armored;
}

/** Finds the first cleartext-signed block in `text` (a latin1 "binary" string, so bytes survive). Null when there is none. */
export function parseCleartext(text: string): Cleartext | null {
  const lines = splitLines(text);
  let i = lines.findIndex((l) => /^-----BEGIN PGP SIGNED MESSAGE-----[ \t]*$/.test(l));
  if (i < 0) return null;
  i++;
  const hashes: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      break;
    }
    const h = HEADER.exec(line);
    if (h === null) throw new ArmorError('cleartext-bad-header');
    if (h[1] === 'Hash') for (const v of (h[2] ?? '').split(',')) hashes.push(v.trim());
  }
  const body: string[] = [];
  let sigStart = -1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^-----BEGIN PGP SIGNATURE-----[ \t]*$/.test(line)) {
      sigStart = i;
      break;
    }
    body.push(line.startsWith('- ') ? line.slice(2) : line);
  }
  if (sigStart < 0) throw new ArmorError('cleartext-no-signature');
  const signature = decodeArmor(lines.slice(sigStart).join('\n'));
  if (signature?.type !== 'PGP SIGNATURE') throw new ArmorError('cleartext-no-signature');
  const signedText = Buffer.from(body.map((l) => l.replace(/[ \t]+$/, '')).join('\r\n'), 'latin1');
  return { hashes, signedText, signature };
}
