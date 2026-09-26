# Postroom

A mail server and webmail written from scratch, as a way to understand every part of email.

SMTP in and out, submission, IMAP4rev1/rev2 (CONDSTORE/QRESYNC), CalDAV/CardDAV and Sieve are all
hand-rolled in TypeScript on Node 22, and so is every authentication check (SPF, DKIM, DMARC, ARC).
The webmail sorts your mail into buckets by itself — a reply-graph "Priority" bucket and an
explainable naive-Bayes classifier, no LLM — and every decision it makes can be inspected: which
checks passed, how a message travelled, why it landed where it did.

> [!warning] This is a personal learning build, for one domain
> Postroom serves **d3cloud.io only**. `demers.dev` stays on Outlook and is out of scope forever.
> It has not gone live, has never received or sent real mail on the public internet, and makes no
> claim of production readiness. The point of building it is understanding every part of the
> protocol stack, not competing with a mature MTA.

## Architecture

```
Internet ──25/465/587/993/4190──▶ AWS Lightsail edge (stateless) ──WireGuard, PROXY v2──▶ home
                                                                                               │
                                                               ┌───────────────────────────────┘
                                                               ▼
                                    one Docker Compose stack: a container per daemon,
                                    PostgreSQL 16, an encrypted content-addressed blob store,
                                    a validating DNS resolver
```

- **The edge** (`edge/`) is a stateless forwarder on AWS Lightsail (`us-east-1`). It holds no mail
  and no keys, terminates nothing, and only forwards the mail ports home over WireGuard with
  PROXY v2 so the home daemons see real client addresses. Outbound `:25` goes through it too —
  Comcast blocks it at home.
