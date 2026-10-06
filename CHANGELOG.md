# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Postroom has not cut a
release yet — everything below is `Unreleased`, summarised by area from the git log rather than by
individual commit.

## [Unreleased]

### Added

- **Monorepo and runtime.** pnpm workspace, TypeScript strict, ESLint, Vitest across `apps/` and
  `packages/`. One Docker image with a per-daemon entrypoint (`smtp-in`, `submission`, `imap`,
  `delivery`, `dav`, `api`, `worker`), sharing the WireGuard sidecar's network namespace.
- **Edge.** A stateless AWS Lightsail forwarder and PROXY v2 codec — per-IP connection caps, a
  `421` when home is unreachable, per-IP slots released on client error — plus cloud-init
  provisioning scripts. Provisioned on Lightsail in `us-east-1` with a static IP whose PTR is
  `mx.d3cloud.io`.
- **Crypto and blob store.** A sealed KEK, per-blob DEKs, streaming AEAD that never buffers a whole
  message, and an encrypted content-addressed blob store, refcounted, fsync-before-return.
- **Audit.** `audited()` transactions, request context, redaction, and a runtime mutation guard
  ("every mutating route is audited" is checked at runtime, not by a static rule).
- **SMTP and DNS.** Hand-rolled SMTP wire protocol (strict CRLF; bare LF/CR is a 5xx), a DNS
  resolver package, and SPF/DKIM/DMARC/ARC authentication checks.
- **Outbound.** KEK-sealed DKIM keys with a rotation runbook, a Postgres job queue (`SKIP LOCKED`
  claims, leases, jittered backoff, dead-letter and replay, `NOTIFY`-woken worker), outbound
  messages/recipients/delivery attempts, direct MX delivery with an SES fallback adapter.
- **Inbound.** MIME parsing that streams rather than buffers, inbound spool and verdicts,
  greylisting, idempotent filing keys.
- **Credentials.** App passwords and service accounts — protocols accept app passwords only, never
  the account password.
- **IMAP, threading and search.** IMAP4rev1/rev2 with CONDSTORE/QRESYNC, reply-graph threading,
  full-text search with trigram indexes over a generated `tsvector`.
- **Calendars and contacts.** Hand-rolled iCalendar and vCard parsers with recurrence expansion,
  DST-correct event length across a DTSTART/DTEND gap, and CalDAV/CardDAV protocol groundwork.
- **Sieve.** A parser and interpreter for the chosen extensions plus a custom
  `vnd.postroom.bucket` action.
- **Webmail sorting.** Tracker and image-proxy stripping with a per-message count badge, an
  explainable naive-Bayes classifier, reply-graph Priority — no LLM (PST-ADR-007).
- **Retention.** Retention policies with a Trash clock and crypto-shred garbage collection.
- **Export.** Full account export as an mbox plus `manifest.json`, hand-rolled ZIP writer,
  collision-safe folder names.
- **Admin and observability.** Health and Jobs screens, a blocklist monitor checking six major
  DNSBLs on a schedule, alerting through the D3 Auth mail relay (never Postroom's own queue).
- **Auth.** Dual login — app-native (Argon2id + pepper + TOTP) and Sign in with D3 Auth, identities
  linked by `(iss, sub)`, never email.
- **Security gate.** An adversarial test suite, Jazzer.js fuzz harnesses per parser (CI smoke +
  nightly deep run with crash-to-fixture promotion), custom Semgrep rules for every non-negotiable
  a machine can check, an authenticated nightly ZAP scan, and an OWASP ASVS 5.0 Level 2
  self-assessment (253 requirements, no open fail).
- **CI/CD.** `ci.yml` (lint → unit → integration → e2e → fuzz-smoke → GHCR `sha-` images) and
  `security.yml` (gitleaks, Semgrep, ZAP), every action pinned to a commit SHA and every image to a
  digest. Deploys through Shipyard, never by SSH.
- **Go-live (PST-T-4.5), 2026-09-28.** MX published as `10 mx.d3cloud.io`; the edge open to the
  internet on 25, 465, 587 and 993 (4190 closed until ManageSieve runs in production); Let's
  Encrypt certificates by ACME DNS-01; MTA-STS (testing) and TLS-RPT. AWS lifted the port-25 block
  and set the PTR; outbound is relayed through Amazon SES (`DELIVERY_SES_DOMAINS=*`) while the
  edge's address earns sending reputation. DKIM no longer covers the Message-ID SES replaces
  (PST-T-11.19), and SES's Message-ID is kept as an alias so replies thread (PST-T-11.20).
- **Webmail rebuilds.** Calm Webmail (P14, PST-ADR-011), The Finished Webmail on `@d3cloud/ui` 1.4
  with compose attachments (P15, PST-ADR-012/013), the design-audit closeout (P16), phone admin
  and Sign in with D3 Auth configured from the console (P17, PST-ADR-014/015), and the d3cloud.io
  family mark (P18).
- **PGP and S/MIME (P12).** Verify and decrypt in Inspect; sign and encrypt outbound with keys
  sealed under the KEK.
- **D3 App contract (P19–P20).** `/.well-known/d3-app.json`, native sessions, D3 Auth Bearer
  tokens, native invites, account deletion with a grace period (PST-ADR-016), and end-to-end
  encrypted push through a relay.
- **Public release hygiene (PST-T-13.1, PST-REQ-162).** `.gitleaks.toml` extending the default
  rule set with a narrow, path-exact allowlist for documented synthetic test material; a `gitleaks`
  job scanning full history on every push, pull request and nightly; this README, CHANGELOG,
  SECURITY.md and CONTRIBUTING.md.

### Known gaps

- Outbound leaves through Amazon SES, not direct from the edge: the north-star send to Gmail by
  direct MX (PST-T-1.14) has not been made, and `DELIVERY_SES_DOMAINS` has not been narrowed.
- ManageSieve (4190) is not exposed on the public edge.
- The device QA passes (iPhone Mail, Apple Mail, Thunderbird; iPhone and macOS Calendar and
  Contacts) have not been run, and their checklist is not written yet (PST-T-3.16, PST-T-3.5,
  PST-T-8.7, PST-T-11.5).
- The clean-machine restore drill with the escrowed KEK (PST-T-13.3) and the remaining runbook
  drills (PST-T-13.2) are still ahead.
- The Cloudflare canary Worker (PST-T-4.6) is not written.
- The D3 App conformance job in CI skips until it has a token for the private contract image
  (PST-T-19.5).

[Unreleased]: https://github.com/matdemers1/d3-postroom/commits/main
