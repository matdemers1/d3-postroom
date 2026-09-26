# Security Policy

Postroom is a personal, public, Apache-2.0 learning build — a hand-rolled mail server and webmail
for one domain (`d3cloud.io`). It has not gone live: it has never sent or received mail on the
public internet, and MX has not been published for any domain. Even so, real reports about real
risk are welcome and are read.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security report.**

Use GitHub's private vulnerability reporting instead:
[github.com/matdemers1/d3-postroom/security/advisories/new](https://github.com/matdemers1/d3-postroom/security/advisories/new).
That opens a private advisory visible only to the maintainer and you, with its own thread for
follow-up questions and, if a fix is needed, a coordinated disclosure timeline.

Please include, where you can:

- What you found and why it's a security issue (not just a bug)
- Steps to reproduce, or a proof of concept
- The affected file(s), commit, or component (daemon, package, webmail)
- Any suggested fix or mitigation

## Supported versions

Postroom has not cut a tagged release. Reports are accepted and triaged against the `main` branch
only — there is no older version receiving separate security fixes.

## Scope

In scope:

- Everything in this repository: `apps/`, `packages/`, `edge/`, `workers/canary`, `zap/`,
  `security/`, `fuzz/`, and the Docker/Compose deployment configuration.
- The protocol implementations (SMTP, IMAP, CalDAV/CardDAV, Sieve), the authentication checks
  (SPF/DKIM/DMARC/ARC), crypto (KEK/DEK sealing, streaming AEAD), and the webmail/API.

Out of scope:

- **`demers.dev`** — that domain stays on Outlook and is not served by Postroom, now or ever.
- Findings that require an already-compromised home network, host, or WireGuard peer.
- Denial-of-service reports against a system that is not deployed publicly.
- Automated scanner output with no manual verification of exploitability.
- Third-party dependencies — please report those upstream (and feel free to also open an issue
  here if Postroom should update a pinned version in response).

## Disclosure expectations

This is maintained by one person as a learning project, not a company with an SLA. In good faith:

- An acknowledgement is the goal within a reasonable time of a private advisory being opened.
- A genuine, in-scope vulnerability gets a fix or a documented mitigation before any public
  disclosure of details.
- Credit is offered in the advisory and the changelog, unless you'd rather stay anonymous.
- Given the project's status (not live, no real user data, no production traffic), most findings
  will be fixed on a normal development cadence rather than as an emergency — but will not be
  ignored.

## What the codebase already does about this

- A security gate (`.github/workflows/security.yml`) runs `gitleaks` over full history, Semgrep
  (custom rules plus standard registry packs) on every push and pull request, and an authenticated
  ZAP scan nightly. See `docs/security/README.md`.
- An OWASP ASVS 5.0 Level 2 self-assessment covers the webmail and its API — `docs/security/asvs-l2.md`.
- Every mutation is audited; protocols accept app passwords only, never the account password; the
  edge holds no mail and no keys; there is no relay from any source. See `CLAUDE.md` for the full
  list of non-negotiables.
