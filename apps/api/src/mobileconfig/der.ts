// A minimal ASN.1 DER writer and reader (PST-T-8.6): just enough SEQUENCE, SET, OID, INTEGER,
// OCTET STRING, UTCTime and context tags to build a CMS SignedData structure by hand. No
// node-forge, no asn1.js — the point of this project is to understand every part.

const CONTEXT = 0x80;
const CONSTRUCTED = 0x20;

export const TAG = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  UTC_TIME: 0x17,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

function lengthBytes(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One DER TLV: `tag` (already including class/constructed bits), then length, then `content`. */
export function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

export function der(tag: number, ...parts: Buffer[]): Buffer {
  return tlv(tag, Buffer.concat(parts));
}

export function sequence(...parts: Buffer[]): Buffer {
  return der(TAG.SEQUENCE, ...parts);
}

/** DER requires a SET's members sorted by their encoded bytes; a single caller-supplied member
 *  (the common case here) sorts trivially. */
export function set(members: Buffer[]): Buffer {
  const sorted = [...members].sort((a, b) => Buffer.compare(a, b));
  return der(TAG.SET, ...sorted);
}

export function octetString(content: Buffer): Buffer {
  return der(TAG.OCTET_STRING, content);
}

export function nullValue(): Buffer {
  return Buffer.from([TAG.NULL, 0x00]);
}

export function integer(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) throw new Error('integer() supports only small non-negative values');
  let n = value;
  const bytes: number[] = [];
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  // A high bit on the leading byte would read as negative; pad with a zero byte.
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0);
  return der(TAG.INTEGER, Buffer.from(bytes));
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) throw new Error(`invalid OID: ${dotted}`);
  const [first, second, ...rest] = parts as [number, number, ...number[]];
  const bytes: number[] = [first * 40 + second];
  for (const value of rest) {
    if (value === 0) {
      bytes.push(0);
      continue;
    }
    const chunk: number[] = [];
    let n = value;
    while (n > 0) {
      chunk.unshift(n & 0x7f);
      n = Math.floor(n / 128);
    }
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] = (chunk[i] ?? 0) | 0x80;
    bytes.push(...chunk);
  }
  return der(TAG.OID, Buffer.from(bytes));
}

/** `YYMMDDHHMMSSZ` in UTC — valid for any year in 2000–2049, which covers this server's lifetime. */
export function utcTime(at: Date): Buffer {
  const yy = String(at.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(at.getUTCDate()).padStart(2, '0');
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mi = String(at.getUTCMinutes()).padStart(2, '0');
  const ss = String(at.getUTCSeconds()).padStart(2, '0');
  return der(TAG.UTC_TIME, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

/** `[n] EXPLICIT`: a constructed context tag wrapping one complete inner TLV. */
export function explicitTag(n: number, inner: Buffer): Buffer {
  return der(CONTEXT | CONSTRUCTED | n, inner);
}

/** `[n] IMPLICIT`, constructed form: the inner TLV's own tag byte is replaced, content unchanged. */
export function implicitConstructedTag(n: number, inner: Buffer): Buffer {
  const retagged = Buffer.from(inner);
  retagged[0] = CONTEXT | CONSTRUCTED | n;
  return retagged;
}

// --- reading, just enough to pull IssuerAndSerialNumber fields out of a DER certificate ---

export interface Tlv {
  readonly tag: number;
  readonly content: Buffer;
  /** The full encoding: tag + length + content, exactly as it appeared in the input. */
  readonly raw: Buffer;
  /** Offset just past this TLV in the buffer it was read from. */
  readonly end: number;
}

export function readTlv(buf: Buffer, offset: number): Tlv {
  const tag = buf[offset];
  if (tag === undefined) throw new Error('truncated DER: no tag');
  const first = buf[offset + 1];
  if (first === undefined) throw new Error('truncated DER: no length');
  let length: number;
  let contentStart: number;
  if ((first & 0x80) === 0) {
    length = first;
    contentStart = offset + 2;
  } else {
    const numBytes = first & 0x7f;
    if (numBytes === 0) throw new Error('indefinite-length DER is not supported');
    let value = 0;
    for (let i = 0; i < numBytes; i++) {
      const b = buf[offset + 2 + i];
      if (b === undefined) throw new Error('truncated DER length');
      value = value * 256 + b;
    }
    length = value;
    contentStart = offset + 2 + numBytes;
  }
  const contentEnd = contentStart + length;
  if (contentEnd > buf.length) throw new Error('truncated DER content');
  return { tag, content: buf.subarray(contentStart, contentEnd), raw: buf.subarray(offset, contentEnd), end: contentEnd };
}

/** Walks the direct children of a constructed TLV's content, in order. */
export function children(content: Buffer): Tlv[] {
  const out: Tlv[] = [];
  let offset = 0;
  while (offset < content.length) {
    const t = readTlv(content, offset);
    out.push(t);
    offset = t.end;
  }
  return out;
}
