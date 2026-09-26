# fuzz/imap-proto/fixtures

Regression fixtures for the imap-proto fuzz target. Each file here is a byte-for-byte crasher input that
once made `fuzz/imap-proto/target.mjs` throw something other than its documented error class, hang, or
exceed its retained-bytes bound. `scripts/fuzz-replay.mjs` (run as part of `pnpm fuzz:smoke`)
replays every file in this directory through the target and fails if any of them crash it again.

See docs/runbooks/fuzz-crasher.md for the crasher-to-fixture workflow.
