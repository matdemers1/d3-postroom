# Runbook: deploy

PST-T-13.2, PST-REQ-163. Builds on PST-T-0.10 (`docs/shipyard/postroom.yml`), the host compose at
`docs/install/compose.host.yml`, `bin/postroom.mjs`, `Dockerfile` and `.github/workflows/ci.yml`.

## Purpose

Ship a new commit to the Zima's running stack. There is exactly one sanctioned path: Shipyard. No
one edits `/DATA/postroom/docker-compose.yml` by hand and no one deploys by SSH — Shipyard is the
only thing that rewrites the `image: …:sha-<40hex>` lines, runs the migration, and swaps the
containers.

## When to use

Any time a commit on `main` should become the live server: a feature, a fix, a dependency bump.

## Prerequisites

- The commit is on `main` and CI (`.github/workflows/ci.yml`: lint → unit → integration → e2e →
  images) is green, which is what publishes `ghcr.io/matdemers1/d3-postroom/server:sha-<40hex>` and
  `ghcr.io/matdemers1/d3-postroom/wireguard:sha-<40hex>`.
- The commit's images are ahead of what is currently live (Shipyard's agent checks this itself and
  refuses otherwise).
- Access to Shipyard: either its console/MCP at `https://shipyard.d3cloud.io` (bearer token from
  the Tokens screen), or a shell on the Zima with the Shipyard stack running at `/DATA/shipyard`.
- Postroom is registered with Shipyard as `postroom` (`docs/shipyard/postroom.yml` is the record
  kept in step by hand; the copy that runs is `/DATA/shipyard/apps/postroom.yml`).

## Steps

1. Confirm the target SHA is what you intend to deploy (the full 40-hex commit SHA on `main`, not
   a short SHA and not a tag).
2. Dry-run first, from `/DATA/shipyard` on the Zima host:

   ```sh
   docker compose -p shipyard run --rm --no-deps --entrypoint shipyard-run agent \
     deploy postroom <sha> --dry-run
   ```

   This re-verifies preconditions (CI push build green on `main`, ahead of live, digests present
   in GHCR for every mapped service) without touching the running stack. Same options are
   available from the Shipyard console's Postroom deploy screen or over MCP.
3. Run it for real:

   ```sh
   docker compose -p shipyard run --rm --no-deps --entrypoint shipyard-run agent \
     deploy postroom <sha>
   ```

   The agent, per `docs/shipyard/postroom.yml`:
   - backs up (Shipyard's own pre-deploy backup, distinct from Postroom's nightly backup job);
   - runs the one-shot migration (`steps.migrate`: `api` service, `argv: [migrate]`, which is
     `postroom migrate` → `prisma migrate deploy` — Postroom never migrates on boot, PST-ADR-001);
   - swaps every mapped service (`api`, `worker`, `smtp-in`, `submission`, `imap`, `managesieve`,
     `delivery`, `dav`, `wireguard`) to `<image>:sha-<sha>`;
   - checks the digest actually running, the release/revision, and `/health`'s schema
     (`health.service: api`, `health.port: 3300`, `health.path: /health`);
   - soaks for `soakSeconds: 90`;
   - rolls back the image alone if any of that fails.
4. Watch the deploy through to completion in the Shipyard console (or its MCP progress stream) —
   it reports each stage (backup, migrate, swap, verify, soak) as it happens.

## Verification

- `curl -s https://mail.d3cloud.io/health` answers `{"status":"ok","daemon":"api","revision":
  "<sha>","schemaRevision":"<n>"}` — check `revision` matches the deployed SHA and `schemaRevision`
  is what the migration produced (`apps/api/src/app.ts`'s `/health` route, backed by
  `@postroom/db`'s `schemaRevision`).
- The admin Health screen's daemon tiles are all green (`DAEMON_HEALTH_URLS` in
  `docs/install/compose.host.yml`: `smtp-in`, `submission`, `imap`, `managesieve`, `delivery`,
  `dav`, `worker`, each answering its own `/health`).
- Shipyard's own deploy record shows `ok` for backup, migrate, swap, verify and soak.

## Rollback / abort

- A dry-run (`--dry-run`) never touches anything — abort by simply not running the real deploy.
- If the live deploy's own verify/soak step fails, Shipyard rolls back automatically: image-only,
  back to the previous `sha-<40hex>` tag. The Postroom schema is additive (PST-ADR-001 family), so
  an image-only rollback is always safe against the migration that already ran.
- A manual rollback to an older known-good SHA uses the same command with that SHA:

  ```sh
  docker compose -p shipyard run --rm --no-deps --entrypoint shipyard-run agent \
    deploy postroom <previous-good-sha>
  ```

## What this is not

- Never `ssh` into the Zima and edit `/DATA/postroom/docker-compose.yml` by hand — Shipyard is the
  only writer of the `image:` lines, and a hand edit is invisible to its ledger and its rollback.
- Never run `docker compose up` against the host compose files directly for a live deploy; that is
  for local development only (`docker-compose.yml` at the repo root, no `build:` in the host copy).

## Execution record

| Field | Value |
|---|---|
| Last executed | not yet executed |
| By | — |
| Result | — |
| Precondition needed | operator access to Shipyard (console/MCP token or Zima shell) and a green `main` build to deploy |

## Relates to

PST-REQ-163 · PST-T-13.2 · PST-T-0.10 · PST-ADR-001

See also: [`docs/runbooks/README.md`](README.md) · [`docs/runbooks/aws-port25.md`](aws-port25.md) (interim SES path if delivery is broken during a deploy).
