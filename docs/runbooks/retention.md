# Retention and crypto-shred

PST-T-7.7; PST-REQ-129 (retention through Trash, with a visible clock), PST-REQ-130 (the last
reference destroys the data key, then the file). Builds on PST-ADR-009 (deletion is crypto-shred).

Mail leaves Postroom in exactly two ways: the client's own `\Deleted` + `EXPUNGE` (or deleting a
mailbox it made), and **expiry out of Trash or Rejects**. Nothing else deletes. A retention policy
on any other mailbox *moves* mail to Trash, where a fresh clock starts and the webmail shows
"Deletes in N days".

## Policies

| Mailbox | Default | What happens when it runs out | Clock |
|---|---|---|---|
| Junk | 30 days | moved to Trash | `received_at` |
| Trash | 30 days | expunged, then shredded | `trashed_at` (when it entered Trash) |
| Rejects | 14 days | expunged, then shredded | `received_at` (the date smtp-in wrote into the verdict) |
| everything else | forever | — | — |

A `retention_policy` row (one per mailbox) overrides the default: `days = 7` on INBOX moves week-old
INBOX mail to Trash; `days = NULL` on Junk keeps Junk forever. `days` is at least 1.

```sql
-- keep Junk forever
INSERT INTO retention_policy (account_id, mailbox_id, days)
SELECT account_id, id, NULL FROM mailbox WHERE special_use = 'junk' AND account_id = '<account>'
ON CONFLICT (mailbox_id) DO UPDATE SET days = EXCLUDED.days, updated_at = now();
```

There is no console screen for this yet; a change made in SQL is not audited, so note it in the
operator log.

**Why `received_at`, not `internal_date`.** `internal_date` is whatever an IMAP `APPEND` said, so a
message filed a minute ago can claim to be ten years old; `received_at` is when this server took it.
One consequence: a message received long ago and moved into Junk today goes to Trash on the next
sweep — which is safe, because Trash then gives it a full period.

## The Trash clock

`message.trashed_at` is stamped by a database trigger (`message_trashed_at`, in the
`…_retention` migration) whenever a row enters a Trash mailbox — IMAP `MOVE` (an `UPDATE` of
`mailbox_id`), `COPY`/`APPEND` and the webmail's move (an `INSERT`) alike — and cleared when it
leaves. The sweep sets it from its own clock when it moves Junk to Trash. Messages already in Trash
when the migration ran got `now()`, so nothing expires sooner than a full period after deploy.

The API returns `trashedAt` and `expiresAt` (= `trashedAt` + the Trash policy) on every message
summary and detail; both are null outside Trash. The message list shows "Deletes in N days".

## The sweep

The worker runs it at start and every `RETENTION_SWEEP_MS` (default one hour):

1. **Move to Trash** — for each non-Trash, non-Rejects mailbox with a policy, due messages move the
   way IMAP `MOVE` does: the row is re-homed with a new UID from Trash's `uidnext`, both mailboxes'
   `highest_modseq` advance, the old UIDs are written to `expunged_message` (QRESYNC `VANISHED`), and
   both mailboxes are `pg_notify`'d (IDLE sessions and the webmail's SSE wake). An account with no
   Trash mailbox is skipped and logged (`retention-no-trash`) — never deleted instead.
2. **Expire Trash**, 3. **Expire Rejects** — due messages are expunged with the same modseq,
   `expunged_message` and notify semantics, and each releases its blob reference (below).
4. **Release spool references** — see below.
5. **Blob gc** — removes files with no `blob` row (older than an hour) and abandoned temp files.

Everything runs in batches of 200, each batch one transaction, at most 50 batches per mailbox per
run; a big backlog simply takes a few runs. Every batch writes an audit row as `system`
(`retention.move-to-trash`, `retention.expunge`, `retention.release-spool`) with its counts and UIDs.
Running it twice, or on two workers at once, does the work once.

## Crypto-shred

Every message's bytes live in one encrypted blob, named by its SHA-256 and shared by every copy. The
`blob` row holds the refcount and the blob's **wrapped DEK** — the only copy of the key that decrypts
the file. References are held by each `message` row and by the `inbound_message` spool row that
received it.

- `BlobStore.release()` is the one path that drops a reference. The release that takes the refcount
  to 0 **deletes the `blob` row in the same transaction** as the expunge that caused it — from that
  commit on the file is ciphertext nobody can decrypt, even with the KEK.
- The file is unlinked after the commit (`reap`). A crash in between leaves an orphan file with no
  row; the sweep's gc pass removes it.
- Spool rows: after the last `message` naming a blob is gone, the finished spool rows (`filed`,
  `rejected`) that still hold a reference release it and get `blob_released_at`. The sweep does this
  immediately for mail it expired, and — for mail the user expunged themselves over IMAP — a day
  after receipt, only for spool rows that were filed into at least one mailbox. A message that is
  still arriving (`spooled`, `processing`) or `failed` is never released.

Every path that removes a reference goes through `release()`: IMAP `EXPUNGE`/`CLOSE`, IMAP mailbox
`DELETE`, a failed `APPEND`, and the retention sweep. The webmail has no delete — its "delete" is a
move to Trash.

### What crypto-shred does and does not reach

- **The live system: immediate.** Once the expunge commits, the wrapped DEK is gone from the table
  and the file is unreadable, then gone.
- **PostgreSQL internals: until vacuum.** A deleted row stays in its heap page as a dead tuple until
  `VACUUM` reclaims it, and in WAL segments until they are recycled. Both are on the same host, under
  the same disk encryption as the database; neither is reachable through the application.
- **Backups: up to 90 days.** The offsite bucket keeps the blob *files* forever (`blobs/` has no
  expiry, and the backup key cannot delete), but a file is useless without its wrapped DEK, which
  lives only in the database — and so in each nightly dump. Dumps expire 90 days after they were
  written. So a shredded message stays recoverable **from a backup** for up to 90 days after it was
  shredded, and after that no restore point holds its key. This is deliberate: a restore must be able
  to bring back mail deleted by mistake, and 90 days is that window. It also means a legal
  "delete it now" request is satisfied on the live system immediately and in backups after 90 days;
  say so when asked.
- **Other copies of the same bytes.** A blob is shared by every copy of identical bytes — the same
  message delivered twice, a `COPY` into another folder. It is shredded when the **last** copy goes,
  never before.
- **Sent mail.** An `outbound_message` row keeps its own reference to the blob it delivered and is
  never released by retention, so a Sent message's bytes survive the Sent copy being deleted. Out of
  scope for PST-T-7.7.

## Checking it

```sql
-- what the sweep has done in the last day
SELECT at, action, entity_id, before->>'count' AS expunged, after
FROM audit_event WHERE action LIKE 'retention.%' AND at > now() - interval '1 day' ORDER BY at DESC;

-- messages that will expire in the next week
SELECT m.id, mb.name, m.trashed_at FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id
WHERE mb.special_use = 'trash' AND m.trashed_at < now() - interval '23 days';
```

Worker logs: `retention-sweep` (counts, whenever something happened), `retention-sweep-error`
(retried next tick), `retention-no-trash`, `retention-reap-error` (the file is left for gc).

Proof: `apps/worker/test/integration/retention.test.ts` — Junk at 31 days moves to Trash with its
clock; 31 days later it is expunged, the `blob` row is gone, the file is gone and reading it throws;
a shared blob survives until its second copy goes; a crash between the DEK and the file leaves an
orphan that gc removes; nothing outside Trash and Rejects is ever deleted.
