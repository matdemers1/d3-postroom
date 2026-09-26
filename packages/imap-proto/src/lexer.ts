// The shared low-level cursor over one complete command (or response): atoms, quoted strings,
// literals, numbers. Everything here fails by throwing `SyntaxFail`, which the parsers catch and turn
// into a typed result; nothing else is ever thrown.

export class SyntaxFail extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'SyntaxFail';
  }
}

export const Ch = {
  SP: 0x20,
  DQUOTE: 0x22,
  DOLLAR: 0x24,
  PERCENT: 0x25,
  LPAREN: 0x28,
  RPAREN: 0x29,
  STAR: 0x2a,
  PLUS: 0x2b,
  COMMA: 0x2c,
  MINUS: 0x2d,
  DOT: 0x2e,
  COLON: 0x3a,
  LT: 0x3c,
  GT: 0x3e,
  LBRACKET: 0x5b,
  BACKSLASH: 0x5c,
  RBRACKET: 0x5d,
  LBRACE: 0x7b,
  RBRACE: 0x7d,
  TILDE: 0x7e,
  CR: 0x0d,
  LF: 0x0a,
} as const;

/** ATOM-CHAR: any CHAR except atom-specials ( ) { SP CTL % * " \ ]. */
export function isAtomChar(c: number): boolean {
  return (
    c > 0x20 &&
    c < 0x7f &&
    c !== Ch.LPAREN &&
    c !== Ch.RPAREN &&
    c !== Ch.LBRACE &&
    c !== Ch.PERCENT &&
    c !== Ch.STAR &&
    c !== Ch.DQUOTE &&
    c !== Ch.BACKSLASH &&
    c !== Ch.RBRACKET
  );
}

/** ASTRING-CHAR: ATOM-CHAR or "]". */
export function isAstringChar(c: number): boolean {
  return isAtomChar(c) || c === Ch.RBRACKET;
}

/** list-char: ATOM-CHAR, list-wildcards, resp-specials. */
export function isListChar(c: number): boolean {
  return isAtomChar(c) || c === Ch.PERCENT || c === Ch.STAR || c === Ch.RBRACKET;
}

