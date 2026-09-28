# fuzz/dsn-report/fixtures

Regression fixtures for the dsn-report fuzz target (`@postroom/dsn`: the RFC 3464
message/delivery-status and RFC 5965 message/feedback-report readers, PST-T-11.15). Each file here
is a byte-for-byte crasher input that once made `fuzz/dsn-report/target.mjs` throw, hang, return an
unbounded result or a Status that is not an x.y.z code. The first byte selects text or byte input;
the rest is the report body. `scripts/fuzz-replay.mjs` (run as part of `pnpm fuzz:smoke`) replays
every file in this directory and fails if any crash it again.

See docs/runbooks/fuzz-crasher.md for the crasher-to-fixture workflow.
