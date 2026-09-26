# Security gate — static analysis, dynamic scan, ASVS

PST-T-4.3. Three of the gate's checks live here; the adversarial suite (PST-T-4.1, `security/`) and
fuzzing (PST-T-4.2, `fuzz/`) are the others. Nothing listens publicly until all of them pass
(PST-REQ-086).

| Check | Requirement | Where | Runs | Fails on |
|---|---|---|---|---|
| Semgrep | PST-REQ-089 | `.semgrep/postroom.yml`, `.semgrepignore`, `.github/workflows/security.yml` job `semgrep` | every push to main and every pull request | any finding |
| ZAP, authenticated | PST-REQ-090 | `zap/`, `.github/workflows/security.yml` job `zap` | nightly 06:41 UTC, and by hand | any High |
| ASVS 5.0 L2 | PST-REQ-091 | `docs/security/asvs-l2.md` | when auth, sessions, headers or the API change | an open fail |

## Semgrep

The registry packs `p/typescript`, `p/nodejs`, `p/owasp-top-ten` and `p/jwt`, plus Postroom's own
rules in `.semgrep/postroom.yml` — one per non-negotiable a machine can check:

| Rule | Refuses |
|---|---|
| `postroom.dynamic-code` | `eval`, `new Function`, string timers |
| `postroom.shell-command-injection` | `child_process` `exec`/`execSync`, or any spawn with `shell: true` |
| `postroom.reflected-user-input` | request input in `res.send`/`write`/`end` |
| `postroom.secret-in-log` | a password, token, secret, pepper, key or cookie on `console` or stdout/stderr |
| `postroom.raw-sql-interpolated` | `$queryRawUnsafe`/`$executeRawUnsafe`/`Prisma.raw` with a built string |
| `postroom.insecure-randomness` | `Math.random()` in shipped source |
| `postroom.tls-verification-disabled` | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| `postroom.bare-lf-on-the-wire` | a socket write ending in `\n` without `\r` in the SMTP/IMAP daemons (PST-REQ-049) |
| `postroom.web-third-party-request` | an absolute-URL `fetch`, `WebSocket`, `EventSource`, beacon or dynamic import in the webmail (PST-REQ-159) |
| `postroom.web-third-party-script-tag` | an off-origin `<script>`, `<link>`, `<img>` or `<iframe>` in the webmail's HTML |
| `postroom.cookie-without-httponly` | `res.cookie` without `httpOnly: true` and a `sameSite` |

Every rule has cases that must match (`ruleid:`) and cases that must not (`ok:`) in
`.semgrep/postroom.ts` and `.semgrep/postroom.html`. CI runs them first, then plants an `eval()` in
`apps/api/src` and requires the scan to fail, then scans the repository and requires zero findings.

"Every mutating route is audited" (PST-REQ-009) is not a rule: whether a handler audits depends on
calls several modules away. `mutationAuditGuard` checks it at runtime instead, and the auth and OIDC
integration suites end with "left no successful mutation unaudited".

**Exceptions** are written in the rule file, never hidden: each names the file, why it is right
there, and what would retire it. There are three — the restore drill's `CREATE DATABASE` (no bind
parameter exists for a name), opportunistic STARTTLS to remote MXes (RFC 3207, until MTA-STS/DANE in
PST-T-7.5), and the app-password decoy's `Math.random()` in `@postroom/credentials`. The registry's
`bypass-tls-verification` rule is excluded on the command line because `postroom.tls-verification-disabled`
replaces it with the same check and that one written exception. Inline `nosemgrep` appears twice,
each with its reason beside it: the service-account CLI printing a new password to the operator's
terminal, and `zap/session.mjs` handing the scan's cookie to `run.sh`.

Run it locally (no Docker needed):

```bash
python3 -m venv .venv-semgrep && .venv-semgrep/bin/pip install semgrep==1.176.1
(cd .semgrep && ../.venv-semgrep/bin/semgrep --test --metrics=off .)
.venv-semgrep/bin/semgrep scan --metrics=off --error \
  --config p/typescript --config p/nodejs --config p/owasp-top-ten --config p/jwt \
  --config .semgrep/postroom.yml \
  --exclude-rule problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification .
```

Semgrep scans the files git tracks: stage a new file before expecting it to be scanned.

## ZAP

`zap/run.sh` against a stack on a **fresh database**, composed as CI's e2e job composes it:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.e2e.yml E2E_KEK="$(openssl rand -base64 32)"
docker build -t ghcr.io/matdemers1/d3-postroom/server:local . && docker compose build wireguard
docker compose up -d --wait postgres
docker compose run --rm migrate && docker compose run --rm migrate seed
docker compose up -d --wait
./zap/run.sh            # reports in zap/report/
```

`zap/session.mjs` runs first-run setup through the API — display name, login, a random password,
then a TOTP code computed from the secret setup returns — and hands the session cookie to ZAP. On a
stack that already has an operator, set `ZAP_LOGIN`, `ZAP_PASSWORD` and `ZAP_TOTP_SECRET` instead.
`zap/automation.yaml` rides that cookie and the CSRF header, seeds every GET route the web app calls,
spiders, runs the active scan, writes HTML and JSON reports, and exits non-zero on any High.
Signing out, ending sessions, changing the password, setup and the SSE stream are out of the active
scan's scope, because attacking them logs the scanner out or hangs it.

The gate cites the latest nightly run's `zap-report` artifact (kept 90 days).

## ASVS

`asvs-l2.md` is the self-assessment: all 253 Level 1 and 2 requirements, each with a status and its
evidence, and the documented controls several requirements ask for. To recount after editing it,
check that every row's ID appears once and matches the standard's level:

```bash
curl -sSLo /tmp/asvs.csv https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0_release/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv
grep -oE '^\| [0-9]+\.[0-9]+\.[0-9]+ \| [12] ' docs/security/asvs-l2.md | wc -l    # 253
```

Reassess an accepted deviation whenever the context it rests on changes (the callout at the top of `asvs-l2.md`).