export function isTagChar(c: number): boolean {
  return isAstringChar(c) && c !== Ch.PLUS;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isWordChar(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || isDigit(c) || c === Ch.DOT || c === Ch.MINUS || c === 0x3d;
}

const MAX_U32 = 0xffffffff;
const MAX_MODSEQ = (1n << 63n) - 1n;

export class Cursor {
  pos = 0;

  constructor(readonly buf: Buffer) {}

  fail(message: string): never {
    throw new SyntaxFail(message, this.pos);
  }

  eof(): boolean {
    return this.pos >= this.buf.length;
  }

  peek(offset = 0): number {
    return this.buf[this.pos + offset] ?? -1;
  }

  is(c: number): boolean {
    return this.buf[this.pos] === c;
  }

  take(c: number, what: string): void {
    if (this.buf[this.pos] !== c) this.fail(`expected ${what}`);
    this.pos++;
  }

  maybe(c: number): boolean {
    if (this.buf[this.pos] !== c) return false;
    this.pos++;
    return true;
  }

  sp(): void {
    if (this.buf[this.pos] !== Ch.SP) this.fail(this.eof() ? 'missing argument' : 'expected a single space');
    this.pos++;
  }

  end(): void {
    if (!this.eof()) this.fail('unexpected characters at end of command');
  }

  /** Case-insensitive match of an ASCII keyword; advances on success. */
  keywordIs(word: string): boolean {
    if (this.pos + word.length > this.buf.length) return false;
    if (this.buf.toString('latin1', this.pos, this.pos + word.length).toUpperCase() !== word) return false;
    const next = this.buf[this.pos + word.length] ?? -1;
    if (isWordChar(next)) return false;
    this.pos += word.length;
    return true;
  }

  /** A keyword made of letters, digits, ".", "-" and "=", upper-cased. */
  word(what: string): string {
    const start = this.pos;
    while (isWordChar(this.buf[this.pos] ?? -1)) this.pos++;
    if (this.pos === start) this.fail(`expected ${what}`);
    return this.buf.toString('latin1', start, this.pos).toUpperCase();
  }

  /** Characters satisfying `pred`, at least one. */
  run(pred: (c: number) => boolean, what: string): Buffer {
    const start = this.pos;
    while (this.pos < this.buf.length && pred(this.buf[this.pos] ?? -1)) this.pos++;
    if (this.pos === start) this.fail(`expected ${what}`);
    return this.buf.subarray(start, this.pos);
  }

  atom(): string {
    return this.run(isAtomChar, 'an atom').toString('latin1');
  }

  number(): number {
    const start = this.pos;
    while (isDigit(this.buf[this.pos] ?? -1)) this.pos++;
    if (this.pos === start) this.fail('expected a number');
    if (this.pos - start > 10) this.fail('number out of range');
    const n = Number(this.buf.toString('latin1', start, this.pos));
    if (n > MAX_U32) this.fail('number out of range');
    return n;
  }

  nzNumber(): number {
    const at = this.pos;
    const n = this.number();
    if (n === 0 || this.buf[at] === 0x30) {
      this.pos = at;
      this.fail('expected a non-zero number');
    }
    return n;
  }

  /** mod-sequence-value: 1–(2^63-1); `allowZero` for mod-sequence-valzer. */
  modseq(allowZero: boolean): bigint {
    const start = this.pos;
    while (isDigit(this.buf[this.pos] ?? -1)) this.pos++;
    if (this.pos === start) this.fail('expected a mod-sequence value');
    if (this.pos - start > 19) this.fail('mod-sequence value out of range');
    const v = BigInt(this.buf.toString('latin1', start, this.pos));
    if (v > MAX_MODSEQ || (!allowZero && v === 0n)) this.fail('mod-sequence value out of range');
    return v;
  }

  quoted(): Buffer {
    this.take(Ch.DQUOTE, '"');
    const out: number[] = [];
    for (;;) {
      const c = this.buf[this.pos];
      if (c === undefined) this.fail('unterminated quoted string');
      if (c === Ch.CR || c === Ch.LF || c === 0) this.fail('CR, LF or NUL inside a quoted string');
      this.pos++;
      if (c === Ch.DQUOTE) return Buffer.from(out);
      if (c === Ch.BACKSLASH) {
        const e = this.buf[this.pos];
        if (e !== Ch.DQUOTE && e !== Ch.BACKSLASH) this.fail('only \\" and \\\\ may be escaped in a quoted string');
        out.push(e);
        this.pos++;
      } else {
        out.push(c);
      }
    }
  }

  /** `{n}` / `{n+}` CRLF n-octets; `~{n}` too when `allowBinary`. */
  literal(allowBinary: boolean): { data: Buffer; binary: boolean; nonSync: boolean } {
    const binary = this.maybe(Ch.TILDE);
    if (binary && !allowBinary) this.fail('literal8 is not allowed here');
    this.take(Ch.LBRACE, '{');
    const size = this.number();
    const nonSync = this.maybe(Ch.PLUS);
    this.take(Ch.RBRACE, '}');
    if (this.buf[this.pos] !== Ch.CR || this.buf[this.pos + 1] !== Ch.LF) this.fail('literal marker must end the line');
    this.pos += 2;
    if (this.pos + size > this.buf.length) this.fail('literal shorter than announced');
    const data = this.buf.subarray(this.pos, this.pos + size);
    this.pos += size;
    return { data, binary, nonSync };
  }

  /** A literal8 marker where only a string may appear: named, rather than read as an atom "~". */
  private literal8Ahead(): boolean {
    return this.peek() === Ch.TILDE && this.peek(1) === Ch.LBRACE;
  }

  string(): Buffer {
    const c = this.peek();
    if (c === Ch.DQUOTE) return this.quoted();
    if (c === Ch.LBRACE || this.literal8Ahead()) return this.literal(false).data;
    return this.fail('expected a string');
  }

  astring(): Buffer {
    const c = this.peek();
    if (c === Ch.DQUOTE || c === Ch.LBRACE || this.literal8Ahead()) return this.string();
    return this.run(isAstringChar, 'an astring');
  }

  /** NIL or a string; null for NIL. */
  nstring(): Buffer | null {
    if (this.keywordIs('NIL')) return null;
    return this.string();
  }
}
