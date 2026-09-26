// RFC 5228 §8.2 grammar, recursive descent:
//
//   start     = commands
//   commands  = *command
//   command   = identifier arguments (";" / block)
//   block     = "{" commands "}"
//   arguments = *argument [ test / test-list ]
//   argument  = string-list / number / tag
//   test      = identifier arguments
//   test-list = "(" test *("," test) ")"
//   string-list = "[" string *("," string) "]" / string
//
// Bounded: the script size, the nesting depth (blocks and tests share one counter, so recursion can
// never outgrow the JS stack), string length and list length are all capped, and every rejection is
// a SieveSyntaxError naming its line and column.

import type { Argument, CommandNode, ScriptNode, TestNode } from './ast.js';
import { SieveSyntaxError } from './errors.js';
import { Lexer, type Token, type TokenKind } from './lexer.js';

export interface ParseLimits {
  /** Largest script accepted, in UTF-8 bytes (default 256 KiB). */
  readonly maxScriptBytes?: number;
  /** Deepest nesting of blocks and tests combined (default 32). */
  readonly maxDepth?: number;
  /** Longest string, in characters (default 64 KiB). */
  readonly maxStringLength?: number;
  /** Most strings in one string list (default 1024). */
  readonly maxListLength?: number;
  /** Most arguments on one command or test (default 64). */
  readonly maxArguments?: number;
}

export const DEFAULT_LIMITS: Required<ParseLimits> = {
  maxScriptBytes: 256 * 1024,
  maxDepth: 32,
  maxStringLength: 64 * 1024,
  maxListLength: 1024,
  maxArguments: 64,
};

const utf8 = new TextDecoder('utf-8', { fatal: true });

function describe(t: Token): string {
  switch (t.kind) {
    case 'eof':
      return 'end of script';
    case 'identifier':
      return `identifier "${t.text}"`;
    case 'tag':
      return `tag ":${t.text}"`;
    case 'number':
      return `number ${t.text}`;
    case 'string':
      return 'a string';
    default:
      return `"${t.kind}"`;
  }
}

class Parser {
  private readonly lexer: Lexer;
  private readonly limits: Required<ParseLimits>;
  private tok: Token;

  constructor(src: string, limits: Required<ParseLimits>) {
    this.limits = limits;
    this.lexer = new Lexer(src, limits);
    this.tok = this.lexer.next();
  }

  /** The current token's kind (a method, so TypeScript does not narrow it across a shift). */
  private peek(): TokenKind {
    return this.tok.kind;
  }

  private shift(): Token {
    const t = this.tok;
    this.tok = this.lexer.next();
    return t;
  }

  private expect(kind: TokenKind, what: string): Token {
    if (this.tok.kind !== kind) {
      throw new SieveSyntaxError('unexpected-token', `expected ${what}, found ${describe(this.tok)}`, this.tok.pos);
    }
    return this.shift();
  }

  private enter(depth: number): void {
    if (depth > this.limits.maxDepth) {
      throw new SieveSyntaxError('too-deep', `nesting deeper than ${this.limits.maxDepth} levels`, this.tok.pos);
    }
  }

  script(): ScriptNode {
    const commands = this.commands(0);
    if (this.tok.kind !== 'eof') {
      throw new SieveSyntaxError('unexpected-token', `expected a command, found ${describe(this.tok)}`, this.tok.pos);
    }
    return { type: 'script', commands };
  }

  private commands(depth: number): CommandNode[] {
    const out: CommandNode[] = [];
    while (this.tok.kind === 'identifier') out.push(this.command(depth));
    return out;
  }

