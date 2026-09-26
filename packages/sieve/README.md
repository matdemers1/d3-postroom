# @postroom/sieve

A hand-rolled Sieve implementation (RFC 5228) for Postroom's `sieve` delivery stage (PST-REQ-148),
with a lexer, parser, validator, printer and interpreter. There is no Sieve library underneath.
Messages are read through `@postroom/mime`.

## API

```ts
import { compileScript, execute, messageFromMime, SieveSyntaxError } from '@postroom/sieve';

const script = compileScript(source);            // parse + validate; throws SieveSyntaxError
const message = messageFromMime(raw, { from: 'alice@example.org', to: 'me@d3cloud.io' });
const result = execute(script, message, {
  userAddresses: ['me@d3cloud.io'],               // vacation's "addressed to me"; default redirect policy
  vacationStore,                                  // once-per-sender state (see below)
});
// result.actions: keep / fileinto / discard / redirect / vacation, in order, the implicit keep last
// result.bucket:  set by vnd.postroom.bucket, or null
// result.error:   a SieveRuntimeError, or null (on an error, actions is just the implicit keep)
// result.trace:   what ran and what each test decided, with line and column
```

- `parse(source, limits)` returns the syntax tree, `compile(ast)` turns it into the typed program,
  and `print(ast)` prints canonical source that parses back to the same tree.
- **Errors.** Compile-time problems throw `SieveSyntaxError` with `code`, `line`, `column` and
  `detail`; the message reads `line 3, column 7: expected ";" …`. That is what ManageSieve's
  `PUTSCRIPT`/`CHECKSCRIPT` should return. `execute` never throws for anything a script or a
  message can do. Nothing in the package throws any other error class, which the property tests
  and the fuzz target (`fuzz/sieve/target.mjs`) both assert.
- **Limits** (`ParseLimits`): script size (256 KiB), nesting depth across blocks and tests (32),
  string length (64 KiB), strings per list (1024) and arguments per command (64). At run time,
  `ExecuteOptions` caps work units (5,000,000), actions (64), distinct redirects (4), expanded or
  variable string length (64 KiB) and trace entries (500). Going over a run-time cap is a
  `SieveRuntimeError`, and the message falls back to the implicit keep.
- **`SieveMessage`** is an interface. The worker can implement it over what its parse stage
  already holds. `messageFromMime` is a convenience for raw bytes that caps each decoded part.

## Supported

| Capability | RFC | Notes |
|---|---|---|
| core | 5228 | `require`, `if`/`elsif`/`else`, `stop`, `keep`, `discard`, `redirect`; tests `address`, `allof`, `anyof`, `exists`, `false`, `header`, `not`, `size`, `true` |
| comparators | 4790 | `i;octet`, `i;ascii-casemap` (the default). Neither needs a `require` |
| match types | 5228 | `:is`, `:contains`, `:matches` (`*`, `?`, and `\` to escape) |
| `fileinto` | 5228 | |
| `envelope` | 5228 §5.4 | parts `from` and `to`; the null sender is `""` |
| `imap4flags` | 5232 | `setflag`/`addflag`/`removeflag` (with an optional variable name when `variables` is required), `hasflag`, `:flags` on `keep`/`fileinto`; the internal flag set rides on the implicit keep |
| `variables` | 5229 | `set` with `:lower :upper :lowerfirst :upperfirst :quotewildcard :length`, `${name}` and `${N}` match variables, the `string` test |
| `body` | 5173 | `:raw` (undecoded), `:content <types>` (decoded leaf parts; `""` matches all, `"text"` matches `text/*`), `:text` (the default: decoded non-attachment `text/*` parts, HTML tags removed) |
| `vacation` | 5230 | `:days :subject :from :addresses :mime :handle` |
| `mailbox` | 5490 | `fileinto :create`, `mailboxexists` (through `ExecuteOptions.mailboxExists`) |
| `vnd.postroom.bucket` | Postroom | below |

## Semantics worth knowing

- **Implicit keep.** `keep`, `fileinto`, `discard` and an *allowed* `redirect` cancel it. Vacation,
  the flag commands, `bucket` and a *refused* redirect do not, because a refused redirect must
  never lose the message. `discard` only cancels the implicit keep: an explicit `keep` or
  `fileinto` still happens.
- **Duplicates.** `keep` is `fileinto` the inbox. Filing into the same mailbox twice files it once
  with the flag sets merged, and redirecting to the same address twice redirects once.
- **Redirect policy (PST-REQ-053, no relay).** A redirect is recorded with `allowed: false` and a
  reason unless `ownsAddress(address)` returns true. The default is membership in `userAddresses`.
  The interpreter records what should happen and never performs an action itself.
- **Vacation.** The action is recorded with `respond: true`, or `respond: false` and a
  `suppressed` reason. Replies are suppressed for a null sender, `owner-*`, `*-request`,
  `MAILER-DAEMON` and similar senders, `Auto-Submitted` other than `no`, `List-*` or
  `Precedence: bulk/list/junk` headers, mail from the account itself, mail where none of the
  account's addresses (`userAddresses`, `:addresses`, the envelope recipient) appears in
  To/Cc/Bcc/Resent-*, and a sender the `VacationStore` says already got a reply with this handle
  within `:days`. `:days` defaults to 7 and is clamped to `[minVacationDays, maxVacationDays]`
  (1 to 30). Without `:handle`, the handle is a hash of the reason, `:subject`, `:from` and
  `:mime`. The caller records a sent reply in its store. Running `vacation` twice in one execution
  is a runtime error.
- **`address`** only looks at address headers (From, To, Cc, Bcc, Sender, Reply-To, Resent-*,
  Return-Path, Delivered-To and similar). Any other header never matches.
- **`:matches` captures** use the shortest match for each wildcard, working left to right. This is
  what RFC 5229's own `"[*] *"` example requires.

## `vnd.postroom.bucket`

Postroom's inbox sorts itself into buckets, which are real IMAP folders. This extension lets a
script choose the bucket.

```
require "vnd.postroom.bucket";
bucket <name: string>
```

- `name` is 1 to 64 characters from letters, digits, space, `_`, `.` and `-`, and starts with a
  letter or digit (`/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/`). A literal that does not fit is a
  compile-time error. A name built from variables that does not fit is a runtime error, and the
  message falls back to the implicit keep.
- `bucket` is not a delivery action. It sets `result.bucket`, and when it runs more than once the
  last one wins. It does not cancel the implicit keep and does not conflict with any other action.
  The worker's sort stage decides what a bucket means for the delivery: a `keep` (implicit or
  explicit) lands in the chosen bucket instead of the classifier's choice, and the trace records
  why.
- With `variables`, the name is expanded like any other string:

```
require ["vnd.postroom.bucket", "variables"];
if header :contains "List-Unsubscribe" "" { bucket "newsletters"; }
if address :domain :matches "from" "*.shop.example" { set "b" "receipts"; bucket "${b}"; }
```

## Tests

- `test/fixtures/rfc/*.sieve` holds the example scripts from RFC 5228, 5229, 5230, 5232, 5173 and
  5490, plus the bucket example above. `test/unit/rfc.test.ts` runs each one against messages that
  take every branch and checks the resulting actions. This is PST-REQ-148's acceptance.
- Parser, validator and interpreter unit tests cover every error code with its line and column.
- fast-check properties: nothing but the two Sieve error classes is ever thrown, generated valid
  scripts always execute to a safe result, `parse(print(ast))` round-trips, and `:matches` agrees
  with a regex reference.
- Fuzzing: `fuzz/sieve/target.mjs` runs nightly under Jazzer.js, seeded from these fixtures
  (PST-REQ-088).
