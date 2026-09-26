# Golden replay and private calibration

PST-T-5.5; PST-REQ-107 (the committed synthetic golden set gates CI); PST-REQ-108 (a gitignored
local calibration corpus is supported and never committed).

## Tune vs holdout: why this exists

The first version of this harness had a single golden set with 4–8 subject templates per bucket.
When `bucketFor()` (PST-T-5.1) landed and missed a few of them, the fix added literal phrases to
`packages/classifier/src/bucket-for.ts`'s `UPDATE_SUBJECT` and a `Precedence: junk` rule until the
same fixtures passed. The thresholds that came out of that were certifying tuned-to-the-test
behaviour, not the classifier's actual real-world accuracy — a small, guessable fixture set and a
"make it pass" loop is how that always ends up, whether or not anyone means for it to.

The fix is a **tune/holdout split**, generated from disjoint template pools:

- **`fixtures/golden/tune/`** — developers may look at these while changing heuristics. Reported by
  the replay, **never gates anything**.
- **`fixtures/golden/holdout/`** — a separate pool of senders, domains and subject wording, never a
  paraphrase of a `tune` entry. `fixtures/golden/thresholds.json` is recorded and enforced against
  **holdout only**.

Two rules make the split actually mean something, not just be a second directory:

1. **Never edit `packages/classifier/src/**` while looking at which holdout messages are failing.**
   If holdout is failing, that is real information about the classifier's accuracy — record it as
   the honest threshold (see below), or fix the *general* rule/heuristic based on understanding the
   *class* of mail it misses, without ever looking at the specific holdout fixture that exposed it.
   Looking at the failing holdout message and asking "what phrase would make this one pass" is
   exactly the failure mode this split exists to prevent.
2. **Holdout templates are regenerated only in a reviewed change** — a PR that touches
   `scripts/golden/generate.mjs`'s holdout pools (subjects, brands, domains, header variants) is
   reviewed the same as any other change to what CI gates on, same as lowering a threshold. It is
   never regenerated to make a specific failure go away.

Both splits are still purely synthetic (`example.com`/`.org`/`.net` domains, `dana@d3cloud.io` /
`sam@d3cloud.io` test accounts) and deterministic (a fixed seed, recorded in the generator).

## What runs where

| Where | What | When |
|---|---|---|
| `pnpm --filter @postroom/classifier test` → `packages/classifier/test/golden/replay.test.ts` | replays `fixtures/golden/holdout` through the classifier and fails if any bucket's precision or recall drops below `fixtures/golden/thresholds.json`; also runs and reports `fixtures/golden/tune` for visibility, without gating on it | every push and PR, CI's unit stage |
| `node scripts/golden/replay.mjs` | the same two-split replay, run by hand; `--json` for machine output, `--write-thresholds` to bootstrap/update the recorded floors from holdout | ad hoc, and by the test above |
| `node scripts/golden/calibrate.mjs [corpusDir]` | the same engine against a local, gitignored corpus of real mail (`corpus/` by default, or `$POSTROOM_CORPUS`) — prints metrics only, writes nothing, never fails the build | ad hoc, by an operator with a real mailbox to calibrate against |
| `node scripts/check-no-corpus.mjs` (root script `check:corpus`) | fails if `git ls-files` contains anything under a forbidden corpus path, or a stray `.eml` outside the directories allowed to hold one | CI, wired into `.github/workflows/ci.yml`'s lint job |

`scripts/golden/lib.mjs` is the one classify-and-score engine `replay.mjs` and `calibrate.mjs` both
import, so the synthetic gate and a private calibration run can never quietly drift apart.

## The golden set

Each split has its own directory with its own `manifest.json`:

```
fixtures/golden/
  thresholds.json         # holdout-only precision/recall floors, per bucket
  tune/
    manifest.json
    inbox-priority-001.eml, ...
  holdout/
    manifest.json
    inbox-priority-001.eml, ...
```

Each manifest entry has one record per `.eml`: the expected bucket (`expectedFinalBucket`, one of
the seven real buckets `inbox-priority`, `inbox-people`, `newsletters`, `updates`, `receipts`,
`notifications`, `junk`), the account context (addresses, reply graph, contacts, VIP/blocked pins)
and the auth verdicts (SPF/DKIM/DMARC/ARC) that message would have arrived with — the same shape
`@postroom/classifier`'s `extractSignals` reads, since a worker supplies auth verdicts as structured
data, not something the classifier parses out of `Authentication-Results` itself.

