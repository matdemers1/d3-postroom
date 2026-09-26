# Health alerts

PST-T-4.7, PST-T-7.3; PST-REQ-096, PST-REQ-097, PST-REQ-021, PST-REQ-100, PST-REQ-124.

The worker runs a set of health monitors on an interval (`MONITOR_INTERVAL_MS`, default 60 s) and
alerts the operator's external address through the **D3 Auth Cloudflare mail relay** — never through
Postroom's own outbound queue, so an alert about the mail system still arrives when the mail system
is the thing that is broken. Each condition alerts **once** when it starts, stays silent while it
holds, and alerts **once more** on recovery:

```
[Postroom] FIRING: tunnel — tunnel — https://mail.d3cloud.io/health unreachable: ECONNREFUSED
[Postroom] RESOLVED: tunnel — tunnel recovered — https://mail.d3cloud.io/health answered 200
```

State (`ok` / `firing`, since when, the last detail, and whether the alert for that transition was
actually delivered) is persisted per monitor as a `setting` row (`monitor:<name>`), so a worker
restart mid-incident does not repeat the alert, and `/health` reports every monitor's current status
plus, separately, the NTP reading (PST-REQ-100):

```json
"monitors": [
  { "name": "tunnel", "ok": true, "detail": "https://mail.d3cloud.io/health answered 200", "since": "2026-09-26T03:00:00.000Z", "alert": "delivered" },
  { "name": "backlog", "ok": true, "detail": "outbound=0 inbound=0 oldest=0s (threshold 500, max age 3600s)", "since": "2026-09-26T00:00:00.000Z", "alert": "delivered" }
],
"ntp": { "synchronized": true, "offsetMs": 3.2, "server": "time.cloudflare.com", "checkedAt": "2026-09-26T03:00:00.000Z" }
```

## The monitors

| Monitor | Fires when | Env |
|---|---|---|
| `tunnel` | a GET to `TUNNEL_HEALTH_URL` times out or answers non-2xx | `TUNNEL_HEALTH_URL` (unset/`''` **disables** — see Production values) |
| `backlog` | outbound pending jobs + inbound unfiled messages exceed `BACKLOG_THRESHOLD`, or the oldest of either exceeds `BACKLOG_MAX_AGE_S` | `BACKLOG_THRESHOLD` (500), `BACKLOG_MAX_AGE_S` (3600) |
| `cert-expiry` | any cert in `TLS_CERT_FILES` is within `CERT_WARN_DAYS` of `notAfter`, or cannot be read/parsed (PST-REQ-021) | `TLS_CERT_FILES` (comma list; `''` disables), `CERT_WARN_DAYS` (14) |
| `disk` | `BLOB_ROOT` (and `PGDATA`, if set) is over `DISK_THRESHOLD_PCT` used | `DISK_THRESHOLD_PCT` (80), `PGDATA` (unset) |
| `blocklist` | `EDGE_PUBLIC_IP` is listed on any of the major blocklists it checks (PST-REQ-124) | `EDGE_PUBLIC_IP` (`''` disables), `DNS_RESOLVER` (`127.0.0.1:53`), `SPAMHAUS_DQS_KEY`, `BLOCKLIST_ZONES`, `BLOCKLIST_INTERVAL_MS` (6h) |
| `backup-drill` | the last backup or drill failed, or either is older than `BACKUP_MAX_AGE_S` — only once backups are configured (`BACKUP_BUCKET` set); an unconfigured install never fires this | `BACKUP_MAX_AGE_S` (36 h) |
| `ntp` | SNTP offset from `NTP_SERVER` exceeds `NTP_SKEW_THRESHOLD_MS` (PST-REQ-100) | `NTP_SERVER` (unset/`''` **disables** — see Production values), `NTP_SKEW_THRESHOLD_MS` (2000) |

Every monitor's `check()` runs under a hard ceiling (`MONITOR_CHECK_TIMEOUT_MS`, default 30 s) — a
hung check (a stuck DNS lookup, a wedged socket) times out and is treated as a firing condition
rather than hanging every monitor behind it, or every future tick. The runner also refuses to start
a new tick while a previous one is still in flight (logged as `monitor-tick-skipped`), so a slow
monitor never causes two ticks to run concurrently against the same state.