  private command(depth: number): CommandNode {
    const id = this.shift();
    const { args, tests, testList } = this.arguments(depth);
    let block: CommandNode[] | null = null;
    if (this.tok.kind === '{') {
      this.enter(depth + 1);
      this.shift();
      block = this.commands(depth + 1);
      this.expect('}', '"}" or a command');
    } else if (this.tok.kind === ';') {
      this.shift();
    } else {
      throw new SieveSyntaxError('unexpected-token', `expected ";" or "{" after ${id.text}, found ${describe(this.tok)}`, this.tok.pos);
    }
    return { type: 'command', name: id.text, args, tests, testList, block, pos: id.pos };
  }

  private arguments(depth: number): { args: Argument[]; tests: TestNode[]; testList: boolean } {
    const args: Argument[] = [];
    for (;;) {
      const arg = this.argument();
      if (arg === null) break;
      args.push(arg);
      if (args.length > this.limits.maxArguments) {
        throw new SieveSyntaxError('bad-arguments', `more than ${this.limits.maxArguments} arguments`, arg.pos);
      }
    }
    if (this.tok.kind === 'identifier') {
      this.enter(depth + 1);
      return { args, tests: [this.test(depth + 1)], testList: false };
    }
    if (this.tok.kind === '(') {
      this.enter(depth + 1);
      this.shift();
      const tests = [this.test(depth + 1)];
      while (this.peek() === ',') {
        this.shift();
        tests.push(this.test(depth + 1));
        if (tests.length > this.limits.maxListLength) {
          throw new SieveSyntaxError('list-too-long', `more than ${this.limits.maxListLength} tests in a test list`, this.tok.pos);
        }
      }
      this.expect(')', '"," or ")" in the test list');
      return { args, tests, testList: true };
    }
    return { args, tests: [], testList: false };
  }

  private argument(): Argument | null {
    const t = this.tok;
    switch (t.kind) {
      case 'tag':
        this.shift();
        return { type: 'tag', name: t.text, pos: t.pos };
      case 'number':
        this.shift();
        return { type: 'number', value: t.number, pos: t.pos };
      case 'string':
        this.shift();
        return { type: 'string', value: t.text, multiline: t.multiline, pos: t.pos };
      case '[': {
        this.shift();
        const values = [this.expect('string', 'a string in the string list').text];
        while (this.peek() === ',') {
          this.shift();
          values.push(this.expect('string', 'a string after ","').text);
          if (values.length > this.limits.maxListLength) {
            throw new SieveSyntaxError('list-too-long', `more than ${this.limits.maxListLength} strings in a list`, this.tok.pos);
          }
        }
        this.expect(']', '"," or "]" in the string list');
        return { type: 'list', values, pos: t.pos };
      }
      default:
        return null;
    }
  }

  private test(depth: number): TestNode {
    const id = this.expect('identifier', 'a test');
    const { args, tests, testList } = this.arguments(depth);
    return { type: 'test', name: id.text, args, tests, testList, pos: id.pos };
  }
}

/** Resolve caller limits against the defaults. */
export function resolveLimits(limits: ParseLimits = {}): Required<ParseLimits> {
  return { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined)) };
}

/**
 * Parse a Sieve script into its syntax tree. Accepts a string or UTF-8 bytes. Throws only
 * SieveSyntaxError.
 */
export function parse(source: string | Uint8Array, limits: ParseLimits = {}): ScriptNode {
  const lim = resolveLimits(limits);
  const origin = { line: 1, column: 1 };
  let src: string;
  if (typeof source === 'string') {
    if (Buffer.byteLength(source, 'utf8') > lim.maxScriptBytes) {
      throw new SieveSyntaxError('too-large', `script is larger than ${lim.maxScriptBytes} bytes`, origin);
    }
    src = source;
  } else {
    if (source.length > lim.maxScriptBytes) throw new SieveSyntaxError('too-large', `script is larger than ${lim.maxScriptBytes} bytes`, origin);
    try {
      src = utf8.decode(source);
    } catch {
      throw new SieveSyntaxError('bad-char', 'script is not valid UTF-8', origin);
    }
  }
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1); // a BOM from a Windows editor
  return new Parser(src, lim).script();
}
