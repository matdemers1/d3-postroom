// RFC 5228 §8.1 lexical tokens: identifiers, tags, numbers with K/M/G quantifiers, quoted strings
// with backslash escapes, `text:` multi-line strings with dot-stuffing, the specials, and both
// comment forms. Identifiers and tags are case-insensitive, so the lexer lowercases them; strings
// keep their exact contents. Every token carries the line and column it started at.
//
// Lenient on line endings (a bare LF is accepted where the RFC says CRLF, because scripts pasted into
// a web form rarely keep their CRs); strict on everything else. The lexer is a pull iterator, so a
// parse error stops it early and nothing past the error is scanned.

import { SieveSyntaxError, type SourcePos } from './errors.js';

export type TokenKind = 'identifier' | 'tag' | 'number' | 'string' | '[' | ']' | '(' | ')' | '{' | '}' | ',' | ';' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  /** Lowercased name for identifiers and tags (tags without the colon); the decoded value for strings. */
  readonly text: string;
  /** The numeric value of a number token (0 for everything else). */
  readonly number: number;
  /** True for a `text:` string. */
  readonly multiline: boolean;
  readonly pos: SourcePos;
}

export interface LexerLimits {
  /** Longest decoded string (quoted or multi-line), in UTF-16 code units. */
  readonly maxStringLength: number;
}

const QUANTIFIER: Record<string, number> = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
const SPECIALS = new Set(['[', ']', '(', ')', '{', '}', ',', ';']);

function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

export class Lexer {
  private readonly src: string;
  private readonly limits: LexerLimits;
  private i = 0;
  private line = 1;
  private col = 1;

  constructor(src: string, limits: LexerLimits) {
    this.src = src;
    this.limits = limits;
  }

  private get pos(): SourcePos {
    return { line: this.line, column: this.col };
  }

  private advance(): void {
    if (this.src.charCodeAt(this.i) === 0x0a) {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    this.i++;
  }

  private token(kind: TokenKind, text: string, pos: SourcePos, number = 0, multiline = false): Token {
    return { kind, text, number, multiline, pos };
  }

  /** Skip whitespace and comments. */
  private skipTrivia(): void {
    const s = this.src;
    for (;;) {
      const c = s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) {
        this.advance();
      } else if (c === 0x23) {
        // hash-comment: to the end of the line (or of the script)
        while (this.i < s.length && s.charCodeAt(this.i) !== 0x0a) this.advance();
      } else if (c === 0x2f && s.charCodeAt(this.i + 1) === 0x2a) {
        const start = this.pos;
        this.advance();
        this.advance();
        const end = s.indexOf('*/', this.i);
        if (end < 0) throw new SieveSyntaxError('unterminated-comment', 'unterminated /* comment', start);
        while (this.i < end + 2) this.advance();
      } else {
        return;
      }
    }
  }

  next(): Token {
    this.skipTrivia();
    const s = this.src;
    const pos = this.pos;
    if (this.i >= s.length) return this.token('eof', '', pos);
    const ch = s[this.i] as string;
    const c = s.charCodeAt(this.i);

    if (SPECIALS.has(ch)) {
      this.advance();
      return this.token(ch as TokenKind, ch, pos);
    }
    if (c === 0x22) return this.quoted(pos);
    if (c === 0x3a) {
      this.advance();
      if (!isAlpha(s.charCodeAt(this.i))) throw new SieveSyntaxError('bad-char', 'expected a tag name after ":"', pos);
      return this.token('tag', this.identifier(), pos);
    }
    if (isDigit(c)) return this.numberToken(pos);
    if (isAlpha(c)) {
      const name = this.identifier();
      if (name === 'text' && s.charCodeAt(this.i) === 0x3a) {
        this.advance();
        return this.multiline(pos);
      }
      return this.token('identifier', name, pos);
    }
    if (c === 0x2f && s.charCodeAt(this.i + 1) !== 0x2a) {
      throw new SieveSyntaxError('bad-char', 'unexpected "/"', pos);
    }
    const shown = c < 0x20 || c === 0x7f ? `U+${c.toString(16).toUpperCase().padStart(4, '0')}` : JSON.stringify(String.fromCodePoint(s.codePointAt(this.i) ?? c));
    throw new SieveSyntaxError('bad-char', `unexpected character ${shown}`, pos);
  }

