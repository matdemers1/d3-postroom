// A bounds-checked cursor over a Buffer. Every read past the end throws the caller's error type,
// so a truncated packet is a named parse failure rather than `undefined` flowing onwards.

export type ErrorFactory = (message: string) => Error;

export class Reader {
  readonly buf: Buffer;
  pos: number;
  readonly end: number;
  private readonly fail: ErrorFactory;

  constructor(buf: Buffer, fail: ErrorFactory, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
    this.fail = fail;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  u8(): number {
    if (this.pos >= this.end) throw this.fail('truncated');
    const v = this.buf[this.pos];
    this.pos++;
    return v ?? 0;
  }

  u16(): number {
    const hi = this.u8();
    return (hi << 8) | this.u8();
  }

  u32(): number {
    return ((this.u16() << 16) >>> 0) + this.u16();
  }

  bytes(n: number): Buffer {
    if (n < 0 || this.pos + n > this.end) throw this.fail('truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  rest(): Buffer {
    return this.bytes(this.remaining);
  }
}

export function byteAt(buf: Uint8Array, i: number): number {
  return buf[i] ?? 0;
}

/** base64url without padding, for JWK members. */
export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

/** Left-pad with zeros to `len` bytes (or strip leading zeros down to it). */
export function padStart(buf: Buffer, len: number): Buffer {
  if (buf.length === len) return buf;
  if (buf.length > len) {
    let i = 0;
    while (buf.length - i > len && buf[i] === 0) i++;
    return buf.subarray(i);
  }
  return Buffer.concat([Buffer.alloc(len - buf.length), buf]);
}

export function stripLeadingZeros(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.subarray(i);
}

export const hex = (buf: Uint8Array): string => Buffer.from(buf).toString('hex');
