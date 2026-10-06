# Postroom

A mail server and webmail written from scratch, as a way to understand every part of email.

SMTP in and out, submission, IMAP4rev1/rev2 (CONDSTORE/QRESYNC), CalDAV/CardDAV and Sieve are all
hand-rolled in TypeScript on Node 22, and so is every authentication check (SPF, DKIM, DMARC, ARC).
The webmail sorts your mail into buckets by itself — a reply-graph "Priority" bucket and an
explainable naive-Bayes classifier, no LLM — and every decision it makes can be inspected: which
checks passed, how a message travelled, why it landed where it did.

> [!warning] This is a personal learning build, for one domain
> Postroom serves **d3cloud.io only**. `demers.dev` stays on Outlook and is out of scope forever.
> It is a learning build and makes no claim of production readiness: the point of building it is
> understanding every part of the protocol stack, not competing with a mature MTA.

**Live since 2026-09-28.** Postroom has served d3cloud.io's mail since go-live (PST-T-4.5): MX is
published as `10 mx.d3cloud.io`, and the edge is open to the internet on 25, 465, 587 and 993
(4190 stays closed until a ManageSieve daemon runs in production). Outbound mail is relayed
through Amazon SES for now (`DELIVERY_SES_DOMAINS=*`) while the edge's new address earns sending
reputation — AWS has already lifted the port-25 block and set the PTR, so direct MX delivery is
the next step, not a blocker. The webmail runs at `mail.d3cloud.io`.

## Architecture

```
Internet ──25/465/587/993──▶ AWS Lightsail edge (stateless) ───────WireGuard, PROXY v2──▶ home
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
  Comcast blocks it at home. It forwards 25, 465, 587 and 993 today; 4190 (ManageSieve) is
  forwarded by the code but closed in the firewall until that daemon runs in production.
- **Everything else** runs on a home server (a ZimaOS box behind a Cloudflare Tunnel), deployed by
  [Shipyard](https://shipyard.d3cloud.io), never by SSH: one image with a per-daemon entrypoint
  (`smtp-in`, `submission`, `imap`, `delivery`, `dav`, `api`, `worker`), sharing the WireGuard
  sidecar's network namespace, plus PostgreSQL 16, an encrypted content-addressed blob store and a
  validating resolver.
- **The webmail** (`apps/web`) is React 19 on `@d3cloud/ui`, served by `apps/api`. Sign-in is dual:
  app-native (Argon2id + pepper + TOTP) or Sign in with D3 Auth, linked by `(iss, sub)`, never
  email.
- **Direct MX delivery** with an SES fallback adapter. In production every domain currently goes
  through SES (`DELIVERY_SES_DOMAINS=*`) while the edge address builds reputation; narrowing that
  list is how outbound moves to direct delivery (`docs/runbooks/ses.md`).
- **Nothing listened on the public internet until the security gate passed**: the adversarial
  suite, parser fuzzing (Jazzer.js, nightly), Semgrep, gitleaks, ZAP and an ASVS 5.0 L2
  self-assessment. The gate report went green (`security/gate-report.md`) before MX was published
  on 2026-09-28, and those checks keep running in CI.

## Layout

| Path | What |
|---|---|
| `apps/` | `edge` forwarder, `smtp-in`, `submission`, `imap`, `delivery`, `dav`, `api`, `worker`, `web` |
| `packages/` | protocol parsers and shared libraries — `smtp-proto`, `mime`, `imap-proto`, `dav-proto`, `ical`, `vcard`, `sieve`, `auth-checks`, `dnsbl`, `classifier`, `threading`, `phish`, `trackers`, `blobstore`, `queue`, `crypto`, `credentials`, `audit`, `alerts`, `reports`, `dsn`, `imip`, `pgp`, `rfc5322`, `search`, `dns`, `config`, `daemon`, `db`, `proxy-protocol`, … |
| `workers/canary` | Cloudflare Worker that will watch the whole thing from outside (PST-T-4.6, not written yet) |
| `edge/` | Lightsail provisioning script and cloud-init for the stateless forwarder |
| `security/adversarial` | The adversarial test suite (PST-REQ-089/090/091's gate) |
| `fuzz/` | Jazzer.js fuzz harnesses and their seed corpora, one target per parser |
| `fixtures/golden` | Synthetic calibration mail — the only mail corpus ever committed |
| `zap/` | OWASP ZAP automation framework, authenticated scan |
| `docs/` | Runbooks, DNS records, security gate write-ups, Shipyard and D3 Auth manifests |

## Status by phase

Read against the plan of record, Foreman project `PST`, which has 21 phases (P0–P20). Complete means
Foreman has closed the phase; in progress means it is open, usually on an operator step (device
QA, a drill, the north-star send) rather than on code.

| Phase | Name | Status |
|---|---|---|
| P0 | Foundation — monorepo, CI, schema, crypto, blob store, audit, dual login, Shipyard deploy, Lightsail edge | In progress |
| P1 | The North Star — Outbound: submission, queue, DKIM, direct MX delivery, SES fallback | In progress |
| P2 | Inbound Core: smtp-in, streaming MIME, SPF/DKIM/DMARC/ARC, durable 250 | Complete |
| P3 | IMAP and Basic Webmail | In progress |
| P4 | Security Gate and Go-Live: gate report, MX, MTA-STS, TLS-RPT | In progress |
| P5 | The Self-Sorting Inbox | Complete |
| P6 | Transparency: Inspect, tracker blocking, live SMTP viewer, delivery timeline | Complete |
| P7 | Deliverability and Operations | In progress |
| P8 | Calendars and Contacts | In progress |
| P9 | Composer and Rules | Complete |
| P10 | Data and Accounts | Complete |
| P11 | Hardening | In progress |
| P12 | PGP and S/MIME | Complete |
| P13 | Ship: public release, runbooks, clean-machine restore drill | In progress |
| P14 | Calm Webmail | Complete |
| P15 | The Finished Webmail | Complete |
| P16 | Design Audit Closeout | In progress |
| P17 | Phone Admin and Close-out Polish | Complete |
| P18 | Family Mark | Complete |
| P19 | Native App Contract | In progress |
| P20 | Native App Contract II — Links, Account Lifecycle & Push | In progress |

**Not done, explicitly:** outbound mail has not yet been delivered direct from the edge to Gmail
(the north-star run, PST-T-1.14) — today it leaves through SES; the device QA passes on iPhone
Mail, Apple Mail and Thunderbird have not been run; the clean-machine KEK restore drill is still
ahead (PST-T-13.3); ManageSieve is not exposed publicly.

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
- `docs/dns.md` — the DNS records Postroom publishes, MX included
- `docs/d3auth/` — the D3 Auth app manifest and registration steps
- `docs/security/` — the security gate write-up and the ASVS self-assessment
- `SECURITY.md` — how to report a vulnerability
- `CHANGELOG.md` — what exists, by area

## License

Apache-2.0 — see `LICENSE`.
