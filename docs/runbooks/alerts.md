# Health alerts

PST-T-4.7; PST-REQ-096, PST-REQ-097, PST-REQ-021, PST-REQ-100.

The worker runs a set of health monitors on an interval (`MONITOR_INTERVAL_MS`, default 60 s) and
alerts the operator's external address through the **D3 Auth Cloudflare mail relay** — never through
Postroom's own outbound queue, so an alert about the mail system still arrives when the mail system
is the thing that is broken. Each condition alerts **once** when it starts, stays silent while it
holds, and alerts **once more** on recovery:

```
[Postroom] FIRING: tunnel — https://mail.d3cloud.io/health unreachable: ECONNREFUSED
[Postroom] RESOLVED: tunnel — tunnel recovered — https://mail.d3cloud.io/health answered 200
```

State (`ok` / `firing`, since when, the last detail) is persisted per monitor as a `setting` row
(`monitor:<name>`), so a worker restart mid-incident does not repeat the alert, and `/health` reports
every monitor's current status plus, separately, the NTP reading (PST-REQ-100):

```json
"monitors": [
  { "name": "tunnel", "ok": true, "detail": "https://mail.d3cloud.io/health answered 200", "since": "2026-09-26T03:00:00.000Z" },
  { "name": "backlog", "ok": true, "detail": "outbound=0 inbound=0 oldest=0s (threshold 500, max age 3600s)", "since": "2026-09-26T00:00:00.000Z" }
],
"ntp": { "synchronized": true, "offsetMs": 3.2, "server": "time.cloudflare.com", "checkedAt": "2026-09-26T03:00:00.000Z" }
```

## The monitors

| Monitor | Fires when | Env |
|---|---|---|
| `tunnel` | a GET to `TUNNEL_HEALTH_URL` times out or answers non-2xx | `TUNNEL_HEALTH_URL` (default `https://mail.d3cloud.io/health`; `''` disables) |
| `backlog` | outbound pending jobs + inbound unfiled messages exceed `BACKLOG_THRESHOLD`, or the oldest of either exceeds `BACKLOG_MAX_AGE_S` | `BACKLOG_THRESHOLD` (500), `BACKLOG_MAX_AGE_S` (3600) |
| `cert-expiry` | any cert in `TLS_CERT_FILES` is within `CERT_WARN_DAYS` of `notAfter`, or cannot be read/parsed (PST-REQ-021) | `TLS_CERT_FILES` (comma list; `''` disables), `CERT_WARN_DAYS` (14) |
| `disk` | `BLOB_ROOT` (and `PGDATA`, if set) is over `DISK_THRESHOLD_PCT` used | `DISK_THRESHOLD_PCT` (80), `PGDATA` (unset) |
| `blocklist` | `EDGE_PUBLIC_IP` is listed on the same Spamhaus ZEN zones smtp-in rejects on | `EDGE_PUBLIC_IP` (`''` disables), `DNS_RESOLVER` (`127.0.0.1:53`), `SPAMHAUS_DQS_KEY` |
| `backup-drill` | the last backup or drill failed, or either is older than `BACKUP_MAX_AGE_S` — only once backups are configured (`BACKUP_BUCKET` set); an unconfigured install never fires this | `BACKUP_MAX_AGE_S` (36 h) |
| `ntp` | SNTP offset from `NTP_SERVER` exceeds `NTP_SKEW_THRESHOLD_MS` (PST-REQ-100) | `NTP_SERVER` (`time.cloudflare.com`), `NTP_SKEW_THRESHOLD_MS` (2000) |

## The relay

Same contract as the submission caps alert (PST-REQ-096): one POST, bearer token, `{to, subject,
text}`, via `@postroom/alerts`.

| Variable | Meaning |
|---|---|
| `MAIL_RELAY_URL` | the D3 Auth relay endpoint |
| `MAIL_RELAY_TOKEN` | its bearer token |
| `ALERT_TO` | the operator's external address |

Unconfigured (any of the three empty), unreachable, or an error status all resolve to `{ sent: false
}` without throwing — a monitor still transitions and its state is still recorded, it just could not
tell anyone. The relay's own one-hour same-key dedupe cannot swallow a recovery: firing and recovery
alerts for the same monitor use distinct keys (`monitor:<name>:firing` / `monitor:<name>:recovery`).

## Blocklist monitor's resolver

`blocklist` reuses `@postroom/dnsbl`'s pure query-name and code-interpretation helpers (the same
Spamhaus ZEN zone and codes smtp-in rejects on), but performs the A-record lookup itself via Node's
built-in `dns.Resolver` pointed at `DNS_RESOLVER`, rather than going through
`@postroom/dnsbl`'s `createDnsblChecker` (which needs `@postroom/dns`'s hand-rolled `Resolver`, not a
declared dependency of `@postroom/worker` — see this task's `needsOutside`). This is a health check,
not a rejection path, so the tradeoff is a comment in `src/monitors/blocklist.ts`, not a blocker.

## Simulating each condition

- **tunnel**: point `TUNNEL_HEALTH_URL` at something that 500s or does not exist.
- **backlog**: enqueue outbound jobs past `BACKLOG_THRESHOLD`, or leave one old enough.
- **cert-expiry**: point `TLS_CERT_FILES` at a certificate expiring within 14 days (or missing).
- **disk**: fill `BLOB_ROOT`'s filesystem past 80%, or lower `DISK_THRESHOLD_PCT`.
- **blocklist**: set `EDGE_PUBLIC_IP` to a Spamhaus test/listed range.
- **backup-drill**: let `BACKUP_AT`/`DRILL_AT` skip a night, or force `postroom drill` to fail.
- **ntp**: point `NTP_SERVER` at a host with a skewed clock, or lower `NTP_SKEW_THRESHOLD_MS`.

`apps/worker/test/unit/monitors/*.test.ts` and `test/integration/monitor-*.test.ts` simulate every
one of these with an injected fake and assert exactly one alert and one recovery.

## Relates to

PST-REQ-096 · PST-REQ-097 · PST-REQ-021 · PST-REQ-100 · PST-T-4.7 · PST-T-0.16 · PST-T-0.17