Every bucket has **at least 15 distinct subject templates and 8 distinct sender identities/domains**
across the two splits combined, split so neither pool leaks into the other (`tune` and `holdout` use
entirely disjoint name/domain/brand arrays, not just different combinations of the same ones), and
varied header mixes per bucket: different ESPs (SES, SendGrid, Mandrill, Mailgun fingerprints),
different list software shapes (Mailchimp-style CSV list-id, Substack-style hostname list-id,
compliance-footer-only, ESP-fingerprint-only bulk with no `List-Id` at all), notification-system
headers (`X-GitHub-Reason`-style) alongside the local-part heuristic, commerce/shipping/security
subject and sender flavours, and human writing-style variation (mobile signatures, quoted-reply
threads, Cc-only, first-time senders). See `scripts/golden/generate.mjs` for the exact pools — it is
the one place all of this is defined.

Regenerate with:

```bash
node scripts/golden/generate.mjs
```

It is deterministic (a fixed seed, recorded in the file, with a second independent PRNG stream per
split) — a diff after running it with no change to the generator itself is a bug, not expected
drift.

### Lowering a threshold is a reviewed change

`fixtures/golden/thresholds.json` is a normal, committed, reviewed file, recorded from `holdout`
only. `--write-thresholds` overwrites it with whatever the classifier measures against holdout
today (rounded *down*, never up, so the freshly-written floor never fails against the very run that
produced it) — useful to bootstrap it, or to raise a threshold after a genuine improvement — but the
file only ever changes by way of a commit someone reviews, same as any other source file.

**A threshold below 100% is not a bug to hide.** If `holdout` genuinely achieves 92% recall on a
bucket today, `thresholds.json` should say 92%, and the honest fix for that gap is understanding
*why* — a class of mail the rules do not yet cover — and writing a general rule for it, verified
against `tune` while it is being developed, then confirmed by re-running holdout once, not by
reading which holdout fixture failed and reverse-engineering a phrase for it.

**Never lower a threshold, and never edit `packages/classifier/src` while a holdout failure is on
screen**, to make a failing PR pass. If the replay is failing, either the classifier regressed (fix
it, verify against `tune`, then re-check holdout) or the holdout set itself needs a reviewed
regeneration (rare, and reviewed like any other change to what CI gates on).

### Header-less transactional mail (PST-T-5.9)

Until PST-T-5.9 every transactional fixture carried a bulk or automation header (List-Unsubscribe,
Auto-Submitted, an ESP fingerprint, Feedback-ID), and that hid a real gap: the rule pass read any
sender with a display name as human unless one of those headers said otherwise, so
`PagerDuty <alerts@pagerduty.com>` with plain headers was filed into INBOX. An out-of-sample probe
written by a different agent scored updates 1/10, receipts 1/10 and notifications 5/10.

The fix is `packages/classifier/src/sender.ts`: sender-shape cues weighed before the human
short-circuit — a role/transactional local-part vocabulary (tokenised on separators, digits dropped,
run-together words split), known notification/commerce domains, organisation display names (equal to
a domain label, or carrying organisation words or marks with no personal name in front), sending
subdomains and transactional subjects — against personal evidence ("First Last", a local part built
from the display name). Membership (reply graph, contacts, VIP pin) always wins for a real
correspondent; bulk and noreply never become human. Every cue that fires is in the reasons.

The generator gained section H (header-less transactional senders with friendly display names, >= 10
per bucket per split) and section I (humans with role-ish titles, a colleague replying `Re:` about an
invoice, and known correspondents with role addresses), disjoint between splits. Holdout was
regenerated in that change and `thresholds.json` re-recorded from it after one run: updates and
notifications 95.8% precision and recall (one message each way between them), every other bucket
100%. Tune is 100%. The failing holdout message was not inspected.

## `bucketFor()` is already wired (PST-T-5.1)

`scripts/golden/lib.mjs`'s `classifyForGolden` is the single, clearly marked place this harness
turns a classifier decision into a golden bucket label — it calls the full filing decision,
`bucketFor({ signals, headers })` (no Bayes model: the golden set measures the untrained, first-day
behaviour every new account gets), and compares against each manifest entry's `expectedFinalBucket`.

## Calibrating against a real mailbox (never committed)

`corpus/` (or `$POSTROOM_CORPUS`) is gitignored (PST-REQ-108) and holds:

```
corpus/
  labels.json   # [{ file, expectedFinalBucket, account, authVerdicts, envelopeFrom? }, ...]
  *.eml         # the messages labels.json refers to by `file`
```

`labels.json` has the same shape as a golden manifest entry. Build it from your own mailbox (an IMAP
export, a maildir dump — whatever you already have locally), label each message by hand or from your
own move history, then:

```bash
node scripts/golden/calibrate.mjs
```

This never writes into the repository, never updates `thresholds.json`, and exits `0` regardless of
the numbers it prints — a real inbox's precision/recall is a data point for you, not a gate, and
never a reason to touch `tune`, `holdout` or the classifier in response to one account's mail.

## Related

PST-T-5.5, PST-REQ-107, PST-REQ-108, PST-P-5. PST-T-5.1 (`bucketFor`), PST-T-5.2
(`extractSignals`/`decide`), PST-T-5.3 (per-account naive Bayes, not exercised by this harness).
