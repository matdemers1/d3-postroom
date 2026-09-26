# fuzz/dmarc-report/fixtures

Regression fixtures for the dmarc-report fuzz target (`@postroom/reports`: DMARC aggregate and
TLS-RPT parsers, the strict XML reader and the gzip/zip unwrapping). Each file here is a
byte-for-byte crasher input that once made `fuzz/dmarc-report/target.mjs` throw something other
than `ReportError`, hang, or break the serializer round-trip. The first byte selects the attachment
guise (filename and content type); the rest is the attachment. `scripts/fuzz-replay.mjs` (run as
part of `pnpm fuzz:smoke`) replays every file in this directory and fails if any crash it again.

See docs/runbooks/fuzz-crasher.md for the crasher-to-fixture workflow.
