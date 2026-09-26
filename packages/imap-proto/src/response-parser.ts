// Client-side response reader and parser: for tests, and for the IMAP import client (PST-T-10.2).
//
// `ResponseReader` splits a server's byte stream into whole responses (lines plus the literals they
// announce, buffered up to `maxLiteralSize`) at arbitrary chunk boundaries; `parseResponse` turns
// one into a generic structure: a continuation, a status response (tagged or untagged, with its
// response code), or untagged data with its values as atoms, strings, NIL and nested lists. Neither
// throws: malformed input yields an `error` result, and a limit breach makes the reader fatal.

import { Ch, Cursor, SyntaxFail } from './lexer.js';
import { literalMarkerAt } from './reader.js';

export type RespValue =
  | { readonly kind: 'atom'; readonly value: string }
  | { readonly kind: 'string'; readonly value: Buffer; readonly literal: boolean }
  | { readonly kind: 'nil' }
  | { readonly kind: 'list'; readonly items: readonly RespValue[] };

export interface RespCode {
  readonly name: string;
  readonly args: readonly RespValue[];
}

export type ParsedResponse =
  | { readonly kind: 'continuation'; readonly text: string }
  | {
      readonly kind: 'status';
      /** null for untagged ("*"). */
      readonly tag: string | null;
      readonly status: 'OK' | 'NO' | 'BAD' | 'BYE' | 'PREAUTH';
      readonly code: RespCode | null;
      readonly text: string;
    }
  | {
      readonly kind: 'data';
      /** The leading number of "* 12 FETCH …", "* 3 EXISTS"; otherwise null. */
      readonly number: number | null;
      readonly name: string;
      readonly values: readonly RespValue[];
    }
  | { readonly kind: 'error'; readonly message: string; readonly fatal: boolean };

export interface ResponseParseOptions {
  /** Deepest list nesting (BODYSTRUCTURE nests one level per MIME level). */
  readonly maxNesting?: number;
}

const STATUSES = ['OK', 'NO', 'BAD', 'BYE', 'PREAUTH'] as const;
const utf8 = new TextDecoder('utf-8');

function isRespAtomChar(c: number): boolean {
  return (
    c > 0x20 && c !== 0x7f && c !== Ch.LPAREN && c !== Ch.RPAREN && c !== Ch.LBRACE && c !== Ch.DQUOTE && c !== Ch.RBRACKET
  );
}

class RespParser {
  readonly c: Cursor;
  private depth = 0;

  constructor(
    buf: Buffer,
    readonly maxNesting: number,
  ) {
    this.c = new Cursor(buf);
  }

  /** An atom; "[...]" groups inside it (section specs) may contain spaces and parentheses. */
  atom(): string {
    const c = this.c;
    const start = c.pos;
    for (;;) {
      const b = c.peek();
      if (b === Ch.LBRACKET) {
        let level = 0;
        while (!c.eof()) {
          const x = c.peek();
          if (x === Ch.CR || x === Ch.LF) break;
          c.pos++;
          if (x === Ch.LBRACKET) level++;
          else if (x === Ch.RBRACKET && --level === 0) break;
        }
        if (level !== 0) c.fail('unterminated [ in atom');
        continue;
      }
      if (!isRespAtomChar(b)) break;
      c.pos++;
    }
    if (c.pos === start) c.fail('expected a value');
    return c.buf.toString('latin1', start, c.pos);
  }

  value(): RespValue {
    const c = this.c;
    const b = c.peek();
    if (b === Ch.LPAREN) {
      if (++this.depth > this.maxNesting) c.fail(`lists nested deeper than ${this.maxNesting}`);
      c.pos++;
      const items: RespValue[] = [];
      if (!c.maybe(Ch.RPAREN)) {
        items.push(this.value());
        // Items are separated by SP, except that `1*address` and `1*body` lists sit back to back.
        while (c.maybe(Ch.SP) || c.is(Ch.LPAREN)) items.push(this.value());
        c.take(Ch.RPAREN, ')');
      }
      this.depth--;
      return { kind: 'list', items };
    }
    if (b === Ch.DQUOTE) return { kind: 'string', value: c.quoted(), literal: false };
    if (b === Ch.LBRACE || (b === Ch.TILDE && c.peek(1) === Ch.LBRACE)) {
      return { kind: 'string', value: Buffer.from(c.literal(true).data), literal: true };
    }
    const a = this.atom();
    return a.toUpperCase() === 'NIL' ? { kind: 'nil' } : { kind: 'atom', value: a };
  }

  valuesUntil(stop: number): RespValue[] {
    const out: RespValue[] = [];
    while (!this.c.eof() && !this.c.is(stop)) {
      out.push(this.value());
      if (!this.c.maybe(Ch.SP)) break;
    }
    return out;
  }

  rest(): string {
    const text = utf8.decode(this.c.buf.subarray(this.c.pos));
    this.c.pos = this.c.buf.length;
    return text;
  }

  statusTail(tag: string | null, status: Extract<ParsedResponse, { kind: 'status' }>['status']): ParsedResponse {
    const c = this.c;
    let code: RespCode | null = null;
    c.maybe(Ch.SP);
    if (c.maybe(Ch.LBRACKET)) {
      const name = c.run((x) => isRespAtomChar(x) && x !== Ch.LBRACKET, 'a response code').toString('latin1').toUpperCase();
      let args: RespValue[] = [];
      if (c.maybe(Ch.SP)) args = this.valuesUntil(Ch.RBRACKET);
      c.take(Ch.RBRACKET, ']');
      code = { name, args };
      c.maybe(Ch.SP);
    }
    return { kind: 'status', tag, status, code, text: this.rest() };
  }

