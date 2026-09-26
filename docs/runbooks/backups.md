# Backups and the restore drill

PST-T-0.16 and PST-T-0.17; PST-REQ-022, PST-REQ-023, PST-REQ-024, PST-REQ-011.

Every night the worker dumps the database, sends new encrypted blobs and the sealed KEK recovery
bundle to a versioned SSE-KMS S3 bucket, and then **restores the newest backup into a scratch
database and opens a random message end to end**. `/health` on the worker reports both:

```json
"lastBackup": { "at": "2026-09-26T03:00:41Z", "ok": true, "bytes": 18234112, "objects": 14, "blobsUploaded": 11, "kekBundle": "unchanged", "key": "db/2026-09-26/postroom.dump" },
"lastDrill":  { "at": "2026-09-26T04:30:12Z", "ok": true, "reason": "restored db/2026-09-26/postroom.dump; opened message blob 3f1c… end to end", "source": "s3", "kekFrom": "bundle" }
```

Both are also stored as the `setting` rows `backup.last` and `drill.last`, so they survive restarts
and a one-shot run from the CLI shows up the same way.

> [!warning] Until the bucket exists, `lastBackup.ok` is **false**
> With no `BACKUP_BUCKET`, the job still takes a local dump (so the drill has something to restore)
> and records `skipped: "backups not configured (BACKUP_BUCKET not set): local dump only, nothing
> left this machine"`. It never reports a local dump as a backup.

## What goes where

| Object | Written | Notes |
|---|---|---|
| `db/<yyyy-mm-dd>/postroom.dump` | nightly | `pg_dump -Fc` from the image's postgresql-client-16; PUT signed with its SHA-256 so S3 checks it |
| `db/<yyyy-mm-dd>/postroom.dump.sha256` | nightly | `sha256sum` format |
| `db/<yyyy-mm-dd>/manifest.json` | nightly, **last** | `{date, startedAt, finishedAt, dumpKey, dumpBytes, dumpSha256, blobsUploaded, blobsTotal, schemaRevision, revision}` — a dump without one is incomplete and the drill never picks it |
| `blobs/<aa>/<bb>/<sha256>` | once per blob | the files in `BLOB_ROOT` as they are: already AES-256-GCM ciphertext under per-blob DEKs. Nothing is decrypted to upload |
| `kek/bundle.json` | when it changes | the KEK sealed with `BACKUP_KEK_PASSPHRASE` (Argon2id + AES-256-GCM, `@postroom/crypto`). Re-sealed only when the bucket's bundle no longer opens, with today's passphrase, to today's KEK |

The KEK itself never leaves the host except inside that bundle. The wrapped DEKs travel inside the
dump, so a restore needs **the dump, the blobs and the bundle's passphrase** — the passphrase lives
only in the operator's password manager.

A local copy of each dump is kept in `BACKUP_DIR/<date>/` for `BACKUP_KEEP_LOCAL_DAYS` (7) days.

## The AWS resources

Run [`backups-provision.sh`](backups-provision.sh) `provision` with an admin profile; it creates
exactly this, idempotently, and prints the `.env` lines.

1. **A KMS key** `alias/postroom-backups` (symmetric, rotation on). The default key policy
   delegates to IAM, so the user policy below is what grants use of it.
2. **A bucket** (default `postroom-backups-d3cloud`, `us-east-1`, no dots in the name — the client
   uses virtual-hosted addressing over TLS):
   - public access blocked, object ownership `BucketOwnerEnforced`;
   - **versioning Enabled** — an overwrite (a second run on one date, a re-sealed bundle) keeps the
     old version;
   - **default encryption SSE-KMS** with that key, bucket key on;
   - **lifecycle, 90 days**:
     - `noncurrent-versions` (whole bucket): noncurrent versions expire 90 days after they are
       superseded; expired delete markers are cleaned up; incomplete multipart uploads abort after 7
       days;
     - `nightly-dumps` (prefix `db/`): each night's dump, checksum and manifest expire 90 days after
       they were written — so there are always 90 nightly restore points.

     `blobs/` and `kek/` deliberately have **no current-version expiry**: a blob is uploaded once
     and never again, so expiring it would lose the only offsite copy of a message that is still in
     the mailbox.
   - **bucket policy**: deny any request not over TLS; deny any `PutObject` that is not
     `aws:kms` with exactly this key's ARN.
3. **An IAM user** `postroom-backup` with one inline policy:
   - Allow `s3:PutObject`, `s3:GetObject` on `arn:aws:s3:::<bucket>/*`;
   - Allow `s3:ListBucket` on `arn:aws:s3:::<bucket>`;
   - Allow `kms:GenerateDataKey`, `kms:Decrypt` on the key;
   - **explicit Deny** on `s3:DeleteObject*` (every delete: object, version, tagging), `s3:DeleteBucket*`,
     and every call that could undo the protection — `s3:PutLifecycleConfiguration`,
     `s3:PutBucketVersioning`, `s3:PutBucketPolicy`, `s3:PutEncryptionConfiguration`,
     `s3:PutObjectRetention`, `s3:BypassGovernanceRetention`; and `kms:ScheduleKeyDeletion`,
     `kms:DisableKey`, `kms:PutKeyPolicy`, `kms:CreateGrant` on the key.

   So a stolen backup key can add versions but cannot remove one or shorten how long one is kept.

