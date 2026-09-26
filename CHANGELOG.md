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
  provisioning scripts. Not yet provisioned against a real AWS account.
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
- **Public release hygiene (PST-T-13.1, PST-REQ-162).** `.gitleaks.toml` extending the default
  rule set with a narrow, path-exact allowlist for documented synthetic test material; a `gitleaks`
  job scanning full history on every push, pull request and nightly; this README, CHANGELOG,
  SECURITY.md and CONTRIBUTING.md.

### Known gaps

- The Lightsail edge has never been provisioned against a real AWS account.
- Postroom has never sent or received mail over the public internet; MX has not been published.
- Later features (Foreman phases P11–P12) are not started.

[Unreleased]: https://github.com/matdemers1/d3-postroom/commits/main