  private identifier(): string {
    const s = this.src;
    const start = this.i;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (!isAlpha(c) && !isDigit(c)) break;
      this.advance();
    }
    return s.slice(start, this.i).toLowerCase();
  }

  private numberToken(pos: SourcePos): Token {
    const s = this.src;
    let value = 0;
    while (this.i < s.length && isDigit(s.charCodeAt(this.i))) {
      value = value * 10 + (s.charCodeAt(this.i) - 0x30);
      if (value > Number.MAX_SAFE_INTEGER) throw new SieveSyntaxError('bad-number', 'number is too large', pos);
      this.advance();
    }
    const q = QUANTIFIER[(s[this.i] ?? '').toLowerCase()];
    if (q !== undefined) {
      value *= q;
      this.advance();
      if (value > Number.MAX_SAFE_INTEGER) throw new SieveSyntaxError('bad-number', 'number is too large', pos);
    }
    return this.token('number', String(value), pos, value);
  }

  private checkLength(length: number, pos: SourcePos): void {
    if (length > this.limits.maxStringLength) {
      throw new SieveSyntaxError('string-too-long', `string is longer than ${this.limits.maxStringLength} characters`, pos);
    }
  }

  private quoted(pos: SourcePos): Token {
    const s = this.src;
    this.advance(); // opening quote
    const parts: string[] = [];
    let length = 0;
    let runStart = this.i;
    for (;;) {
      if (this.i >= s.length) throw new SieveSyntaxError('unterminated-string', 'unterminated quoted string', pos);
      const c = s.charCodeAt(this.i);
      if (c === 0x22) {
        parts.push(s.slice(runStart, this.i));
        this.advance();
        break;
      }
      if (c === 0x00) throw new SieveSyntaxError('bad-char', 'NUL is not allowed in a string', this.pos);
      if (c === 0x5c) {
        // RFC 5228 §2.4.2: "\" followed by any character is that character.
        parts.push(s.slice(runStart, this.i));
        this.advance();
        if (this.i >= s.length) throw new SieveSyntaxError('unterminated-string', 'unterminated quoted string', pos);
        if (s.charCodeAt(this.i) === 0x00) throw new SieveSyntaxError('bad-char', 'NUL is not allowed in a string', this.pos);
        parts.push(s[this.i] as string);
        length += 1;
        this.advance();
        runStart = this.i;
        continue;
      }
      length++;
      this.checkLength(length, pos);
      this.advance();
    }
    const value = parts.join('');
    this.checkLength(value.length, pos);
    return this.token('string', value, pos);
  }

  private multiline(pos: SourcePos): Token {
    const s = this.src;
    // text: *(SP / HTAB) (hash-comment / CRLF)
    while (s.charCodeAt(this.i) === 0x20 || s.charCodeAt(this.i) === 0x09) this.advance();
    const c = s.charCodeAt(this.i);
    if (c === 0x23) {
      while (this.i < s.length && s.charCodeAt(this.i) !== 0x0a) this.advance();
    } else if (c === 0x0d && s.charCodeAt(this.i + 1) === 0x0a) {
      this.advance();
    } else if (c !== 0x0a) {
      throw new SieveSyntaxError('unexpected-token', 'expected a line break after "text:"', this.pos);
    }
    if (this.i >= s.length) throw new SieveSyntaxError('unterminated-text', 'unterminated text: string (missing "." line)', pos);
    this.advance(); // the LF

    const lines: string[] = [];
    let length = 0;
    for (;;) {
      if (this.i >= s.length) throw new SieveSyntaxError('unterminated-text', 'unterminated text: string (missing "." line)', pos);
      const nl = s.indexOf('\n', this.i);
      const end = nl < 0 ? s.length : nl;
      let line = s.slice(this.i, end);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.includes('\0')) throw new SieveSyntaxError('bad-char', 'NUL is not allowed in a string', this.pos);
      // consume the line and its break
      this.i = nl < 0 ? s.length : nl + 1;
      this.line += nl < 0 ? 0 : 1;
      this.col = 1;
      if (line === '.') break;
      if (nl < 0) throw new SieveSyntaxError('unterminated-text', 'unterminated text: string (missing "." line)', pos);
      if (line.startsWith('.')) line = line.slice(1); // dot-stuffing
      length += line.length + 2;
      this.checkLength(length, pos);
      lines.push(line);
    }
    const value = lines.map((l) => `${l}\r\n`).join('');
    return this.token('string', value, pos, 0, true);
  }
}