## Environment (the host's `.env`, read by the worker)

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_BUCKET` | — | unset = backups not configured (loud on `/health`) |
| `BACKUP_KMS_KEY_ID` | — | the key's **ARN** (the bucket policy compares against it) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | — | the `postroom-backup` user's key |
| `AWS_SESSION_TOKEN` | — | only for temporary credentials |
| `AWS_REGION` | `us-east-1` | |
| `BACKUP_KEK_PASSPHRASE` | — | seals `kek/bundle.json`; unset = no bundle, and the drill uses `POSTROOM_KEK` |
| `BACKUP_S3_ENDPOINT` | — | path-style endpoint for an S3-compatible store; tests use a loopback fake |
| `BACKUP_DIR` | `/var/lib/postroom/backups` | local dump copies (the `backups` volume) |
| `BACKUP_KEEP_LOCAL_DAYS` | `7` | |
| `BLOB_ROOT` | `/var/lib/postroom/blobs` | the blob store |
| `BACKUP_AT`, `DRILL_AT` | `03:00`, `04:30` | UTC; the worker enqueues `backup:<date>` / `drill:<date>` once each is due |
| `BACKUP_LEASE_MS` | `10800000` | a claimed backup/drill job is not re-claimed for 3 h |
| `DRILL_DATABASE_URL` | `DATABASE_URL` | a role that may `CREATE DATABASE`; the scratch `postroom_drill_<random>` is made beside it and always dropped |

## Running one now

```sh
docker compose exec worker postroom backup   # exits 0 only when the backup reached the bucket
docker compose exec worker postroom drill    # exits 0 only when the drill is green
```

Both print the JSON they record on `/health`.

## Verifying the promises

`backups-provision.sh verify`, with the admin profile in `AWS_PROFILE` and the backup user's keys in
`BACKUP_AWS_ACCESS_KEY_ID` / `BACKUP_AWS_SECRET_ACCESS_KEY`, checks:

- versioning is `Enabled` and default encryption is `aws:kms`;
- **lifecycle is 90 days** (`noncurrent-versions` and `nightly-dumps`);
- **tonight's objects are in the bucket** (`db/<today>/` listed, `manifest.json` SSE-KMS);
- **the backup user's delete is denied**: it runs `aws s3api delete-object` on tonight's manifest as
  that user and fails unless the answer is `AccessDenied`.

The same by hand:

```sh
AWS_ACCESS_KEY_ID=<backup key> AWS_SECRET_ACCESS_KEY=<backup secret> \
  aws s3api delete-object --bucket postroom-backups-d3cloud --key db/$(date -u +%F)/manifest.json
# An error occurred (AccessDenied) when calling the DeleteObject operation: ...
aws s3api get-bucket-lifecycle-configuration --bucket postroom-backups-d3cloud
```

## The drill

1. Newest `db/<date>/manifest.json` in the bucket (or, unconfigured, the newest local
   `BACKUP_DIR/<date>/`); the dump is downloaded and its SHA-256 compared with the manifest.
2. `pg_restore --exit-on-error` into `postroom_drill_<random>`.
3. A random `message` row in the **restored** database; its blob fetched from the bucket (or the
   local store); its DEK unwrapped from the **restored** `blob` row with the KEK — recovered from
   `kek/bundle.json` with `BACKUP_KEK_PASSPHRASE` when set, so the recovery path is proven too —
   decrypted, and the plaintext's SHA-256 compared with the blob's name.
4. The scratch database is dropped whatever happened.

Red reasons you may see: `dump … is corrupt: its sha256 is …, the manifest says …`;
`restore of … failed: pg_restore exited 1: …`; `blob … is referenced by the dump but missing from the
bucket`; `the KEK bundle does not open: …`; `blob … does not decrypt: …`. A red drill is recorded, not
retried: run `postroom drill` after fixing the cause.

## Restoring for real

1. New host: install the stack, do **not** start the daemons.
2. `aws s3 cp s3://<bucket>/db/<date>/postroom.dump .` and check it against `postroom.dump.sha256`.
3. `createdb postroom && pg_restore --no-owner --no-privileges --exit-on-error -d postroom postroom.dump`
   (client 16).
4. `aws s3 sync s3://<bucket>/blobs/ /var/lib/postroom/blobs/`.
5. Recover the KEK from `kek/bundle.json` with the passphrase (`unsealKekBundle` in
   `@postroom/crypto`) and put it in `POSTROOM_KEK`.
6. Start the stack; run `postroom drill` against it.

## Relates to

PST-REQ-011 · PST-REQ-022 · PST-REQ-023 · PST-REQ-024 · PST-ADR-009 · PST-T-0.16 · PST-T-0.17
