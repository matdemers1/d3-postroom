# The fuzz crasher → fixture workflow

PST-T-4.2; PST-REQ-088: every parser (SMTP, MIME/RFC 5322, IMAP, iCalendar, vCard, Sieve, DMARC
reports) has property tests in CI and a nightly coverage-guided fuzz run whose crashers become
regression fixtures.

## What runs where

| Where | What | When |
|---|---|---|
| `pnpm fuzz:smoke` (`scripts/fuzz-smoke.mjs`) | fast-check smoke burst per parser (`fuzz/<name>/smoke.mjs`, seeded), then `scripts/fuzz-replay.mjs`, then the registry check | every push and PR, as CI's `fuzz-smoke` job |
| `scripts/fuzz-replay.mjs` | replays every file in `fuzz/<name>/fixtures/` through `fuzz/<name>/target.mjs`'s `fuzz()` and fails if any of them crash it again | part of `fuzz:smoke` above |
| `scripts/fuzz-nightly.mjs` | runs `jazzer` against `fuzz/<name>/target.mjs`, coverage-guided, for real, seeded from `fuzz/<name>/corpus/` | nightly cron + manual dispatch, `.github/workflows/fuzz.yml` |

`fuzz/targets.json` is the registry of every parser: `active` rows have a target, a corpus and a
fixtures directory; `pending` rows name the package that has not been built yet (`ical`, `vcard`,
`sieve`, `dmarc-report` via `packages/reports`, and `rfc5322` — RFC 5322 header parsing currently
lives in `packages/mime`). The registry check in `fuzz-smoke.mjs` fails the moment a pending
package grows a `src/` without also growing a harness, so a new parser can't silently ship unfuzzed.

## When the nightly job finds a crash

1. **`fuzz.yml` uploads a `crash-<target>` artifact** (the libFuzzer `crash-<hash>` file jazzer
   wrote) and opens or updates a GitHub issue titled `Fuzz crasher: <target>` linking the run.
2. **Download the artifact** and copy the crash file into `fuzz/<target>/fixtures/`, named for what
   it demonstrates (e.g. `fuzz/mime/fixtures/nested-multipart-depth-bomb.bin`) rather than the raw
   hash — the hash means nothing to the next person who reads this directory.
3. **Add a failing unit test** in the parser's own package (`packages/<pkg>/test/`) that reproduces
   the same crash by reading the fixture file and calling the parser directly. This is the test that
   proves the fix, independent of the fuzz plumbing.
4. **Fix the parser.** You do not own `fuzz/**`'s invariants by editing them away — a crasher is a
   real bug in the parser (an undocumented throw, a hang, an unbounded buffer), not a bug in the
   harness. If the target itself is asserting something wrong, that is a separate, deliberate change
   to the target with its own justification in the commit message.
5. **Confirm both**: `node scripts/fuzz-replay.mjs` passes (the fixture no longer crashes), and the
   new unit test passes.
6. **Commit** the fixture, the unit test and the fix together, citing the task/requirement that
   uncovered it. Close the tracking issue.

## Running a target by hand

```bash
pnpm -r build
node scripts/fuzz-nightly.mjs smtp-proto              # every active target if no name is given
node scripts/fuzz-nightly.mjs smtp-proto --seconds=60
```

A crash lands as `crash-<hash>` in the repo root (jazzer's `artifact_prefix`) and the run continues
to fuzz other targets when run without a target name — check the exit code, not just the log, when
scripting this.

## Adding a harness for a newly built parser (ical, vcard, sieve, reports)

1. Create `fuzz/<name>/target.mjs` exporting `fuzz(data: Buffer)` — see the existing targets for the
   pattern: import the package's *built* `dist/`, drive its parser(s) with a `FuzzedDataProvider`
   over `data`, and throw only when an invariant the parser documents is violated (wrong error
   class, no bound on retained buffer size, an unterminated stream, etc). **No shebang line** — a
   `#!/usr/bin/env node` in a jazzer target breaks its ESM source instrumentation with an opaque
   `SyntaxError: Invalid or unexpected token` and no file name in the trace.
2. Create `fuzz/<name>/corpus/` with a handful of valid and edge-case seed inputs.
3. Create `fuzz/<name>/fixtures/` (empty is fine — a `README.md` explaining the directory is enough
   until the first real crasher lands).
4. Flip the row in `fuzz/targets.json` from `pending: packages/<name> not built` to `active`, adding
   `target`, `corpus` and `fixtures`.
5. Add the target's name to the `matrix.target` list in `.github/workflows/fuzz.yml`.

## Related

PST-T-4.2, PST-REQ-088, PST-P-4.