## Production values (not defaulted — reach the public internet only when told to)

`tunnel` and `ntp` are the only two monitors that reach past the host's own filesystem/database, and
both are **off unless configured** — an unconfigured install must never phone home on its own. Set
on the host:

```
TUNNEL_HEALTH_URL=https://mail.d3cloud.io/health
NTP_SERVER=time.cloudflare.com
```

With neither set, `/health`'s `ntp` field reads the string `"not configured"` (not an object), and
`tunnel` is simply absent from the `monitors` array.

## Delivery: an alert only counts once it is actually sent

The persisted `state` for a monitor only advances past a transition once the alert for that
transition was **delivered** — sent successfully, or explicitly accepted as undeliverable because
the relay is unconfigured (`MAIL_RELAY_URL`/`MAIL_RELAY_TOKEN`/`ALERT_TO` any empty). A *configured*
relay that fails to send (network error, timeout, non-2xx) does **not** advance the state: the same
transition is retried, with the same dedupe key, on every subsequent tick until it goes through — or
until the underlying condition reverts on its own before it was ever reported, in which case the
episode is dropped silently (the operator was never told it was firing, so no recovery is owed
either). `/health`'s `alert` field on each monitor reads one of:

- `"delivered"` — the last transition's alert was actually sent (or successfully deduped as a repeat).
- `"not delivered: relay unconfigured"` — the relay has no `MAIL_RELAY_URL`/`TOKEN`/`ALERT_TO`; this
  will never be retried, since configuring it is the only fix.
- `"not delivered: <reason>"` — a configured relay's send failed; this **is** retried each tick.

## Flapping: one dedupe key per episode

Each firing-to-recovery episode gets its own key (`monitor:<name>:<target>:<iso timestamp>:<uuid>`),
generated once when the transition is first detected and reused for every retry of that same
transition. `@postroom/alerts`' one-hour same-key dedupe therefore only ever suppresses a genuine
repeat of the exact same undelivered attempt — a fresh episode (fire → recover → fire again, all
within the hour) sends three separate alerts, not one.

## The relay

Same contract as the submission caps alert (PST-REQ-096): one POST, bearer token, `{to, subject,
text}`, via `@postroom/alerts`.

| Variable | Meaning |
|---|---|
| `MAIL_RELAY_URL` | the D3 Auth relay endpoint |
| `MAIL_RELAY_TOKEN` | its bearer token |
| `ALERT_TO` | the operator's external address |

## Blocklist monitor: six major lists, checked every 6 hours (PST-T-7.3, PST-REQ-124)

`blocklist` checks `EDGE_PUBLIC_IP` against six major blocklists by default (override the set with
`BLOCKLIST_ZONES`, a comma list of registry keys):

| Key | Zone | Delisting |
|---|---|---|
| `spamhaus` | `zen.spamhaus.org` (or `<key>.zen.dq.spamhaus.net` with `SPAMHAUS_DQS_KEY`) | https://check.spamhaus.org/ |
| `barracuda` | `b.barracudacentral.org` | https://www.barracudacentral.org/rbl/removal-request |
| `spamcop` | `bl.spamcop.net` | https://www.spamcop.net/bl.shtml |
| `uceprotect1` | `dnsbl-1.uceprotect.net` | https://www.uceprotect.net/en/rblcheck.php |
| `psbl` | `psbl.surriel.com` | https://psbl.org/remove |
| `mailspike` | `bl.mailspike.net` | https://mailspike.org/appeal |