- **Everything else** runs on a home server (a ZimaOS box behind a Cloudflare Tunnel), deployed by
  [Shipyard](https://shipyard.d3cloud.io), never by SSH: one image with a per-daemon entrypoint
  (`smtp-in`, `submission`, `imap`, `delivery`, `dav`, `api`, `worker`), sharing the WireGuard
  sidecar's network namespace, plus PostgreSQL 16, an encrypted content-addressed blob store and a
  validating resolver.
- **The webmail** (`apps/web`) is React 19 on `@d3cloud/ui`, served by `apps/api`. Sign-in is dual:
  app-native (Argon2id + pepper + TOTP) or Sign in with D3 Auth, linked by `(iss, sub)`, never
  email.
- **Direct MX delivery** with an SES fallback adapter for outbound that can't be delivered direct.
- **Nothing listens on the public internet until the security gate passes**: the adversarial suite,
  parser fuzzing (Jazzer.js, nightly), Semgrep, gitleaks, ZAP and an ASVS 5.0 L2 self-assessment.
  MX is published only after that gate is green.

## Layout

| Path | What |
|---|---|
| `apps/` | `edge` forwarder, `smtp-in`, `submission`, `imap`, `delivery`, `dav`, `api`, `worker`, `web` |
| `packages/` | protocol parsers and shared libraries — `smtp-proto`, `mime`, `imap-proto`, `dav-proto`, `ical`, `vcard`, `sieve`, `auth-checks`, `dnsbl`, `classifier`, `threading`, `phish`, `trackers`, `blobstore`, `queue`, `crypto`, `credentials`, `audit`, `alerts`, `reports`, `dsn`, `imip`, `pgp`, `rfc5322`, `search`, `dns`, `config`, `daemon`, `db`, `proxy-protocol`, … |
| `workers/canary` | Cloudflare Worker that watches the whole thing from outside |
| `edge/` | Lightsail provisioning script and cloud-init for the stateless forwarder |
| `security/adversarial` | The adversarial test suite (PST-REQ-089/090/091's gate) |
| `fuzz/` | Jazzer.js fuzz harnesses and their seed corpora, one target per parser |
| `fixtures/golden` | Synthetic calibration mail — the only mail corpus ever committed |
| `zap/` | OWASP ZAP automation framework, authenticated scan |
| `docs/` | Runbooks, DNS records, security gate write-ups, Shipyard and D3 Auth manifests |

## Status by phase

Read against the plan of record (Foreman project `PST`, 14 phases). Built means merged to `main`
and covered by CI; nothing here is deployed to the public internet yet.

| Phase | Area | Status |
|---|---|---|
| P0 | Monorepo scaffold, one-image daemon runtime, edge forwarder + PROXY v2 codec (dev), crypto (KEK/DEK, streaming AEAD), audit transactions, blob store, API skeleton, D3 Auth manifest, CI pipeline | Built |
| P1 | SMTP wire protocol, DNS + SPF/DKIM/DMARC/ARC checks, DKIM keys (KEK-sealed), Postgres job queue with `NOTIFY`/leases/backoff/dead-letter/replay, outbound + delivery attempts, app passwords | Built |
| P2 | MIME parsing, inbound spool and verdicts, greylisting, idempotent filing | Built |
| P3 | IMAP4rev1/rev2, threading, full-text + trigram search, CalDAV/CardDAV protocol groundwork | Built |
| P4 | Security gate: adversarial suite, fuzzing, Semgrep custom rules, ASVS 5.0 L2 self-assessment (253 requirements, no open fail) | Built |
| P5–P10 | DKIM rotation, tracker/image-proxy stripping, admin Health/Jobs screens, blocklist monitor, DST-correct iCalendar/vCard with fuzzing, Sieve interpreter, retention + crypto-shred, full account export | Built |
| P11–P12 | Live edge deploy to AWS, outbound-first go-live rehearsal, later features | **Not started** |
| P13 | Public release hygiene (this phase): gitleaks over full history, README/CHANGELOG/SECURITY/CONTRIBUTING, licensing | In progress |

**Not done, explicitly:** the Lightsail edge has never been provisioned against a real AWS account;
Postroom has never sent or received mail over the public internet; MX has not been published for
any domain. The edge/WireGuard code and its provisioning scripts exist and are exercised by CI and
by the `docker-compose.e2e.yml` override, but "live" is still ahead.

## Running it locally

```bash
pnpm install
pnpm -r build
```

```bash
pnpm lint
pnpm typecheck
pnpm test                 # unit, per package
pnpm test:integration     # needs DATABASE_URL against a real PostgreSQL 16
pnpm check:corpus         # fails if a private/corpus path or stray .eml is tracked
```

The full stack, including the e2e override that fakes the WireGuard edge locally:

```bash
docker compose -f docker-compose.yml -f docker-compose.e2e.yml up --build
pnpm e2e                  # Playwright, against the composed stack
```

`pnpm fuzz:smoke` runs every Jazzer.js target for a few seconds each (a CI gate); the nightly job
(`pnpm fuzz:nightly`, `.github/workflows/fuzz.yml`) runs them longer and promotes any crasher to a
fixture — see `docs/runbooks/fuzz-crasher.md`.

## Tests, CI and the security gate

- `.github/workflows/ci.yml` — lint → unit → integration (PostgreSQL 16 service) → e2e against the
  composed stack → fuzz-smoke → `sha-` images to GHCR, on every push to `main` and every pull
  request. GitHub-hosted runners only: this repo is public, so a self-hosted runner would execute
  any fork's pull request.
- `.github/workflows/security.yml` — `gitleaks` (full history, every push/PR and nightly),
  `semgrep` (custom rules plus `p/typescript`, `p/nodejs`, `p/owasp-top-ten`, `p/jwt`, every
  push/PR), `zap` (authenticated scan of the composed stack, nightly). Every action is pinned to a
  commit SHA, every image to a digest, gitleaks' binary verified against its published SHA-256
  checksum. See `docs/security/README.md` for what each check refuses and why.
- `docs/security/asvs-l2.md` — the OWASP ASVS 5.0 Level 2 self-assessment for the webmail and API.
- `security/adversarial` — the adversarial test suite the gate depends on.

## Deploying

Deploys go through [Shipyard](https://shipyard.d3cloud.io), never by SSH — see
`docs/shipyard/postroom.yml` for the manifest and `docs/install/compose.host.yml` for the host
compose file Shipyard rewrites at deploy time.

## Runbooks and further reading

- `docs/runbooks/` — backups and restore, DKIM rotation, retention/crypto-shred, calibration
  corpus, export, SES fallback, alerts, fuzz-crasher triage
- `docs/dns.md` — the DNS records Postroom needs once the tunnel is up
- `docs/d3auth/` — the D3 Auth app manifest and registration steps
- `docs/security/` — the security gate write-up and the ASVS self-assessment
- `SECURITY.md` — how to report a vulnerability
- `CHANGELOG.md` — what exists, by area

## License

Apache-2.0 — see `LICENSE`.
