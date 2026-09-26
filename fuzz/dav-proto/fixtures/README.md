# fuzz/dav-proto/fixtures

Regression fixtures for the dav-proto fuzz target. Each file here is a byte-for-byte crasher input
that once made `fuzz/dav-proto/target.mjs` throw something other than its documented error classes
(XmlError from the XML parser, DavError from the request parsers), hang, or break the serializer
round-trip. `scripts/fuzz-replay.mjs` (run as part of `pnpm fuzz:smoke`) replays every file in this
directory through the target and fails if any of them crash it again.

See docs/runbooks/fuzz-crasher.md for the crasher-to-fixture workflow.
