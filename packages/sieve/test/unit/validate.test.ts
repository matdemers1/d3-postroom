import { describe, expect, it } from 'vitest';
import { compileScript, SieveSyntaxError, SUPPORTED_EXTENSIONS } from '../../src/index.js';

function reject(src: string): SieveSyntaxError {
  try {
    compileScript(src);
  } catch (err) {
    if (err instanceof SieveSyntaxError) return err;
    throw err;
  }
  throw new Error(`expected ${JSON.stringify(src)} to be rejected`);
}

describe('validation (compile-time errors)', () => {
  const rejected: [string, string, string, number, number][] = [
    ['unknown command', 'frobnicate;', 'unknown-command', 1, 1],
    ['unknown test', 'if frob { keep; }', 'unknown-test', 1, 4],
    ['unsupported extension', 'require "reject";', 'unknown-extension', 1, 9],
    ['fileinto without require', 'fileinto "x";', 'not-required', 1, 1],
    ['envelope without require', 'if envelope "from" "a" { keep; }', 'not-required', 1, 4],
    ['set without variables', 'set "a" "b";', 'not-required', 1, 1],
    ['vacation without require', 'vacation "x";', 'not-required', 1, 1],
    ['body without require', 'if body :contains "x" { keep; }', 'not-required', 1, 4],
    ['bucket without require', 'bucket "news";', 'not-required', 1, 1],
    [':flags without imap4flags', 'keep :flags "x";', 'not-required', 1, 6],
    [':create without mailbox', 'require "fileinto"; fileinto :create "x";', 'not-required', 1, 30],
    ['hasflag variable list without variables', 'require "imap4flags"; if hasflag "v" "x" { keep; }', 'not-required', 1, 34],
    ['require after a command', 'keep; require "fileinto";', 'require-position', 1, 7],
    ['require inside a block', 'if true { require "fileinto"; }', 'require-position', 1, 11],
    ['elsif without if', 'keep; elsif true { keep; }', 'orphan-else', 1, 7],
    ['else after else', 'if true { keep; } else { keep; } else { keep; }', 'orphan-else', 1, 34],
    ['if without block', 'if true;', 'bad-arguments', 1, 1],
    ['if with two tests', 'if (true, false) { keep; }', 'bad-arguments', 1, 1],
    ['keep with a block', 'keep { }', 'bad-arguments', 1, 1],
    ['stop with an argument', 'stop "x";', 'bad-arguments', 1, 6],
    ['discard with a test', 'discard true;', 'bad-arguments', 1, 9],
    ['unknown tag', 'if header :regex "a" "b" { keep; }', 'bad-arguments', 1, 11],
    ['address part on header', 'if header :domain "a" "b" { keep; }', 'bad-arguments', 1, 11],
    ['two match types', 'if header :is :contains "a" "b" { keep; }', 'bad-arguments', 1, 15],
    ['same tag twice', 'if address :all :all "a" "b" { keep; }', 'bad-arguments', 1, 17],
    ['tag after positional', 'if header "a" "b" :is { keep; }', 'bad-arguments', 1, 19],
    [':comparator without a value', 'if header :comparator { keep; }', 'bad-arguments', 1, 11],
    ['unknown comparator', 'if header :comparator "i;ascii-numeric" "a" "b" { keep; }', 'bad-value', 1, 23],
    ['too few arguments', 'if header "a" { keep; }', 'bad-arguments', 1, 4],
    ['too many arguments', 'redirect "a@b.example" "c@d.example";', 'bad-arguments', 1, 24],
    ['string list where a string is needed', 'require "fileinto"; fileinto ["a"];', 'bad-arguments', 1, 30],
    ['number where a string list is needed', 'if header 1 "b" { keep; }', 'bad-arguments', 1, 11],
    ['size without :over/:under', 'if size 10 { keep; }', 'bad-arguments', 1, 4],
    ['size with both', 'if size :over :under 10 { keep; }', 'bad-arguments', 1, 15],
    ['not with a test list', 'if not (true) { keep; }', 'bad-arguments', 1, 4],
    ['anyof without a list', 'if anyof true { keep; }', 'bad-arguments', 1, 4],
    ['true with a nested test', 'if true false { keep; }', 'bad-arguments', 1, 9],
    ['invalid header name', 'if header "Sub ject" "x" { keep; }', 'bad-value', 1, 11],
    ['header name with a colon', 'if exists "a:b" { keep; }', 'bad-value', 1, 11],
    ['unknown envelope part', 'require "envelope"; if envelope "auth" "x" { keep; }', 'bad-value', 1, 33],
    ['invalid redirect address', 'redirect "not an address";', 'bad-value', 1, 10],
    ['invalid variable name', 'require "variables"; set "1abc" "x";', 'bad-value', 1, 26],
    ['namespaced variable name', 'require "variables"; set "a.b" "x";', 'bad-value', 1, 26],
    ['two case modifiers', 'require "variables"; set :lower :upper "a" "x";', 'bad-arguments', 1, 33],
    ['invalid bucket name', 'require "vnd.postroom.bucket"; bucket "../etc";', 'bad-value', 1, 39],
    ['empty bucket name', 'require "vnd.postroom.bucket"; bucket "";', 'bad-value', 1, 39],
    ['empty mailbox', 'require "fileinto"; fileinto "";', 'bad-value', 1, 30],
    ['vacation :days without a number', 'require "vacation"; vacation :days "x" "r";', 'bad-arguments', 1, 36],
    ['vacation :from not an address', 'require "vacation"; vacation :from "nobody" "r";', 'bad-value', 1, 36],
  ];
  for (const [name, src, code, line, column] of rejected) {
    it(`${name}: ${code} at ${line}:${column}`, () => {
      const err = reject(src);
      expect(err.code).toBe(code);
      expect([err.line, err.column]).toEqual([line, column]);
    });
  }

  it('accepts every supported extension, and comparators without require', () => {
    const script = compileScript(`require ${JSON.stringify(SUPPORTED_EXTENSIONS)};
      if header :comparator "i;octet" :contains "a" "b" { keep; }
      if address :comparator "i;ascii-casemap" :localpart :matches "to" "x*" { keep; }`);
    expect(script.capabilities).toEqual([...SUPPORTED_EXTENSIONS]);
  });

  it('tagged arguments may come in any order', () => {
    expect(() => compileScript('if address :matches :domain :comparator "i;octet" "to" "*" { keep; }')).not.toThrow();
    expect(() => compileScript('require "vacation"; vacation :mime :handle "h" :days 3 :subject "s" :from "a@b.example" :addresses ["x@y.example"] "r";')).not.toThrow();
  });

  it('literal checks are skipped for strings that expand at run time', () => {
    expect(() => compileScript('require ["variables", "envelope"]; if envelope "${part}" "x" { redirect "${to}"; }')).not.toThrow();
    // …but not when variables is not required: then "${" is just text.
    expect(reject('require "envelope"; if envelope "${part}" "x" { keep; }').code).toBe('bad-value');
  });

  it('the vacation :from may be a name-addr', () => {
    expect(() => compileScript('require "vacation"; vacation :from "Me <me@example.com>" "away";')).not.toThrow();
  });
});
