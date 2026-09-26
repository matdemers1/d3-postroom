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

## Tests

```bash
pnpm --filter @postroom/delivery test                 # unit, including the loopback SES smarthost
DATABASE_URL=postgres://… pnpm --filter @postroom/delivery test:integration
```
