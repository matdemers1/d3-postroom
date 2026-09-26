// The ManageSieve wire format (RFC 5804 §4): reading client lines and writing server responses.
//
// A client line is a sequence of tokens separated by single spaces and ended by CRLF:
//   atom     — a command name (letters only here);
//   number   — 1*DIGIT, at most 2^32 - 1;
//   string   — "quoted" (only \" and \\ escapes, no CR/LF, no NUL) or a literal {n+}CRLF<n octets>.
//             RFC 5804 lets a client send only the non-synchronising {n+}; {n} is accepted too, and
//             treated the same way (the server never sends a continuation for it).
//
// Strict CRLF: a bare LF or a CR not followed by LF outside a literal is a protocol error, never a
// line end. Lines outside literals are bounded; a literal larger than `maxLiteral` is read and
// discarded (the client is already sending it) and reported, so the connection stays in step; one
// larger than `hardLiteralLimit` ends the connection.

export type Token =
  | { readonly kind: 'atom'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: Buffer; readonly literal: boolean };

export type ReaderEvent =
  | { readonly type: 'line'; readonly tokens: readonly Token[] }
  /** A line that could not be parsed; the reader has skipped past it. `fatal`: close the connection. */
  | { readonly type: 'error'; readonly message: string; readonly fatal: boolean; readonly code?: 'QUOTA/MAXSIZE' };

export interface ReaderLimits {
  /** Longest line outside literals, in octets (default 8 KiB). */
  readonly maxLine?: number;
  /** Largest literal kept (default 256 KiB + 1 KiB). Larger ones are discarded and reported. */
  readonly maxLiteral?: number;
  /** A literal announcing more than this closes the connection (default 16 MiB). */
  readonly hardLiteralLimit?: number;
}

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const DQUOTE = 0x22;
const BACKSLASH = 0x5c;
const MAX_NUMBER = 4_294_967_295;

class NeedMore extends Error {}

class ParseFailure extends Error {
  constructor(
    message: string,
    /** Where to resume after this failure: the end of the offending line, when known. */
    readonly resumeAt: number | null,
  ) {
    super(message);
  }
}

/** A literal too large to keep: skip `size` octets that start at `dataStart`, then the rest of the line. */
class Oversize extends Error {
  constructor(
    readonly dataStart: number,
    readonly size: number,
  ) {
    super('literal too large');
  }
}

export class CommandReader {
  private buf: Buffer = Buffer.alloc(0);
  private skipBytes = 0;
  /** After an oversized literal: discard up to and including the next CRLF, then report. */
  private discardLine = false;
  private readonly maxLine: number;
  private readonly maxLiteral: number;
  private readonly hardLiteralLimit: number;
  private fatal = false;

  constructor(limits: ReaderLimits = {}) {
    this.maxLine = limits.maxLine ?? 8 * 1024;
    this.maxLiteral = limits.maxLiteral ?? 256 * 1024 + 1024;
    this.hardLiteralLimit = limits.hardLiteralLimit ?? 16 * 1024 * 1024;
  }

