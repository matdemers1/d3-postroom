import { describe, expect, it } from 'vitest';
import { parse, print, SieveSyntaxError, type Argument, type CommandNode } from '../../src/index.js';

function first(src: string): CommandNode {
  const c = parse(src).commands[0];
  if (c === undefined) throw new Error('no command');
  return c;
}

function args(src: string): Argument[] {
  return [...first(src).args];
}

function syntaxError(src: string | Uint8Array, limits = {}): SieveSyntaxError {
  try {
    parse(src, limits);
  } catch (err) {
    if (err instanceof SieveSyntaxError) return err;
    throw err;
  }
  throw new Error(`expected a SieveSyntaxError for ${JSON.stringify(src)}`);
}

describe('lexer', () => {
  it('numbers with K, M and G quantifiers (either case)', () => {
    const a = args('x 0 7 1K 2m 3G;');
    expect(a.map((x) => (x.type === 'number' ? x.value : null))).toEqual([0, 7, 1024, 2 * 1024 * 1024, 3 * 1024 ** 3]);
  });

  it('rejects numbers past 2^53', () => {
    expect(syntaxError('x 99999999999999999999;').code).toBe('bad-number');
    expect(syntaxError('x 9999999999999G;').code).toBe('bad-number');
  });

  it('quoted strings: backslash escapes any character, CRLF allowed inside', () => {
    const [a] = args('x "a\\"b\\\\c\\d\r\ne";');
    expect(a).toMatchObject({ type: 'string', value: 'a"b\\cd\r\ne' });
  });

  it('identifiers and tags are case-insensitive', () => {
    const c = first('KeEp :FLAGS "x";');
    expect(c.name).toBe('keep');
    expect(c.args[0]).toMatchObject({ type: 'tag', name: 'flags' });
  });

  it('both comment forms', () => {
    const script = parse('# hash\nkeep; /* bracket\n * comment */ discard; # trailing without newline');
    expect(script.commands.map((c) => c.name)).toEqual(['keep', 'discard']);
  });

  it('multi-line strings: comment after text:, dot-stuffing, CRLF or LF', () => {
    const [a] = args('x text: # a comment\r\nline 1\r\n..line 2\r\n.\r\n;');
    expect(a).toMatchObject({ type: 'string', multiline: true, value: 'line 1\r\n.line 2\r\n' });
    const [b] = args('x text:\nfoo\n.\n;');
    expect(b).toMatchObject({ value: 'foo\r\n' });
    const [c] = args('x TEXT:\n.\n;');
    expect(c).toMatchObject({ value: '' });
  });

  it('string lists', () => {
    const [a] = args('x ["a", "b" ,"c"];');
    expect(a).toMatchObject({ type: 'list', values: ['a', 'b', 'c'] });
  });

  it('a BOM is ignored and bytes must be UTF-8', () => {
    expect(parse('﻿keep;').commands).toHaveLength(1);
    expect(parse(Buffer.from('keep; # é')).commands).toHaveLength(1);
    expect(syntaxError(Buffer.from([0x6b, 0x65, 0x65, 0x70, 0x3b, 0x23, 0xff])).code).toBe('bad-char');
  });
});

describe('errors name the line and column', () => {
  const cases: [string, string, number, number][] = [
    ['keep', 'unexpected-token', 1, 5],
    ['if true {\n  keep;\n', 'unexpected-token', 3, 1],
    ['keep;\n  "x";', 'unexpected-token', 2, 3],
    ['keep;\nfileinto "a;\n', 'unterminated-string', 2, 10],
    ['keep; /* open', 'unterminated-comment', 1, 7],
    ['x text:\nabc\n', 'unterminated-text', 1, 3],
    ['x text: junk\n.\n;', 'unexpected-token', 1, 9],
    ['keep;\n\n   @', 'bad-char', 3, 4],
    ['x : y;', 'bad-char', 1, 3],
    ['x ["a" "b"];', 'unexpected-token', 1, 8],
    ['x [];', 'unexpected-token', 1, 4],
    ['if anyof (true, ) {}', 'unexpected-token', 1, 17],
    ['if anyof () {}', 'unexpected-token', 1, 11],
    ['x "a\0";', 'bad-char', 1, 5],
    ['keep; }', 'unexpected-token', 1, 7],
  ];
  for (const [src, code, line, column] of cases) {
    it(`${JSON.stringify(src)} -> ${code} at ${line}:${column}`, () => {
      const err = syntaxError(src);
      expect(err.code).toBe(code);
      expect([err.line, err.column]).toEqual([line, column]);
      expect(err.message).toBe(`line ${line}, column ${column}: ${err.detail}`);
    });
  }
});

describe('limits', () => {
  it('script size', () => {
    expect(syntaxError('keep;'.repeat(100), { maxScriptBytes: 100 }).code).toBe('too-large');
    expect(syntaxError(Buffer.alloc(200, 0x20), { maxScriptBytes: 100 }).code).toBe('too-large');
  });

  it('nesting depth, blocks and tests alike — never a stack overflow', () => {
    const blocks = `${'if true {'.repeat(40)}${'}'.repeat(40)}`;
    expect(syntaxError(blocks).code).toBe('too-deep');
    const tests = `if ${'not '.repeat(100_000)}true {}`;
    expect(syntaxError(tests, { maxScriptBytes: 1024 * 1024 }).code).toBe('too-deep');
    const lists = `if ${'anyof('.repeat(50_000)}true${')'.repeat(50_000)} {}`;
    expect(syntaxError(lists, { maxScriptBytes: 1024 * 1024 }).code).toBe('too-deep');
    expect(parse(`${'if true {'.repeat(31)}${'}'.repeat(31)}`).commands).toHaveLength(1);
  });

  it('string length', () => {
    expect(syntaxError(`x "${'a'.repeat(101)}";`, { maxStringLength: 100 }).code).toBe('string-too-long');
    expect(syntaxError(`x text:\n${'a'.repeat(101)}\n.\n;`, { maxStringLength: 100 }).code).toBe('string-too-long');
  });

  it('list length and argument count', () => {
    expect(syntaxError(`x [${Array(11).fill('"a"').join(',')}];`, { maxListLength: 10 }).code).toBe('list-too-long');
    expect(syntaxError(`x ${'1 '.repeat(11)};`, { maxArguments: 10 }).code).toBe('bad-arguments');
  });
});

describe('printer', () => {
  it('prints a canonical script that parses back to the same tree', () => {
    const src = 'require ["fileinto"];\nif anyof (not exists "x", header :is "a" ["b", "c\\"d"]) { fileinto "x"; } elsif true { stop; } else { keep; }';
    const ast = parse(src);
    const printed = print(ast);
    expect(printed).toBe(
      'require ["fileinto"];\nif anyof (not exists "x", header :is "a" ["b", "c\\"d"]) {\n  fileinto "x";\n}\nelsif true {\n  stop;\n}\nelse {\n  keep;\n}\n',
    );
    expect(print(parse(printed))).toBe(printed);
  });
});
