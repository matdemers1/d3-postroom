// Content-Transfer-Encoding (RFC 2045 §6): streaming decoders with a carry of a few bytes, and the
// matching encoders. Every decoder accepts arbitrary chunking: a base64 quantum or a `=XX` escape
// split across chunks decodes exactly as it would in one piece.

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const HTAB = 0x09;
const EQ = 0x3d;

/** A streaming transfer decoder: `write` and `end` return decoded bytes (possibly empty). */
export interface TransferDecoder {
  write(chunk: Uint8Array): Buffer;
  end(): Buffer;
  /** Bytes currently held back waiting for the rest of a quantum or escape. */
  readonly carried: number;
  /** Set once if the input contained bytes the encoding does not allow (they were skipped or kept literal). */
  readonly malformed: boolean;
}

const EMPTY = Buffer.alloc(0);

const B64 = new Int16Array(256).fill(-1);
{
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alphabet.length; i++) B64[alphabet.charCodeAt(i)] = i;
  // Lenient: the URL-safe alphabet decodes too.
  B64[0x2d] = 62;
  B64[0x5f] = 63;
}

/**
 * Base64 (RFC 2045 §6.8). Whitespace is skipped; other characters outside the alphabet are skipped
 * and flagged. A `=` flushes the current quantum, so concatenated base64 blobs (each with its own
 * padding) still decode. Missing padding at the end is tolerated.
 */
export class Base64Decoder implements TransferDecoder {
  private acc = 0;
  private n = 0;
  private bad = false;

  get carried(): number {
    return this.n;
  }

  get malformed(): boolean {
    return this.bad;
  }

  write(chunk: Uint8Array): Buffer {
    const out = Buffer.allocUnsafe(Math.ceil((chunk.length * 3) / 4) + 3);
    let o = 0;
    let acc = this.acc;
    let n = this.n;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i] as number;
      const v = B64[c] as number;
      if (v >= 0) {
        acc = ((acc << 6) | v) & 0xffffff;
        if (++n === 4) {
          out[o++] = acc >>> 16;
          out[o++] = (acc >>> 8) & 0xff;
          out[o++] = acc & 0xff;
          n = 0;
          acc = 0;
        }
      } else if (c === EQ) {
        o = this.flushPartial(out, o, acc, n);
        acc = 0;
        n = 0;
      } else if (c !== CR && c !== LF && c !== SP && c !== HTAB) {
        this.bad = true;
      }
    }
    this.acc = acc;
    this.n = n;
    return out.subarray(0, o);
  }

  end(): Buffer {
    const out = Buffer.allocUnsafe(3);
    const o = this.flushPartial(out, 0, this.acc, this.n);
    this.acc = 0;
    this.n = 0;
    return out.subarray(0, o);
  }

  private flushPartial(out: Buffer, o: number, acc: number, n: number): number {
    if (n === 2) {
      out[o++] = (acc >>> 4) & 0xff;
    } else if (n === 3) {
      out[o++] = (acc >>> 10) & 0xff;
      out[o++] = (acc >>> 2) & 0xff;
    } else if (n === 1) {
      this.bad = true; // six bits cannot make a byte
    }
    return o;
  }
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10; // lowercase is not canonical, but seen
  return -1;
}

const enum Qp {
  Normal,
  Eq,
  EqHex,
  EqWs,
  EqCr,
}

/** Longest run of trailing whitespace held back to see whether a line break follows it. */
const MAX_HELD_WS = 1024;

/**
 * Quoted-printable (RFC 2045 §6.7). `=XX` decodes, `=` before a line break is a soft break, and
 * whitespace at the end of a line is dropped (rule 3: it was added in transport). Invalid escapes
 * are kept literally and flagged. The carry is at most one escape plus a bounded whitespace run.
 */
export class QuotedPrintableDecoder implements TransferDecoder {
  private state: Qp = Qp.Normal;
  private hex = 0;
  private hexByte = 0;
  /** Trailing whitespace held back (after `=` in EqWs, or in Normal). */
  private ws: number[] = [];
  private bad = false;

