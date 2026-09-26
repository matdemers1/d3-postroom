// Jazzer.js coverage-guided target for @postroom/sieve (PST-T-9.4 / PST-REQ-088, PST-REQ-148).
//
// The input is a Sieve script, optionally followed by a line `#---message---` and a raw message to
// run it against (otherwise a fixed message is used), so the RFC example scripts in corpus/ are
// meaningful seeds as they are. Invariants:
//   - parse, compile and execute throw nothing but SieveSyntaxError / SieveRuntimeError, and
//     execute throws nothing at all (a runtime error comes back as result.error);
//   - any script that parses prints to a script that parses and prints identically;
//   - execute always returns at least one action, falls back to exactly the implicit keep on a
//     runtime error, and never allows a redirect to an address the account does not own.
// A crasher here becomes a fixture under fuzz/sieve/fixtures before sieve is fixed — see
// docs/runbooks/fuzz-crasher.md.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'packages', 'sieve');
const entry = join(pkg, 'dist', 'index.js');
if (!existsSync(entry)) {
  const tsc = createRequire(join(pkg, 'package.json')).resolve('typescript/bin/tsc');
  // sieve imports @postroom/mime's dist, so build that first.
  const mime = join(pkg, '..', 'mime');
  for (const dir of [mime, pkg]) {
    const built = spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.build.json')], { stdio: 'inherit' });
    if (built.status !== 0) throw new Error('sieve fuzz target: build failed');
  }
}
const { parse, print, compile, execute, messageFromMime, isSieveError } = await import(pathToFileURL(entry).href);

const SEPARATOR = Buffer.from('\n#---message---\n');
const DEFAULT_MESSAGE = Buffer.from(
  'From: Sender <sender@example.org>\r\nTo: me@example.com\r\nCc: team@example.com\r\nSubject: [list] Re: hello *world*\r\n' +
    'List-Id: <list.example.org>\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\n' +
    'the project schedule\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>hi <b>there</b></p>\r\n--b--\r\n',
);
const USER = 'me@example.com';

function allowed(fn) {
  try {
    return fn();
  } catch (err) {
    if (isSieveError(err)) return undefined;
    throw err;
  }
}

/** @param {Buffer} data */
export function fuzz(data) {
  const cut = data.indexOf(SEPARATOR);
  const script = cut < 0 ? data : data.subarray(0, cut);
  const raw = cut < 0 ? DEFAULT_MESSAGE : data.subarray(cut + SEPARATOR.length);

  const ast = allowed(() => parse(script));
  if (ast === undefined) return;

  const printed = print(ast);
  const again = parse(printed, { maxScriptBytes: 16 * 1024 * 1024, maxStringLength: 16 * 1024 * 1024 });
  if (print(again) !== printed) throw new Error('print(parse(print(ast))) differs from print(ast)');

  const compiled = allowed(() => compile(ast));
  if (compiled === undefined) return;

  const message = messageFromMime(raw, { from: 'sender@example.org', to: USER }, { maxPartChars: 64 * 1024, maxRawChars: 64 * 1024 });
  const result = execute(compiled, message, { userAddresses: [USER], maxWork: 500_000, mailboxExists: (m) => m.length % 2 === 0 });
  if (result.actions.length === 0) throw new Error('execute returned no actions');
  if (result.error !== null) {
    if (!isSieveError(result.error)) throw new Error('result.error is not a SieveRuntimeError');
    if (result.actions.length !== 1 || result.actions[0].type !== 'keep' || !result.actions[0].implicit) {
      throw new Error('a runtime error must leave exactly the implicit keep');
    }
  }
  for (const a of result.actions) {
    if (a.type === 'redirect' && a.allowed && a.address.toLowerCase() !== USER) throw new Error(`redirect to ${a.address} was allowed`);
  }
}
