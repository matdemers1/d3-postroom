# TLS certificates by ACME DNS-01

PST-T-0.15; PST-REQ-020, PST-REQ-021; PST-ADR-010.

The mail ports (25/465/587/993/4190) present a Let's Encrypt certificate for `mx.d3cloud.io`. The
worker obtains and renews it itself, by ACME (RFC 8555) DNS-01, with a client written in
`apps/worker/src/acme/` on `node:crypto` alone. `mail.d3cloud.io` and `dav.d3cloud.io` need no
origin certificate: Cloudflare terminates their TLS at its edge.

## How it works

```mermaid
sequenceDiagram
  participant W as worker (ACME job)
  participant LE as Let's Encrypt
  participant CF as Cloudflare API (challenge zone only)
  participant NS as challenge zone's nameservers
  W->>LE: newAccount (ES256 key, sealed in the DB) / newOrder mx.d3cloud.io
  LE-->>W: authorization + dns-01 token
  W->>NS: CNAME _acme-challenge.mx.d3cloud.io ?
  NS-->>W: mx.d3cloud.io.bigfluffymurderbuffalo.com (inside the zone, so allowed)
  W->>CF: POST TXT mx.d3cloud.io.bigfluffymurderbuffalo.com (ttl 60)
  W->>NS: TXT? (every authoritative server, directly) until all serve it
  W->>LE: respond to challenge; poll authorization
  LE->>NS: follows the CNAME, reads the TXT
  W->>CF: DELETE the TXT (always, success or failure)
  W->>LE: finalize with a hand-built CSR (fresh RSA-2048 key); download chain
  W->>W: write privkey.pem then fullchain.pem atomically; audit
```

- **The delegation.** `_acme-challenge.mx.d3cloud.io` is a permanent `CNAME` to
  `mx.d3cloud.io.bigfluffymurderbuffalo.com`. Let's Encrypt follows it, so the TXT lives in the
  throwaway zone `bigfluffymurderbuffalo.com` and nothing ever writes to `d3cloud.io`. The job
  follows the CNAME itself and **refuses** any target outside `ACME_CHALLENGE_ZONE` (and refuses a
  domain with no CNAME at all) before it creates anything.
- **The token.** `ACME_DNS_TOKEN` is a Cloudflare API token with *Zone → DNS → Edit* and
  *Zone → Zone → Read* on **`bigfluffymurderbuffalo.com` only**. It is never logged.
- **Where it lands.** `ACME_CERT_DIR/mx.d3cloud.io/{fullchain.pem,privkey.pem}` on the `certs`
  volume. The worker mounts it read-write; smtp-in, submission, imap and managesieve mount it
  read-only with `TLS_CERT_FILE`/`TLS_KEY_FILE` pointing at those files and reload a new pair
  without a restart (PST-T-11.13). Each file is written to a temp name, fsynced and renamed — key
  first, then chain — and the directory fsynced; the daemons reject a key that does not match its
  certificate, so the moment between the two renames keeps the old pair serving. Key `0640`,
  directory `0750`, owned by `node` (every daemon in the image runs as `node`).
- **The account key** is ECDSA P-256, stored as the `setting` row `acme.account-key` sealed with the
  KEK — not a file on the certs volume, which four other daemons mount as the same uid. It goes out
  with the nightly backup; losing it only means a new account on the next run.
- **Staging first.** With the default (production) directory, the job's first-ever run issues from
  Let's Encrypt **staging** into `ACME_CERT_DIR/staging/mx.d3cloud.io/` and records `acme.staging`;
  only then does it contact production. A staging certificate is never written to the live path.
- **When.** A check runs a minute after the worker starts and hourly after that. It is local — read
  the pair, decide — and only reaches the network when the certificate is missing, its key does not
  match, it does not cover `ACME_DOMAINS`, or it has fewer than `ACME_RENEW_DAYS` (30) days left. So
  Let's Encrypt hears from us about every 60 days.
