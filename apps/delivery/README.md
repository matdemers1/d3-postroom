# @postroom/delivery

The outbound delivery daemon: the `outbound` queue on PostgreSQL (PST-T-1.5), the hand-rolled
direct MX client (PST-T-1.6), DSNs (PST-T-1.7) and the SES smarthost fallback (PST-T-1.11).

## Transports

A recipient is attempted through one transport, chosen by the worker **at each attempt**
(`routeByClaims` in `src/worker.ts`):

1. a transport that claims the recipient's domain (SES, for `DELIVERY_SES_DOMAINS`), else
2. the transport the recipient was enqueued with (`OutboundRecipient.transport`), else
3. `direct`.

Every `DeliveryAttempt` row records the transport actually used, and its `mxHost`/`mxIp`/TLS
columns describe the host it talked to — for SES, the SES endpoint. Queue, retries and outcome
classification (2xx delivered, 4xx temporary, 5xx permanent) are the same whichever transport ran.

| Variable | Meaning |
|---|---|
| `DNS_RESOLVER` | our validating resolver, `host:port`; every name (MX targets, the SES host) goes through it |
| `MX_HOSTNAME` | EHLO name, default `mx.d3cloud.io` |
| `DELIVERY_IPV6=1` | also dial AAAA (off until IPv6 reverse DNS exists) |
| `SES_SMTP_HOST` or `SES_REGION` | SES SMTP endpoint; `SES_REGION=us-east-1` gives `email-smtp.us-east-1.amazonaws.com` |
| `SES_SMTP_PORT` | default 587 (STARTTLS) |
| `SES_SMTP_USER[_FILE]`, `SES_SMTP_PASSWORD[_FILE]` | SES SMTP credentials |
| `DELIVERY_SES_DOMAINS` | comma-separated recipient domains relayed via SES (exact match); `*` = everything |

SES is only selectable when host, user and password are all set. Otherwise the daemon logs
`ses-disabled` once at start (naming the missing variables, never a value) and every recipient —
including one enqueued as `ses` — goes direct. The SES session requires STARTTLS, verifies the
certificate against the SES host name, and only then authenticates (AUTH PLAIN, else LOGIN); a
refused credential defers mail, it never bounces it. The stored, already DKIM-signed blob is
streamed unchanged, so the signature survives. Operating it: `docs/runbooks/ses.md`.

## Outbound TLS policy: DANE and MTA-STS

PST-REQ-126, PST-T-7.5, `src/policy/`. Before dialling, the direct transport decides per MX host
what TLS the session must have:

| Policy | When | Rule |
|---|---|---|
| `dane` | MX RRset, the host's A/AAAA **and** `_25._tcp.<mx>` TLSA all carry AD from our resolver, and at least one record is DANE-TA(2)/DANE-EE(3) | STARTTLS required; the presented chain must match a record (RFC 7672). Takes precedence over MTA-STS |
| `mta-sts-enforce` | `_mta-sts.<domain>` TXT + policy at `https://mta-sts.<domain>/.well-known/mta-sts.txt` in `enforce` | only MX hosts matching the policy are dialled; STARTTLS required; WebPKI certificate valid for the MX name |
| `mta-sts-testing` | policy in `testing` | opportunistic, but what enforce would have said is recorded |
| `opportunistic` | everything else | STARTTLS when offered, any certificate (RFC 3207), as before |

A mandatory policy that is not met (no STARTTLS, a bad certificate, a TLSA mismatch, an MX outside
the policy, a failed TLSA lookup) is a **temporary** failure (`4.7.5`) with the reason in the
attempt's text: mail waits and retries, it is never sent in plaintext. The decision is recorded on
every `DeliveryAttempt` in `tls_peer` as `tls-policy=<policy>; policy-verified=yes|no;
policy-reason=<why>` followed by the certificate summary. A plaintext opportunistic delivery leaves
the TLS columns empty, as before.

Policies are cached per domain for `max_age` and refetched when the TXT id changes; the default
cache is in memory (`createSettingPolicyStore` persists to the `setting` table when given a Prisma
delegate). The policy fetch resolves `mta-sts.<domain>` through our resolver, verifies the
certificate against the system roots, follows no redirects, requires `text/plain`, and caps size
(64 KiB) and time (10 s). Operating it: `docs/runbooks/outbound-tls.md`.

## Tests

```bash
pnpm --filter @postroom/delivery test                 # unit, including the loopback SES smarthost
DATABASE_URL=postgres://… pnpm --filter @postroom/delivery test:integration
```