  push(chunk: Buffer): void {
    if (this.fatal) return;
    if (this.skipBytes > 0) {
      const n = Math.min(this.skipBytes, chunk.length);
      this.skipBytes -= n;
      chunk = chunk.subarray(n);
      if (chunk.length === 0) return;
    }
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk]);
  }

  /** The next complete line, an error, or null when more input is needed. */
  next(): ReaderEvent | null {
    if (this.fatal || this.skipBytes > 0) return null;
    if (this.discardLine) {
      const end = this.buf.indexOf('\r\n');
      if (end < 0) {
        if (this.buf.length > this.maxLine) return this.die('line too long');
        return null;
      }
      this.buf = this.buf.subarray(end + 2);
      this.discardLine = false;
      return { type: 'error', message: `literal larger than ${this.maxLiteral} octets`, fatal: false, code: 'QUOTA/MAXSIZE' };
    }
    if (this.buf.length === 0) return null;
    try {
      const { tokens, end } = this.parseLine();
      this.buf = this.buf.subarray(end);
      return { type: 'line', tokens };
    } catch (err) {
      if (err instanceof NeedMore) return null;
      if (err instanceof Oversize) {
        if (err.size > this.hardLiteralLimit) return this.die(`literal larger than ${this.hardLiteralLimit} octets`);
        const available = this.buf.length - err.dataStart;
        if (available >= err.size) {
          this.buf = this.buf.subarray(err.dataStart + err.size);
        } else {
          this.skipBytes = err.size - available;
          this.buf = Buffer.alloc(0);
        }
        this.discardLine = true;
        return this.next();
      }
      if (err instanceof ParseFailure) {
        if (err.resumeAt === null) return this.die(err.message);
        this.buf = this.buf.subarray(err.resumeAt);
        return { type: 'error', message: err.message, fatal: false };
      }
      throw err;
    }
  }

  private die(message: string): ReaderEvent {
    this.fatal = true;
    this.buf = Buffer.alloc(0);
    return { type: 'error', message, fatal: true };
  }

  /** The end of the current line (after its CRLF) from `from`, for resuming after a bad line. */
  private lineEnd(from: number): number | null {
    const at = this.buf.indexOf('\r\n', from);
    return at < 0 ? null : at + 2;
  }

  private parseLine(): { tokens: Token[]; end: number } {
    const b = this.buf;
    const tokens: Token[] = [];
    let i = 0;
    let lineOctets = 0;
    const fail = (message: string, at: number): never => {
      const resume = this.lineEnd(at);
      if (resume === null) {
        // Without the line's end in sight, wait for it — unless the line is already too long.
        if (b.length - at > this.maxLine) throw new ParseFailure('line too long', null);
        throw new NeedMore();
      }
      throw new ParseFailure(message, resume);
    };
    for (;;) {
      if (lineOctets > this.maxLine) throw new ParseFailure('line too long', null);
      if (i >= b.length) {
        if (b.length > this.maxLine + this.maxLiteral) throw new ParseFailure('line too long', null);
        throw new NeedMore();
      }
      const c = b[i] as number;
      if (c === CR) {
        if (i + 1 >= b.length) throw new NeedMore();
        if (b[i + 1] !== LF) throw new ParseFailure('bare CR in a command line (lines end with CRLF)', i + 1);
        if (tokens.length === 0) return fail('empty command line', i);
        return { tokens, end: i + 2 };
      }
      if (c === LF) throw new ParseFailure('bare LF in a command line (lines end with CRLF)', i + 1);
      if (tokens.length > 0) {
        if (c !== SP) return fail('expected a space between arguments', i);
        i++;
        lineOctets++;
        if (i >= b.length) throw new NeedMore();
      }
      const start = i;
      const d = b[i] as number;
      if (d === DQUOTE) {
        const out: number[] = [];
        i++;
        for (;;) {
          if (i >= b.length) {
            if (i - start > this.maxLine) throw new ParseFailure('line too long', null);
            throw new NeedMore();
          }
          const q = b[i] as number;
          if (q === DQUOTE) {
            i++;
            break;
          }
          if (q === CR || q === LF || q === 0) return fail('a quoted string cannot contain CR, LF or NUL', i);
          if (q === BACKSLASH) {
            if (i + 1 >= b.length) throw new NeedMore();
            const e = b[i + 1] as number;
            if (e !== DQUOTE && e !== BACKSLASH) return fail('only \\" and \\\\ may be escaped in a quoted string', i);
            out.push(e);
            i += 2;
            continue;
          }
          out.push(q);
          i++;
        }
        lineOctets += i - start;
        tokens.push({ kind: 'string', value: Buffer.from(out), literal: false });
        continue;
      }
      if (d === 0x7b /* { */) {
        let j = i + 1;
        while (j < b.length && (b[j] as number) >= 0x30 && (b[j] as number) <= 0x39) j++;
        if (j >= b.length) throw new NeedMore();
        const digits = b.toString('latin1', i + 1, j);
        if (digits === '' || digits.length > 10) return fail('bad literal length', i);
        const size = Number(digits);
        if ((b[j] as number) === 0x2b /* + */) j++;
        if (j >= b.length) throw new NeedMore();
        if ((b[j] as number) !== 0x7d /* } */) return fail('bad literal', i);
        if (j + 1 >= b.length) throw new NeedMore();
        if (b[j + 1] !== CR) return fail('a literal header must end with CRLF', j);
        if (j + 2 >= b.length) throw new NeedMore();
        if (b[j + 2] !== LF) return fail('a literal header must end with CRLF', j);
        const dataStart = j + 3;
        if (size > this.maxLiteral) throw new Oversize(dataStart, size);
        if (b.length < dataStart + size) throw new NeedMore();
        tokens.push({ kind: 'string', value: Buffer.from(b.subarray(dataStart, dataStart + size)), literal: true });
        lineOctets += dataStart - start;
        i = dataStart + size;
        continue;
      }
      if (d >= 0x30 && d <= 0x39) {
        let j = i;
        while (j < b.length && (b[j] as number) >= 0x30 && (b[j] as number) <= 0x39) j++;
        if (j >= b.length) throw new NeedMore();
        const text = b.toString('latin1', i, j);
        const value = Number(text);
        if (text.length > 10 || value > MAX_NUMBER) return fail('number out of range', i);
        tokens.push({ kind: 'number', value });
        lineOctets += j - i;
        i = j;
        continue;
      }
      if ((d >= 0x41 && d <= 0x5a) || (d >= 0x61 && d <= 0x7a)) {
        let j = i;
        while (j < b.length && (((b[j] as number) >= 0x41 && (b[j] as number) <= 0x5a) || ((b[j] as number) >= 0x61 && (b[j] as number) <= 0x7a))) j++;
        if (j >= b.length) throw new NeedMore();
        tokens.push({ kind: 'atom', value: b.toString('latin1', i, j).toUpperCase() });
        lineOctets += j - i;
        i = j;
        continue;
      }
      return fail('unexpected character in a command line', i);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Responses (server → client)

/** A string as the server sends it: quoted when it can be, else a literal {n} (RFC 5804 §4). */
export function encodeString(value: string): string {
  if (!/[\r\n\0]/.test(value) && Buffer.byteLength(value, 'utf8') <= 1024) return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  return `{${Buffer.byteLength(value, 'utf8')}}\r\n${value}`;
}

/** A literal {n} of exactly these octets, for GETSCRIPT. */
export function encodeLiteral(bytes: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`{${bytes.length}}\r\n`, 'latin1'), bytes]);
}