  response(): ParsedResponse {
    const c = this.c;
    if (c.maybe(Ch.PLUS)) {
      c.maybe(Ch.SP);
      return { kind: 'continuation', text: this.rest() };
    }
    let tag: string | null = null;
    if (!c.maybe(Ch.STAR)) {
      tag = c.run((x) => isRespAtomChar(x) && x !== Ch.PLUS, 'a tag').toString('latin1');
    }
    c.sp();
    const first = this.atom();
    const upper = first.toUpperCase();
    const status = STATUSES.find((s) => s === upper);
    if (status) return this.statusTail(tag, status);
    if (tag !== null) c.fail(`tagged response with status ${first}`);
    if (/^[0-9]+$/.test(first)) {
      const number = Number(first);
      c.sp();
      const name = this.atom().toUpperCase();
      const values = c.maybe(Ch.SP) ? this.valuesUntil(-2) : [];
      c.end();
      return { kind: 'data', number, name, values };
    }
    const values = c.maybe(Ch.SP) ? this.valuesUntil(-2) : [];
    c.end();
    return { kind: 'data', number: null, name: upper, values };
  }
}

/** Parse one whole response: the wire bytes without the final CRLF, literals inline. */
export function parseResponse(input: Uint8Array | string, options: ResponseParseOptions = {}): ParsedResponse {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input.buffer, input.byteOffset, input.length);
  const p = new RespParser(buf, options.maxNesting ?? 64);
  try {
    return p.response();
  } catch (err) {
    if (!(err instanceof SyntaxFail)) throw err;
    return { kind: 'error', message: `${err.message} at octet ${err.position}`, fatal: false };
  }
}

export interface ResponseReaderOptions extends ResponseParseOptions {
  readonly maxLineLength?: number;
  readonly maxLiteralSize?: number;
  readonly maxResponseSize?: number;
}

/** Splits a server's stream into responses. Push chunks, then pull with `next()` until null. */
export class ResponseReader {
  readonly maxLineLength: number;
  readonly maxLiteralSize: number;
  readonly maxResponseSize: number;
  private readonly parseOptions: ResponseParseOptions;
  private readonly queue: Buffer[] = [];
  private offset = 0;
  private line: Buffer[] = [];
  private lineLen = 0;
  private parts: Buffer[] = [];
  private size = 0;
  private remaining = -1;
  private dead = false;

  constructor(options: ResponseReaderOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? 64 * 1024;
    this.maxLiteralSize = options.maxLiteralSize ?? 64 * 1024 * 1024;
    this.maxResponseSize = options.maxResponseSize ?? 128 * 1024 * 1024;
    this.parseOptions = options;
  }

  get bufferedBytes(): number {
    let q = 0;
    for (const c of this.queue) q += c.length;
    return q - this.offset + this.lineLen + this.size;
  }

  push(chunk: Uint8Array): void {
    if (this.dead || chunk.length === 0) return;
    this.queue.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
  }

  next(): ParsedResponse | null {
    while (!this.dead) {
      const chunk = this.queue[0];
      if (!chunk) return null;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
        continue;
      }
      if (this.remaining >= 0) {
        const n = Math.min(this.remaining, chunk.length - this.offset);
        this.parts.push(Buffer.from(chunk.subarray(this.offset, this.offset + n)));
        this.offset += n;
        this.remaining -= n;
        if (this.remaining === 0) this.remaining = -1;
        continue;
      }
      const lf = chunk.indexOf(Ch.LF, this.offset);
      const end = lf < 0 ? chunk.length : lf;
      if (this.lineLen + end - this.offset > this.maxLineLength + 1) return this.fatal('response line too long');
      this.line.push(Buffer.from(chunk.subarray(this.offset, end)));
      this.lineLen += end - this.offset;
      if (lf < 0) {
        this.offset = chunk.length;
        continue;
      }
      this.offset = lf + 1;
      const raw = Buffer.concat(this.line);
      this.line = [];
      this.lineLen = 0;
      if (raw[raw.length - 1] !== Ch.CR) {
        this.resetResponse();
        return { kind: 'error', message: 'response line ended with a bare LF', fatal: false };
      }
      const text = raw.subarray(0, raw.length - 1);
      const marker = literalMarkerAt(text);
      this.size += text.length + 2;
      if (marker) {
        if (marker.size > this.maxLiteralSize) return this.fatal(`literal of ${marker.size} octets is over the limit`);
        if (this.size + marker.size > this.maxResponseSize) return this.fatal('response over the size limit');
        this.parts.push(text, Buffer.from('\r\n'));
        this.size += marker.size;
        this.remaining = marker.size;
        if (this.remaining === 0) this.remaining = -1;
        continue;
      }
      if (this.size > this.maxResponseSize) return this.fatal('response over the size limit');
      this.parts.push(text);
      const whole = Buffer.concat(this.parts);
      this.resetResponse();
      return parseResponse(whole, this.parseOptions);
    }
    return null;
  }

  private resetResponse(): void {
    this.parts = [];
    this.size = 0;
    this.remaining = -1;
  }

  private fatal(message: string): ParsedResponse {
    this.dead = true;
    this.queue.length = 0;
    this.line = [];
    this.lineLen = 0;
    this.resetResponse();
    return { kind: 'error', message, fatal: true };
  }
}

/** A response value as a number, or null. */
export function respNumber(v: RespValue | undefined): number | null {
  return v?.kind === 'atom' && /^[0-9]+$/.test(v.value) ? Number(v.value) : null;
}

/** A response string's text (UTF-8), an atom's text, or null for NIL / a list. */
export function respText(v: RespValue | undefined): string | null {
  if (v?.kind === 'string') return utf8.decode(v.value);
  if (v?.kind === 'atom') return v.value;
  return null;
}
