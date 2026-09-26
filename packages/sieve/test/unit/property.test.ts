// PST-REQ-088 properties: the parser, validator and interpreter only ever throw their own error
// classes, the printer round-trips, and :matches agrees with a reference implementation.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compile, execute, globMatch, isSieveError, parse, print, type Argument, type CommandNode, type ScriptNode, type TestNode } from '../../src/index.js';
import { message } from './helpers.js';

const free = { charge: () => undefined };
const msg = message({ headers: { Subject: 'Re: [list] hello *world*', 'List-Id': '<l.example>' }, body: 'Body with project schedule\r\n' });

const identifier = fc.stringMatching(/^[a-z_][a-z0-9_]{0,8}$/);
const anyString = fc.string({ maxLength: 20, unit: 'grapheme' }).map((s) => s.replace(/\0/g, ''));
const TOKENS = [
  'require', '"fileinto"', '"variables"', '"imap4flags"', '"vacation"', '"body"', '"envelope"', '"mailbox"', '"vnd.postroom.bucket"',
  '[', ']', '(', ')', '{', '}', ',', ';', ' ', '\n', '\r\n', '#c\n', '/* x */', 'text:\n', '\n.\n', '..', '"', '\\', '${', '}', '${1}', '*', '?',
  'if', 'elsif', 'else', 'anyof', 'allof', 'not', 'true', 'false', 'header', 'address', 'envelope', 'exists', 'size', 'body', 'string', 'hasflag',
  'keep', 'discard', 'stop', 'redirect', 'fileinto', 'set', 'setflag', 'addflag', 'removeflag', 'vacation', 'bucket', 'mailboxexists',
  ':is', ':contains', ':matches', ':comparator', '"i;octet"', '"i;ascii-casemap"', ':all', ':localpart', ':domain', ':over', ':under',
  ':raw', ':text', ':content', ':flags', ':create', ':lower', ':upper', ':length', ':quotewildcard', ':days', ':subject', ':from', ':addresses', ':mime', ':handle',
  '"subject"', '"from"', '"to"', '"*"', '"x@y.example"', '"a"', '""', '1', '10K', '2M', '"${a}"', '"\\\\Seen"',
];
const sieveish = fc.array(fc.oneof({ weight: 5, arbitrary: fc.constantFrom(...TOKENS) }, { weight: 1, arbitrary: fc.string({ maxLength: 6 }) }), { maxLength: 60 }).map((t) => t.join(' '));

function allowedOnly(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    if (!isSieveError(err)) throw err;
  }
}

describe('never throws anything but SieveSyntaxError/SieveRuntimeError', () => {
  it('arbitrary strings and bytes', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 200 }), sieveish, fc.uint8Array({ maxLength: 200 })), (src) => {
        allowedOnly(() => {
          const script = compile(parse(src));
          const result = execute(script, msg, { userAddresses: ['me@example.com'], maxWork: 200_000 });
          expect(result.actions.length).toBeGreaterThan(0);
        });
      }),
      { numRuns: 3000 },
    );
  });
});

const REQUIRE = 'require ["fileinto", "envelope", "imap4flags", "variables", "body", "vacation", "mailbox", "vnd.postroom.bucket"];\n';
const val = fc.constantFrom('"a"', '"*"', '"${1}"', '"${x}"', '"x@y.example"', '"me@example.com"', '["a", "b*"]', '""', '"\\\\Seen"', '"news"');
const mt = fc.constantFrom('', ':is', ':contains', ':matches', ':comparator "i;octet" :matches');
const validTest: fc.Arbitrary<string> = fc.letrec<{ t: string }>((tie) => ({
  t: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.constantFrom('true', 'false', 'size :over 1K', 'size :under 10', 'exists "subject"', 'body :raw :contains "project"', 'body :content "text" :contains "x"'),
    fc.tuple(mt, fc.constantFrom('"subject"', '["from", "to"]', '"list-id"'), val).map(([m, h, k]) => `header ${m} ${h} ${k}`),
    fc.tuple(mt, fc.constantFrom(':all', ':localpart', ':domain'), val).map(([m, p, k]) => `address ${p} ${m} ["from", "to"] ${k}`),
    fc.tuple(mt, val).map(([m, k]) => `envelope ${m} "from" ${k}`),
    fc.tuple(mt, val, val).map(([m, a, b]) => `string ${m} ${a} ${b}`),
    fc.tuple(mt, val).map(([m, k]) => `hasflag ${m} ${k}`),
    tie('t').map((t) => `not ${t}`),
    fc.array(tie('t'), { minLength: 1, maxLength: 3 }).map((ts) => `anyof (${ts.join(', ')})`),
    fc.array(tie('t'), { minLength: 1, maxLength: 3 }).map((ts) => `allof (${ts.join(', ')})`),
  ),
})).t;
const simpleCommand = fc.oneof(
  fc.constantFrom('keep;', 'discard;', 'stop;', 'keep :flags "\\\\Seen";'),
  val.filter((v) => !v.startsWith('[') && v !== '""').map((v) => `fileinto :create ${v};`),
  val.map((v) => `redirect "x@y.example"; set "x" ${v.startsWith('[') ? '"l"' : v};`),
  val.map((v) => `addflag ${v}; removeflag "a"; setflag "v" ${v};`),
  fc.constantFrom('set :upper :length "x" "${1}";', 'bucket "news";', 'bucket "${x}";', 'vacation :days 3 :subject "${1}" "away";', 'vacation "a"; vacation "b";'),
);
const validScript = fc
  .array(fc.oneof(simpleCommand, fc.tuple(validTest, fc.array(simpleCommand, { maxLength: 3 })).map(([t, cs]) => `if ${t} { ${cs.join(' ')} } else { keep; }`)), { maxLength: 8 })
  .map((cs) => REQUIRE + cs.join('\n'));