Each zone's A-record answers are interpreted per its own documented codes (`src/monitors/blocklist.ts`
— e.g. Spamhaus's SBL/SBL CSS/XBL/DROP/PBL, Mailspike's reputation range) — a separate, generalised
copy of the interpretation `@postroom/dnsbl` uses for smtp-in's live rejection path, since that
package's Spamhaus-only code table must keep smtp-in's behaviour unchanged. A zone's own signalling
codes (Spamhaus's 127.255.255.x: malformed query, public resolver, rate limit) are never treated as a
listing; if every queried zone comes back as a query error, the check reports "unknown", not clean.
A firing detail names exactly which zone(s) listed the IP, the matched code's label, and that zone's
delisting URL — never the zones that came back clean.

The lookup itself goes via Node's built-in `dns.Resolver` pointed at `DNS_RESOLVER`, reusing only
`@postroom/dnsbl`'s pure query-name helper (`dnsblQueryName`) — not `createDnsblChecker` (which needs
`@postroom/dns`'s hand-rolled `Resolver`, not a declared dependency of `@postroom/worker` — see this
task's `needsOutside`). This is a health check, not a rejection path.

**Cadence:** DNSBL operators rate-limit, and some ban a frequent querier, so `blocklist` sets a
`minIntervalMs` (`BLOCKLIST_INTERVAL_MS`, default 6h) on the `Monitor` contract, honoured generically
by the runner: between real queries, the runner reuses the monitor's last persisted result (from its
`monitor:blocklist` setting row's `checkedAt`) rather than calling `check()` again, on the normal 60s
tick just like every other monitor. Because `checkedAt` is persisted, this holds across a worker
restart too — a fresh process reading a recent `checkedAt` does not immediately re-query. Any other
monitor can opt into the same generic minimum spacing by setting `minIntervalMs`.

## NTP: a validated SNTP reply, not a trusted one

`ntp`'s SNTP client (`src/monitors/sntp.ts`) rejects a reply rather than using it when: it is shorter
than 48 bytes; its mode is not 4 (server); its stratum is 0 (a kiss-of-death — surfaced as
`SntpKissOfDeathError` with the four-character code, e.g. `RATE`, `DENY`) or above 15; its version is
not 3 or 4; or its Originate Timestamp does not exactly echo the Transmit Timestamp this query sent
(a stale reply to an earlier query, or a forgery). The client's socket is `connect()`-ed to the one
server it queried, so the OS itself discards any datagram from a different address or port before it
ever reaches the reply handler.

## Simulating each condition

- **tunnel**: point `TUNNEL_HEALTH_URL` at something that 500s or does not exist.
- **backlog**: enqueue outbound jobs past `BACKLOG_THRESHOLD`, or leave one old enough.
- **cert-expiry**: point `TLS_CERT_FILES` at a certificate expiring within 14 days (or missing).
- **disk**: fill `BLOB_ROOT`'s filesystem past 80%, or lower `DISK_THRESHOLD_PCT`.
- **blocklist**: set `EDGE_PUBLIC_IP` to a range listed on one of the six zones (e.g. a Spamhaus
  test/listed range), or lower `BLOCKLIST_INTERVAL_MS` to see a real re-query sooner.
- **backup-drill**: let `BACKUP_AT`/`DRILL_AT` skip a night, or force `postroom drill` to fail.
- **ntp**: point `NTP_SERVER` at a host with a skewed clock, or lower `NTP_SKEW_THRESHOLD_MS`.

`apps/worker/test/unit/monitors/monitor-checks.test.ts`, `monitor-sntp.test.ts`,
`monitor-runner.test.ts` and `monitor-build.test.ts` cover each monitor's pure logic, the runner's
delivery/retry/flapping/overlap/timeout behaviour (with the **real** `@postroom/alerts` sender in the
flapping test), and the off-by-default tunnel/ntp wiring, with fakes at the edges.
`apps/worker/test/integration/monitor-coverage.test.ts` wires all **7 real monitors** — their actual
`check()` implementations, not stand-ins — through the real runner and a real test database, each
with a fake only at its own external edge (fetch, statfs, a DNSBL lookup, an SNTP query, the
certificate's clock, and real `job`/`inbound_message`/`setting` rows), asserting exactly one FIRING
and one RESOLVED alert per monitor. `monitor-backlog.test.ts`, `monitor-backup.test.ts` and
`monitor-alerts.test.ts` cover backlog/backup-drill in more depth and the "queue stopped"/persisted
restart properties.

## Relates to

PST-REQ-096 · PST-REQ-097 · PST-REQ-021 · PST-REQ-100 · PST-REQ-124 · PST-T-4.7 · PST-T-7.3 · PST-T-0.16 · PST-T-0.17
