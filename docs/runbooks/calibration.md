# Golden replay and private calibration

PST-T-5.5; PST-REQ-107 (the committed synthetic golden set gates CI); PST-REQ-108 (a gitignored
local calibration corpus is supported and never committed).

## What runs where

| Where | What | When |
|---|---|---|
| `pnpm --filter @postroom/classifier test` → `packages/classifier/test/golden/replay.test.ts` | replays every message in `fixtures/golden/` through the classifier and fails if any bucket's precision or recall drops below `fixtures/golden/thresholds.json` | every push and PR, CI's unit stage (see `needsOutside` below for wiring `check:corpus` into the same job) |
| `node scripts/golden/replay.mjs` | the same replay, run by hand; `--json` for machine output, `--write-thresholds` to bootstrap/update the recorded floors | ad hoc, and by the test above |
| `node scripts/golden/calibrate.mjs [corpusDir]` | the same engine against a local, gitignored corpus of real mail (`corpus/` by default, or `$POSTROOM_CORPUS`) — prints metrics only, writes nothing, never fails the build | ad hoc, by an operator with a real mailbox to calibrate against |
| `node scripts/check-no-corpus.mjs` | fails if `git ls-files` contains anything under a forbidden corpus path, or a stray `.eml` outside the directories that are allowed to hold one | should run in CI's lint job (see `needsOutside`) |

`scripts/golden/lib.mjs` is the one classify-and-score engine both `replay.mjs` and `calibrate.mjs`
import, so the synthetic gate and a private calibration run can never quietly drift apart.

## The golden set

`fixtures/golden/manifest.json` has one entry per `fixtures/golden/<category>-<n>.eml`: the expected
bucket, the account context (addresses, reply graph, contacts, VIP/blocked pins) and the auth
verdicts (SPF/DKIM/DMARC/ARC) that message would have arrived with — the same shape
`@postroom/classifier`'s `extractSignals` reads, since a worker supplies auth verdicts as structured
data, not something the classifier parses out of `Authentication-Results` itself.

Every entry also carries an `expectedFinalBucket` — one of the six real buckets (`inbox-priority`,
`inbox-people`, `newsletters`, `updates`, `receipts`, `notifications`, `junk`) — even though today's
`decide()` only distinguishes three (`priority`, `people`, `other`). That is deliberate: the set was
built to cover the real taxonomy (VIP spoof with a DMARC failure, Cc-only, bulk mail from a saved
contact, noreply senders, receipts, notifications, updates, newsletters, first-time humans) so it
does not need to be regenerated when PST-T-5.1's `bucketFor(signals, bayes?)` lands — only the
adapter needs to change (see below), and thresholds would then be re-bootstrapped against the six
real buckets using `expectedFinalBucket` instead of `expectedRuleBucket`.

Regenerate with:

```bash
node scripts/golden/generate.mjs
```

It is deterministic (a fixed seed, recorded in the file) — a diff after running it with no change to
the generator itself is a bug, not expected drift.

### Lowering a threshold is a reviewed change

`fixtures/golden/thresholds.json` is a normal, committed, reviewed file. `--write-thresholds`
overwrites it with whatever the classifier measures today — useful to bootstrap it, or to raise a
threshold after a genuine improvement — but the file only ever changes by way of a commit someone
reviews, same as any other source file. **Never lower a threshold to make a failing PR pass**; if the
replay is failing, the classifier regressed and that is the bug to fix.

## Switching to `bucketFor()` (PST-T-5.1)

`scripts/golden/lib.mjs`'s `classifyForGolden` is the single, clearly marked place this harness
turns a classifier decision into a golden bucket label. It currently calls `decide()` and returns its
three-way bucket. Once `bucketFor(signals, bayes?)` lands in `packages/classifier/src`, swap that
function's body to call it instead, and switch the manifest comparison from `expectedRuleBucket` to
`expectedFinalBucket` in `scripts/golden/lib.mjs`'s `runGolden`. Re-run
`node scripts/golden/replay.mjs --write-thresholds` once to record the six-bucket floors.

## Calibrating against a real mailbox (never committed)

`corpus/` (or `$POSTROOM_CORPUS`) is gitignored (PST-REQ-108) and holds:

```
corpus/
  labels.json   # [{ file, expectedRuleBucket, account, authVerdicts, envelopeFrom? }, ...]
  *.eml         # the messages labels.json refers to by `file`
```

`labels.json` has the same shape as a `fixtures/golden/manifest.json` entry. Build it from your own
mailbox (an IMAP export, a maildir dump — whatever you already have locally), label each message by
hand or from your own move history, then:

```bash
node scripts/golden/calibrate.mjs
```

This never writes into the repository, never updates `thresholds.json`, and exits `0` regardless of
the numbers it prints — a real inbox's precision/recall is a data point for you, not a gate.

## `needsOutside`: CI wiring this task could not make itself

This task's owned files do not include `.github/workflows/ci.yml` or the root `package.json`. For
PST-REQ-108's other half — the guard actually running in CI, not just passing when invoked by hand —
add:

- a root `package.json` script, e.g. `"check:corpus": "node scripts/check-no-corpus.mjs"`
- a step running it in `.github/workflows/ci.yml`'s lint job (or a lightweight job of its own),
  alongside the existing lint/typecheck steps

`packages/classifier/test/golden/replay.test.ts` needs no such wiring — it already runs as part of
`pnpm --filter @postroom/classifier test`, which CI's unit stage already runs for every package.

## Related

PST-T-5.5, PST-REQ-107, PST-REQ-108, PST-P-5. PST-T-5.1 (the pure `bucketFor` this harness will
switch to), PST-T-5.2 (`extractSignals`/`decide`), PST-T-5.3 (per-account naive Bayes).