export type ResponseCode =
  | 'AUTH-TOO-WEAK'
  | 'ENCRYPT-NEEDED'
  | 'QUOTA'
  | 'QUOTA/MAXSCRIPTS'
  | 'QUOTA/MAXSIZE'
  | 'SASL'
  | 'TRANSITION-NEEDED'
  | 'TRYLATER'
  | 'ACTIVE'
  | 'NONEXISTENT'
  | 'ALREADYEXISTS'
  | 'WARNINGS'
  | { readonly tag: string };

function encodeCode(code: ResponseCode): string {
  return typeof code === 'string' ? code : `TAG ${encodeString(code.tag)}`;
}

/** `OK`, `NO` or `BYE`, with an optional response code and human-readable text, and CRLF. */
export function status(kind: 'OK' | 'NO' | 'BYE', text?: string, code?: ResponseCode): string {
  let line: string = kind;
  if (code !== undefined) line += ` (${encodeCode(code)})`;
  if (text !== undefined) line += ` ${encodeString(text)}`;
  return `${line}\r\n`;
}

export interface CapabilityInput {
  readonly secure: boolean;
  readonly startTlsAvailable: boolean;
  readonly authenticated: boolean;
  readonly sieveExtensions: string;
  readonly maxRedirects: number;
}

/**
 * The capability response (RFC 5804 §1.7). SASL lists PLAIN only once TLS is active; before it the
 * list is empty, because a password is never accepted in the clear. STARTTLS is offered only
 * before TLS and only when a certificate is configured.
 */
export function capabilityLines(c: CapabilityInput): string {
  const lines = [
    `"IMPLEMENTATION" "Postroom ManageSieve"`,
    `"SASL" "${c.secure && !c.authenticated ? 'PLAIN' : ''}"`,
    `"SIEVE" ${encodeString(c.sieveExtensions)}`,
    ...(c.secure || !c.startTlsAvailable ? [] : ['"STARTTLS"']),
    `"MAXREDIRECTS" "${c.maxRedirects}"`,
    `"VERSION" "1.0"`,
  ];
  return lines.map((l) => `${l}\r\n`).join('');
}