  get carried(): number {
    return this.ws.length + (this.state === Qp.Normal ? 0 : 2);
  }

  get malformed(): boolean {
    return this.bad;
  }

  write(chunk: Uint8Array): Buffer {
    const out = Buffer.allocUnsafe(chunk.length + this.ws.length + 3);
    let o = 0;
    const flushWs = (): void => {
      for (const w of this.ws) out[o++] = w;
      this.ws.length = 0;
    };
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i] as number;
      switch (this.state) {
        case Qp.Normal:
          if (c === SP || c === HTAB) {
            if (this.ws.length >= MAX_HELD_WS) flushWs();
            this.ws.push(c);
          } else if (c === CR || c === LF) {
            this.ws.length = 0; // trailing whitespace on a line is transport padding
            out[o++] = c;
          } else if (c === EQ) {
            flushWs();
            this.state = Qp.Eq;
          } else {
            flushWs();
            out[o++] = c;
          }
          break;
        case Qp.Eq: {
          const h = hexValue(c);
          if (h >= 0) {
            this.hex = h;
            this.hexByte = c;
            this.state = Qp.EqHex;
          } else if (c === CR) {
            this.state = Qp.EqCr;
          } else if (c === LF) {
            this.state = Qp.Normal; // soft line break
          } else if (c === SP || c === HTAB) {
            this.ws.push(c);
            this.state = Qp.EqWs;
          } else {
            this.bad = true;
            out[o++] = EQ;
            this.state = Qp.Normal;
            i--; // reprocess c as ordinary text
          }
          break;
        }
        case Qp.EqHex: {
          const h = hexValue(c);
          this.state = Qp.Normal;
          if (h >= 0) {
            out[o++] = (this.hex << 4) | h;
          } else {
            this.bad = true;
            out[o++] = EQ;
            out[o++] = this.hexByte;
            i--;
          }
          break;
        }
        case Qp.EqWs:
          if (c === SP || c === HTAB) {
            if (this.ws.length >= MAX_HELD_WS) {
              this.bad = true;
              out[o++] = EQ;
              flushWs();
              this.state = Qp.Normal;
            }
            this.ws.push(c);
          } else if (c === CR) {
            this.ws.length = 0;
            this.state = Qp.EqCr;
          } else if (c === LF) {
            this.ws.length = 0;
            this.state = Qp.Normal;
          } else {
            this.bad = true;
            out[o++] = EQ;
            flushWs();
            this.state = Qp.Normal;
            i--;
          }
          break;
        case Qp.EqCr:
          this.state = Qp.Normal;
          if (c !== LF) i--; // "=\r" without LF: still a soft break; reprocess c
          break;
      }
    }
    return out.subarray(0, o);
  }

  end(): Buffer {
    const out: number[] = [];
    if (this.state === Qp.Eq) {
      out.push(EQ);
      this.bad = true;
    } else if (this.state === Qp.EqHex) {
      out.push(EQ, this.hexByte);
      this.bad = true;
    }
    // Held whitespace at the very end is trailing whitespace on the last line: dropped.
    this.ws.length = 0;
    this.state = Qp.Normal;
    return out.length === 0 ? EMPTY : Buffer.from(out);
  }
}

/** 7bit, 8bit and binary: the identity. */
export class IdentityDecoder implements TransferDecoder {
  readonly carried = 0;
  readonly malformed = false;

  write(chunk: Uint8Array): Buffer {
    return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
  }

  end(): Buffer {
    return EMPTY;
  }
}

/** Normalise a Content-Transfer-Encoding value: lowercase token, comments and quotes removed. */
export function normalizeEncoding(value: string | null): string {
  if (value === null) return '7bit';
  const token = value.replace(/\([^)]*\)/g, ' ').replace(/"/g, '').trim().toLowerCase();
  return token === '' ? '7bit' : token;
}

