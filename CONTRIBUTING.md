# Contributing

Postroom is a personal learning build — the point is understanding every part of a mail server by
writing it, not wrapping an existing MTA. It's public under Apache-2.0 mostly so the code is
readable and reusable. Issues are welcome; so are small, focused pull requests, but expect the
maintainer to be opinionated about staying hand-rolled rather than pulling in a library for
something the project exists to learn.

## Before you open a PR

- **Read `CLAUDE.md`** for the non-negotiables (strict CRLF, streaming parsers, no relay, app
  passwords only, audited mutations, no telemetry, no LLM in the sorting logic) and the
  conventions (one image per daemon, parsers live in `packages/*` with a fuzz harness).
- **No new dependency without a reason.** State it in the PR description — what it replaces, why
  hand-rolling it is out of scope for this change. The default answer is still "write it."
- **CRLF is strict, always.** Any change touching the wire-protocol daemons (`smtp-in`,
  `submission`, `imap`, `dav`) needs a test proving bare LF/CR is still refused.

## Tests

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test                 # unit tests
pnpm test:integration     # needs DATABASE_URL against PostgreSQL 16
pnpm check:corpus         # fails on a tracked corpus path or stray .eml — see below
```

A parser change should come with fast-check properties beside it (see any `packages/*/test`), and
ideally a fuzz target in `fuzz/` if it's new. A fuzzer crasher is promoted to a regression fixture
before it's fixed — `docs/runbooks/fuzz-crasher.md`.

## The corpus never gets committed

`scripts/check-no-corpus.mjs` (run as `pnpm check:corpus`, and in CI) fails a PR that adds anything
under a private corpus path — `corpus/`, `fixtures/private/`, `fixtures/spamassassin/` — or a
stray `.eml` outside `fixtures/golden/` or a fuzz target's own `corpus/`/`fixtures/` directory.
This is PST-REQ-108: the private calibration corpus is real mail and is never committed. Only
`fixtures/golden` (synthetic) is. If your change needs a new fixture, make it synthetic and put it
under `fixtures/golden/` or the relevant `fuzz/<target>/fixtures/`.

## Security issues

Please don't open a public issue for a vulnerability — see `SECURITY.md` for how to report one
privately.