- **Failures** back off 1 h, 3 h, 6 h, 12 h, then daily (well inside the CA's rate limits), are
  recorded in `acme.last` (shown as `lastAcme` on the worker's `/health`) and alert through the
  D3 Auth relay. The `cert-expiry` monitor watches the live chain independently.
- **Concurrency.** A lease (`acme.lock`) keeps the daemon's timer and a manual run apart.
- **Audit.** Every issuance and renewal is an `audit_event` (`tls.certificate.issue` /
  `tls.certificate.renew`, actor `system:acme`), as is creating the account key.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `ACME_DNS_TOKEN` | — | required; the job is **off** without it |
| `ACME_DOMAINS` | — | required; comma list, first is the CN and the directory name (`mx.d3cloud.io`) |
| `ACME_CHALLENGE_ZONE` | — | `bigfluffymurderbuffalo.com` |
| `ACME_CHALLENGE_ZONE_ID` | — | `02dd41cac36fabf2542ac1b3527a618b` |
| `ACME_DIRECTORY_URL` | `https://acme-v02.api.letsencrypt.org/directory` | staging: `https://acme-staging-v02.api.letsencrypt.org/directory` (then no gate) |
| `ACME_CERT_DIR` | `/var/lib/postroom/certs` | the `certs` volume |
| `ACME_RENEW_DAYS` | `30` | renew below this many days left |
| `ACME_CONTACT` | none | optional `mailto:`; nothing is sent to Let's Encrypt unless set |
| `ACME_DNS_RESOLVER` | `DNS_RESOLVER`, else the system's | recursive resolver for the CNAME/NS lookups |
| `ACME_DNS_WAIT_MS` | `300000` | how long the TXT may take to reach every authoritative server |
| `ACME_START_DELAY_MS` / `ACME_CHECK_MS` | `60000` / `3600000` | the worker's timer |
| `TLS_CERT_FILES` (monitor) | the live `fullchain.pem` when ACME is on | set to `/var/lib/postroom/certs/mx.d3cloud.io/fullchain.pem` in the host compose |

## Steps

### Verify the token's scope

```bash
# 200: it can read the challenge zone
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ACME_DNS_TOKEN" \
  https://api.cloudflare.com/client/v4/zones/02dd41cac36fabf2542ac1b3527a618b/dns_records
# 403 (or 404/"could not route"): it cannot touch d3cloud.io
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ACME_DNS_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/<d3cloud.io zone id>/dns_records"
```

### Verify the delegation

```bash
dig +short @1.1.1.1 CNAME _acme-challenge.mx.d3cloud.io
# mx.d3cloud.io.bigfluffymurderbuffalo.com.
```

### First run: staging

In the worker container on the host (Shipyard console → worker → exec, or the host's compose):

```bash
postroom acme --staging
```

It prints a JSON summary and exits 0 on success; the certificate is under
`/var/lib/postroom/certs/staging/mx.d3cloud.io/` and the live path is untouched. Then either wait
for the timer or run `postroom acme` for production.

### Force a renewal

```bash
postroom acme --force
```

`--force` issues even when the certificate is fine and ignores the failure back-off. The daemons
reload the new pair on their own; `openssl s_client -connect mx.d3cloud.io:25 -starttls smtp`
shows the new `notAfter` once it has.

## What the alerts mean

| Alert | Meaning | Do |
|---|---|---|
| `TLS certificate renewal failed for …` | a run failed; the reason is in the body and in `/health` → `lastAcme.reason` | read the reason: a CNAME/zone refusal means the delegation changed; a Cloudflare 403 means the token was revoked or rescoped; a timeout on the TXT means the zone's nameservers are not serving it; a CA `rateLimited` means wait for the back-off |
| `… expires in N days and renewal keeps failing` | the same, with fewer than 14 days left | fix the cause, then `postroom acme --force` |
| `cert-expiry` monitor | the live chain is within `CERT_WARN_DAYS` (14) or unreadable | as above; if the file is missing the job has never issued |

## Relates to

PST-REQ-020 · PST-REQ-021 · PST-ADR-010 · PST-T-0.15 · PST-T-11.13 · PST-T-4.7
