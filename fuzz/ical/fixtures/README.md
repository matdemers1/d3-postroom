# fuzz/ical/fixtures

Regression fixtures for the ical fuzz target. Each file here is a byte-for-byte crasher input that
once made `fuzz/ical/target.mjs` throw something other than its documented error class, hang, or
break one of its invariants (round-trip, expansion sorted/unique/in range/within the cap).
`scripts/fuzz-replay.mjs` (run as part of `pnpm fuzz:smoke`) replays every file in this directory
through the target and fails if any of them crash it again.

See docs/runbooks/fuzz-crasher.md for the crasher-to-fixture workflow.
