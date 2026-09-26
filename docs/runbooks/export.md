# Full-data export (PST-T-10.1, PST-REQ-151)

Lets an account owner take a complete, portable copy of their mail: one mbox file per folder, plus
a manifest, in a ZIP archive built entirely server-side and streamed to the browser.

## What is exported today

- **Mail**: every folder as an [mboxrd](https://en.wikipedia.org/wiki/Mbox#Modified_mbox)-format
  file at `mail/<Folder path>.mbox` inside the archive (nested folder names, e.g. `Archive/2024`,
  become `mail/Archive/2024.mbox`; a `/` in a folder name is a path separator, never escaped).
- **`manifest.json`**: account id, export time, Postroom's revision and schema revision, per-folder
  message counts and SHA-256 of each mbox file, a total message count, and `calendars: []` /
  `addressBooks: []`.

**Not yet exported**: calendars (iCalendar) and address books (vCard) — there are no CalDAV/CardDAV
tables yet (a later phase). The manifest's `calendars` and `addressBooks` arrays are the extension
point: once those tables and `packages/ical` / `packages/vcard` exist, the worker fills them the
same way it fills `folders` today, and nothing about the archive format or the API changes.

## How it works

1. `POST /api/export` (session + fresh step-up + CSRF) enqueues one job on the Postgres queue's
   `export` queue, payload `{ accountId }` (`apps/api/src/export/index.ts`). One active export per
   account: a second call while one is pending/running is `409 export_active`.
2. The worker's `export` queue (`apps/worker/src/export/job.ts`, wired in
   `apps/worker/src/main.ts`'s own block) streams every mailbox's messages, oldest UID first, into
   an mboxrd entry per message (`apps/worker/src/export/mbox.ts`), zips them with a hand-rolled
   streaming ZIP writer (`apps/worker/src/export/zip.ts`, `node:zlib` for CRC-32, no archiver
   dependency), and pipes the whole archive straight into the blob store — nothing is buffered in
   memory or written to disk as plaintext, so a 10 GB mailbox is no different from a 10 KB one.
3. The finished archive's blob SHA-256, size and manifest are recorded in one `setting` row keyed
   `export-result.<jobId>` (`apps/worker/src/export/settings.ts`) — the job queue's own status
   (`pending`/`running`/`done`/`dead`) is the export's status; no separate state machine.
4. `GET /api/export/:id` reports status; `GET /api/export/:id/download` (fresh step-up) streams the
   archive as `application/zip`. Both check that the export belongs to the caller's account (404
   otherwise) and are audited (`export.start`, `export.download`).
5. An archive is deleted 24 h after it finishes: a sweep on its own interval
   (`apps/worker/src/export/sweep.ts`) releases the blob (crypto-shred once its refcount hits zero)
   and deletes the `setting` row. A download after that point is a clean 404, not a stale pointer.

## Verifying an export by hand

```bash
curl -sS -X POST https://mail.d3cloud.io/api/export \
  -H 'x-postroom-csrf: 1' -H "cookie: $COOKIE" | jq
# poll:
curl -sS "https://mail.d3cloud.io/api/export/$ID" -H "cookie: $COOKIE" | jq
# once status is "done":
curl -sS -o export.zip "https://mail.d3cloud.io/api/export/$ID/download" -H "cookie: $COOKIE"
unzip -l export.zip
```

Opening `export.zip` in Thunderbird (File → Import → mbox files) and the Apple Mail importer (via
`mbox` → Mail's own "Import Mailboxes") is the acceptance check for PST-REQ-151 and is run by hand,
not by CI — the automated tests prove the ZIP and mboxrd bytes are well-formed and round-trip
exactly (`apps/worker/test/unit/export/*.test.ts`, `apps/worker/test/integration/export/*.test.ts`,
`apps/api/test/integration/export.test.ts`), including verification with `unzip -t` where the
binary is available.

## Environment

Nothing new: `BLOB_ROOT` and `POSTROOM_KEK` (already required for mail) are reused for the archive.
Two tuning knobs, both optional: `EXPORT_LEASE_MS` (default 1 h — how long a worker holds an export
job's lease before another worker may reclaim it) and `EXPORT_SWEEP_MS` (default 60 s — how often
the expiry sweep runs).