describe('valid scripts', () => {
  it('compile, and execute never throws — at most it reports a SieveRuntimeError', () => {
    fc.assert(
      fc.property(validScript, (src) => {
        const result = execute(compile(parse(src)), msg, { userAddresses: ['me@example.com'], maxWork: 200_000 });
        expect(result.actions.length).toBeGreaterThan(0);
        if (result.error !== null) expect(result.actions).toEqual([{ type: 'keep', mailbox: 'INBOX', flags: null, implicit: true, line: 0 }]);
        if (result.implicitKeep) expect(result.actions.at(-1)).toMatchObject({ type: 'keep', implicit: true });
        expect(result.actions.filter((a) => a.type === 'redirect' && a.allowed)).toEqual([]);
      }),
      { numRuns: 2000 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Printer round trip over generated trees

const arg: fc.Arbitrary<Argument> = fc.oneof(
  identifier.map((name) => ({ type: 'tag' as const, name, pos: { line: 0, column: 0 } })),
  fc.nat({ max: 2 ** 40 }).map((value) => ({ type: 'number' as const, value, pos: { line: 0, column: 0 } })),
  anyString.map((value) => ({ type: 'string' as const, value, multiline: false, pos: { line: 0, column: 0 } })),
  fc.array(anyString, { minLength: 1, maxLength: 4 }).map((values) => ({ type: 'list' as const, values, pos: { line: 0, column: 0 } })),
);

const { test: testArb } = fc.letrec<{ test: TestNode }>((tie) => ({
  test: fc
    .record({
      name: identifier,
      args: fc.array(arg, { maxLength: 4 }),
      nested: fc.oneof({ depthSize: 'small' }, fc.constant(null), fc.array(tie('test'), { minLength: 1, maxLength: 3 })),
      single: fc.boolean(),
    })
    .map(({ name, args, nested, single }): TestNode => {
      const tests = nested === null ? [] : single ? nested.slice(0, 1) : nested;
      return { type: 'test', name, args, tests, testList: nested !== null && !single, pos: { line: 0, column: 0 } };
    }),
}));

const { command: commandArb } = fc.letrec<{ command: CommandNode }>((tie) => ({
  command: fc
    .record({
      name: identifier,
      args: fc.array(arg, { maxLength: 4 }),
      tests: fc.oneof(fc.constant([] as TestNode[]), fc.array(testArb, { minLength: 1, maxLength: 3 })),
      single: fc.boolean(),
      block: fc.oneof({ depthSize: 'small' }, fc.constant(null), fc.array(tie('command'), { maxLength: 3 })),
    })
    .map(({ name, args, tests, single, block }): CommandNode => {
      const t = single ? tests.slice(0, 1) : tests;
      return { type: 'command', name, args, tests: t, testList: t.length > 0 && !single, block, pos: { line: 0, column: 0 } };
    }),
}));

/** Positions and the quoted/multi-line distinction are presentation, not structure. */
function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (k !== 'pos' && k !== 'multiline') out[k] = strip(v);
    return out;
  }
  return node;
}

describe('printer', () => {
  it('parse(print(ast)) equals ast', () => {
    fc.assert(
      fc.property(fc.array(commandArb, { maxLength: 5 }), (commands) => {
        const ast: ScriptNode = { type: 'script', commands };
        expect(strip(parse(print(ast), { maxDepth: 1000 }))).toEqual(strip(ast));
      }),
      { numRuns: 500 },
    );
  });

  it('any script that parses prints to one that parses to the same tree', () => {
    fc.assert(
      fc.property(sieveish, (src) => {
        let ast: ScriptNode;
        try {
          ast = parse(src);
        } catch (err) {
          if (isSieveError(err)) return;
          throw err;
        }
        expect(strip(parse(print(ast)))).toEqual(strip(ast));
      }),
      { numRuns: 2000 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// :matches against a reference

function reference(text: string, pattern: string): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '\\' && i + 1 < pattern.length) re += (pattern[++i] as string).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    else if (c === '*') re += '[\\s\\S]*?';
    else if (c === '?') re += '[\\s\\S]';
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`${re}$`, 'u').test(text);
}

describe(':matches', () => {
  const alpha = fc.string({ unit: fc.constantFrom('a', 'b', '*', '?', '\\', '.'), maxLength: 12 });
  it('agrees with a regex reference', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('a', 'b', '*', '?', '.'), maxLength: 12 }), alpha, (text, pattern) => {
        expect(globMatch(text, pattern, free) !== null).toBe(reference(text, pattern));
      }),
      { numRuns: 5000 },
    );
  });

  it('captures reassemble the text', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('a', 'b', '.'), maxLength: 12 }), fc.string({ unit: fc.constantFrom('a', 'b', '.', '*', '?'), maxLength: 8 }), (text, pattern) => {
        const caps = globMatch(text, pattern, free);
        if (caps === null) return;
        let wild = 1;
        let rebuilt = '';
        for (const c of pattern) rebuilt += c === '*' || c === '?' ? (caps[wild++] as string) : c;
        expect(rebuilt).toBe(text);
      }),
      { numRuns: 3000 },
    );
  });

  it(':quotewildcard output always matches its input literally', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        const quoted = s.replace(/[*?\\]/g, (c) => `\\${c}`);
        expect(globMatch(s, quoted, free)).toEqual([s]);
      }),
    );
  });
});
