# fuzz/sieve/fixtures

Regression fixtures for the sieve fuzz target. Each file here is a byte-for-byte crasher input that
once made `fuzz/sieve/target.mjs` throw something other than SieveSyntaxError/SieveRuntimeError,
hang, break the print/parse round trip, or let `execute` return an unsafe result (no action at all,
or an allowed redirect to an address the account does not own). `scripts/fuzz-replay.mjs` (run as
part of `pnpm fuzz:smoke`) replays every file in this directory through the target and fails if any
of them crash it again.

Input format: the whole file is the script, unless it contains a line `#---message---`, in which
case what follows that line is the message the script runs against.

See docs/runbooks/fuzz-crasher.md for the crasher-to-fixture workflow.
