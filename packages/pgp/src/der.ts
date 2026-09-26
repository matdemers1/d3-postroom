// A DER/BER TLV reader (ITU-T X.690) for CMS and certificates, plus a DER writer used by the
// round-trip property and the fuzz target. BER's indefinite length is accepted on constructed
// values because real S/MIME (Outlook, streaming OpenSSL) sends it; everything else is strict:
// a length past the input, an indefinite length on a primitive, a tag number too large, or nesting
// past the depth cap is a DerError — the only error this module throws.

import { DerError } from './errors.js';

export const TagClass = { Universal: 0, Application: 1, Context: 2, Private: 3 } as const;

export const UTag = {
  Boolean: 1,
  Integer: 2,
  BitString: 3,
  OctetString: 4,
  Null: 5,
  Oid: 6,
  Utf8String: 12,
  Sequence: 16,
  Set: 17,
  PrintableString: 19,
  UtcTime: 23,
  GeneralizedTime: 24,
} as const;

export interface Tlv {
  tagClass: number;
  constructed: boolean;
  tag: number;
  /** Offset of the identifier octet in the buffer read from. */
  offset: number;
  headerLength: number;
  indefinite: boolean;
  /** The contents octets (for an indefinite length: up to, not including, the end-of-contents). */
  content: Buffer;
  /** The whole encoding: identifier, length, contents (and end-of-contents). */
  raw: Buffer;
}

export const MAX_DEPTH = 48;
const MAX_TAG = 0x1fffff;

export function readTlv(buf: Buffer, offset = 0, depth = 0): Tlv {
  if (depth > MAX_DEPTH) throw new DerError('nesting too deep');
  let p = offset;
  const at = (i: number): number => {
    if (i >= buf.length) throw new DerError('truncated');
    return buf[i] ?? 0;
  };
  const id = at(p++);
  const tagClass = id >> 6;
  const constructed = (id & 0x20) !== 0;
  let tag = id & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    let n = 0;
    for (;;) {
      const b = at(p++);
      if (n === 0 && b === 0x80) throw new DerError('non-minimal tag number');
      tag = tag * 128 + (b & 0x7f);
      if (tag > MAX_TAG) throw new DerError('tag number too large');
      n++;
      if ((b & 0x80) === 0) break;
    }
    if (tag < 0x1f) throw new DerError('non-minimal tag number');
  }
  const l0 = at(p++);
  let length = -1;
  if (l0 < 0x80) length = l0;
  else if (l0 === 0x80) {
    if (!constructed) throw new DerError('indefinite length on a primitive');
  } else {
    const n = l0 & 0x7f;
    if (n > 4 || l0 === 0xff) throw new DerError('length too long');
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + at(p++);
  }
  const headerLength = p - offset;
  if (length >= 0) {
    if (p + length > buf.length) throw new DerError('length past end of input');
    return { tagClass, constructed, tag, offset, headerLength, indefinite: false, content: buf.subarray(p, p + length), raw: buf.subarray(offset, p + length) };
  }
  // Indefinite: children until the end-of-contents octets 00 00.
  let q = p;
  for (;;) {
    if (at(q) === 0 && at(q + 1) === 0) break;
    const child = readTlv(buf, q, depth + 1);
    q += child.raw.length;
  }
  return { tagClass, constructed, tag, offset, headerLength, indefinite: true, content: buf.subarray(p, q), raw: buf.subarray(offset, q + 2) };
}

/** Every TLV in `buf`, back to back, covering it exactly. */
export function readAll(buf: Buffer, depth = 0, max = 100_000): Tlv[] {
  const out: Tlv[] = [];
  let p = 0;
  while (p < buf.length) {
    if (out.length >= max) throw new DerError('too many elements');
    const t = readTlv(buf, p, depth);
    out.push(t);
    p += t.raw.length;
  }
  return out;
}

export function children(t: Tlv, depth = 0): Tlv[] {
  if (!t.constructed) throw new DerError('not a constructed value');
  return readAll(t.content, depth + 1);
}

export function isUniversal(t: Tlv, tag: number): boolean {
  return t.tagClass === 0 && t.tag === tag;
}

export function isContext(t: Tlv, tag: number): boolean {
  return t.tagClass === 2 && t.tag === tag;
}

/** Expect a universal tag, or throw. */
export function expect(t: Tlv | undefined, tag: number, what: string): Tlv {
  if (t === undefined) throw new DerError(`missing ${what}`);
  if (!isUniversal(t, tag)) throw new DerError(`${what}: expected universal tag ${String(tag)}, got class ${String(t.tagClass)} tag ${String(t.tag)}`);
  return t;
}

/** An OCTET STRING's bytes, joining BER constructed segments. */
export function octets(t: Tlv, depth = 0): Buffer {
  if (!t.constructed) return t.content;
  return Buffer.concat(children(t, depth).map((c) => octets(c, depth + 1)));
}

export function decodeOid(content: Buffer): string {
  if (content.length === 0) throw new DerError('empty OID');
  const arcs: number[] = [];
  let v = 0;
  let started = false;
  for (const b of content) {
    if (!started && b === 0x80) throw new DerError('non-minimal OID arc');
    started = (b & 0x80) !== 0;
    v = v * 128 + (b & 0x7f);
    if (v > Number.MAX_SAFE_INTEGER / 256) throw new DerError('OID arc too large');
    if ((b & 0x80) === 0) {
      arcs.push(v);
      v = 0;
    }
  }
  if (started) throw new DerError('truncated OID');
  const first = arcs[0] ?? 0;
  const head = first < 40 ? [0, first] : first < 80 ? [1, first - 40] : [2, first - 80];
  return [...head, ...arcs.slice(1)].join('.');
}

export function encodeOid(oid: string): Buffer {
  const arcs = oid.split('.').map((s) => Number(s));
  if (arcs.length < 2 || arcs.some((a) => !Number.isSafeInteger(a) || a < 0)) throw new DerError('bad OID');
  const [a0 = 0, a1 = 0, ...rest] = arcs;
  const out: number[] = [];
  for (const arc of [a0 * 40 + a1, ...rest]) {
    const bytes: number[] = [];
    let v = arc;
    do {
      bytes.unshift(v % 128);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < bytes.length - 1; i++) bytes[i] = (bytes[i] ?? 0) | 0x80;
    out.push(...bytes);
  }
  return Buffer.from(out);
}

export function oidOf(t: Tlv | undefined, what = 'OID'): string {
  return decodeOid(expect(t, UTag.Oid, what).content);
}

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.of(n);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** DER: definite length, minimal tag and length encodings. */
export function encodeTlv(tagClass: number, constructed: boolean, tag: number, content: Uint8Array): Buffer {
  let id: Buffer;
  const lead = ((tagClass & 3) << 6) | (constructed ? 0x20 : 0);
  if (tag < 0x1f) id = Buffer.of(lead | tag);
  else {
    const bytes: number[] = [];
    let v = tag;
    do {
      bytes.unshift(v % 128);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < bytes.length - 1; i++) bytes[i] = (bytes[i] ?? 0) | 0x80;
    id = Buffer.from([lead | 0x1f, ...bytes]);
  }
  return Buffer.concat([id, encodeLength(content.length), content]);
}

export const seq = (...items: Uint8Array[]): Buffer => encodeTlv(0, true, UTag.Sequence, Buffer.concat(items));