/** True for the encodings this package decodes. Unknown ones pass through as identity. */
export function isKnownEncoding(encoding: string): boolean {
  return ['7bit', '8bit', 'binary', 'base64', 'quoted-printable'].includes(encoding);
}

export function createTransferDecoder(encoding: string): TransferDecoder {
  switch (encoding) {
    case 'base64':
      return new Base64Decoder();
    case 'quoted-printable':
      return new QuotedPrintableDecoder();
    default:
      return new IdentityDecoder();
  }
}

// --- Encoders -------------------------------------------------------------------------------------

/** Base64 with CRLF line breaks every `lineLength` characters (76 per RFC 2045). */
export function encodeBase64(data: Uint8Array, lineLength = 76): string {
  const b64 = Buffer.from(data.buffer, data.byteOffset, data.length).toString('base64');
  if (b64.length <= lineLength) return b64;
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += lineLength) lines.push(b64.slice(i, i + lineLength));
  return lines.join('\r\n');
}

/**
 * A streaming base64 encoder: carries at most two input bytes and a line position, and emits
 * 76-column lines separated by CRLF (no trailing CRLF).
 */
export class Base64Encoder {
  private carry: Buffer = EMPTY;
  private column = 0;
  private readonly lineLength: number;

  constructor(lineLength = 76) {
    this.lineLength = lineLength - (lineLength % 4);
  }

  write(chunk: Uint8Array): string {
    const data = this.carry.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.carry, chunk]);
    const whole = data.length - (data.length % 3);
    this.carry = Buffer.from(data.subarray(whole));
    return this.wrap(data.subarray(0, whole).toString('base64'));
  }

  end(): string {
    const tail = this.wrap(this.carry.toString('base64'));
    this.carry = EMPTY;
    return tail;
  }

  private wrap(b64: string): string {
    let out = '';
    let i = 0;
    while (i < b64.length) {
      if (this.column === this.lineLength) {
        out += '\r\n';
        this.column = 0;
      }
      const take = Math.min(this.lineLength - this.column, b64.length - i);
      out += b64.slice(i, i + take);
      this.column += take;
      i += take;
    }
    return out;
  }
}

export interface QpEncodeOptions {
  /**
   * When true (default), CR and LF are data and are encoded as `=0D`/`=0A`, so arbitrary bytes
   * round-trip. When false, CRLF (or a bare LF) is a hard line break, as in text.
   */
  binary?: boolean;
  lineLength?: number;
}

const HEX = '0123456789ABCDEF';

/** Quoted-printable (RFC 2045 §6.7) with soft breaks so no line exceeds 76 characters. */
export function encodeQuotedPrintable(data: Uint8Array, options: QpEncodeOptions = {}): string {
  const binary = options.binary ?? true;
  const max = options.lineLength ?? 76;
  const out: string[] = [];
  let line = '';
  const push = (token: string): void => {
    // Leave room for the soft-break "=".
    if (line.length + token.length > max - 1) {
      out.push(line + '=\r\n');
      line = '';
    }
    line += token;
  };
  const escape = (c: number): string => '=' + (HEX[c >> 4] as string) + (HEX[c & 15] as string);
  for (let i = 0; i < data.length; i++) {
    const c = data[i] as number;
    if (!binary && (c === LF || (c === CR && data[i + 1] === LF))) {
      if (c === CR) i++;
      out.push(line + '\r\n');
      line = '';
      continue;
    }
    const next = data[i + 1];
    const atLineEnd = next === undefined || (!binary && (next === CR || next === LF));
    if ((c === SP || c === HTAB) && !atLineEnd) {
      push(String.fromCharCode(c));
    } else if (c >= 0x21 && c <= 0x7e && c !== EQ) {
      push(String.fromCharCode(c));
    } else {
      push(escape(c));
    }
  }
  out.push(line);
  return out.join('');
}
