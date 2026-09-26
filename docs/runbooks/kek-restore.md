# Runbook: restore with the escrowed KEK

PST-T-13.2, PST-REQ-163. Builds on PST-T-0.16/PST-T-0.17, PST-REQ-011/022/023/024, `packages/crypto`
(`sealKekBundle`/`unsealKekBundle`, Argon2id + AEAD), `apps/worker/src/backup/**`,
`apps/worker/src/drill/drill.ts`, and [`docs/runbooks/backups.md`](backups.md) (the full backup and
drill design — read that first; this runbook is the disaster-recovery walk-through on a clean
machine).

## Purpose

Bring Postroom back from nothing — a new machine, the SSE-KMS S3 bucket, and the operator's escrowed
passphrase — after the Zima and its disks are gone. This is the path that proves the KEK recovery is
real, not just the nightly drill (which restores into a scratch database on the same host and
already has `POSTROOM_KEK` in its environment).

## When to use

- The Zima is lost, stolen, or its disk is unreadable.
- Proving disaster recovery (should still be paired with the nightly drill's automatic check —
  see `backups.md`).

## Prerequisites

- A clean host with Docker, the repo (or at least `docker-compose.yml`, `docker-compose.tunnel.yml`
  and the `postroom.env`/`postgres.env` shape), and the `postroom` image pullable from GHCR.
- AWS credentials for the `postroom-backup` IAM user (`AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=us-east-1`) or an admin profile.
- The bucket name (`BACKUP_BUCKET`, default `postroom-backups-d3cloud`).
- The **KEK bundle passphrase** (`BACKUP_KEK_PASSPHRASE`) from the operator's password manager —
  this never lives in the bucket, in git, or on any host; it is the one secret that must come from
  a human.
- `postgresql-client-16` (`pg_dump`/`pg_restore` matching the server's major version — a newer
  client's dump/restore is not safe against a 16 server, per the note in `Dockerfile`).
- Do **not** start the daemons until the restore below is verified.

## Steps

1. Install the stack on the new host (compose files, `.env`s) but do not start the mail daemons —
   Postgres alone is enough for the restore.
2. Find the newest dump and fetch it, checking its checksum:

   ```sh
   date=$(aws s3 ls "s3://${BACKUP_BUCKET}/db/" | awk '{print $2}' | sed 's#/$##' | sort | tail -1)
   aws s3 cp "s3://${BACKUP_BUCKET}/db/${date}/postroom.dump" .
   aws s3 cp "s3://${BACKUP_BUCKET}/db/${date}/postroom.dump.sha256" .
   aws s3 cp "s3://${BACKUP_BUCKET}/db/${date}/manifest.json" .
   sha256sum -c postroom.dump.sha256
   ```

3. Restore into a fresh database (client 16, matching the server):

   ```sh
   createdb postroom
   pg_restore --no-owner --no-privileges --exit-on-error -d postroom postroom.dump
   ```

4. Bring back the blobs (already AES-256-GCM ciphertext under per-blob DEKs — nothing to decrypt
   yet):

   ```sh
   aws s3 sync "s3://${BACKUP_BUCKET}/blobs/" /var/lib/postroom/blobs/
   ```

5. Recover the KEK from the sealed bundle. Fetch it and unseal it with the escrowed passphrase
   using `unsealKekBundle` from `@postroom/crypto` (Argon2id key derivation + AEAD open):

   ```sh
   aws s3 cp "s3://${BACKUP_BUCKET}/kek/bundle.json" .
   node -e '
     const { unsealKekBundle } = require("@postroom/crypto");
     const fs = require("fs");
     const bundle = JSON.parse(fs.readFileSync("bundle.json", "utf8"));
     unsealKekBundle(bundle, process.env.BACKUP_KEK_PASSPHRASE)
       .then((kek) => { process.stdout.write(kek.toString("base64")); })
       .catch((e) => { console.error(e); process.exit(1); });
   ' > kek.b64
   ```

   Set the result as `POSTROOM_KEK` in the new host's `postroom.env` (never print it to a shared
   terminal, log, or ticket — treat it exactly like the passphrase).
6. Start the stack (`api` and `worker` at minimum; the mail daemons can wait until the edge and
   WireGuard side are also rebuilt — see [`edge-rebuild.md`](edge-rebuild.md)).
7. Run the drill against the restored database to prove the whole chain end to end:

   ```sh
   docker compose exec worker postroom drill
   ```

## Verification

- `postroom.dump.sha256` matched before restore (step 2).
- `pg_restore --exit-on-error` completed with no error.
- `postroom drill` exits 0 and its JSON (also on `/health` as `lastDrill`) shows
  `"ok": true, "kekFrom": "bundle"` — proof the KEK came from the escrowed bundle and passphrase,
  not from an environment variable that happened to survive.
- A message opened by the drill decrypts and its plaintext SHA-256 matches the blob name — the
  same check `apps/worker/src/drill/drill.ts` performs automatically every night, now proven on a
  machine that started with nothing.

## Rollback / abort

- Nothing here is destructive to the source: every step reads from S3 (versioned, and the backup
  IAM user cannot delete anything — see `backups.md`) and writes only to the new, empty host.
- If the unseal fails (`the KEK bundle does not open`), the passphrase is wrong, or the escrowed
  copy is stale — stop, do not guess at variations in front of a live restore, and confirm the
  passphrase in the password manager before retrying.
- If the drill is red for any reason (`dump is corrupt`, `restore of … failed`, `blob … missing`,
  `blob … does not decrypt`), do not point mail traffic at this host — fix the cause and rerun the
  drill; a red drill is recorded, not silently retried.

## Execution record

| Field | Value |
|---|---|
| Last executed | not yet executed |
| By | — |
| Result | — |
| Precondition needed | a clean host, AWS access to the backup bucket, and the operator's escrowed `BACKUP_KEK_PASSPHRASE` from their password manager |

## Relates to

PST-REQ-163 · PST-REQ-011 · PST-REQ-022 · PST-REQ-023 · PST-REQ-024 · PST-ADR-009 · PST-T-0.16 ·
PST-T-0.17 · PST-T-13.2

See also: [`docs/runbooks/README.md`](README.md) · [`docs/runbooks/backups.md`](backups.md) (full backup/drill design, nightly automatic drill) · [`docs/runbooks/edge-rebuild.md`](edge-rebuild.md) (rebuilding the edge side after a full-host loss).
