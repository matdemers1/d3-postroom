# Runbook: IP blocklisting

PST-T-13.2, PST-REQ-163. Builds on PST-REQ-124, `apps/worker/src/monitors/blocklist.ts`,
`apps/submission/src/caps/index.ts` (per-credential caps and freeze), `apps/delivery/src/hold.ts`
(holding a frozen credential's outbound), `apps/api/src/app-passwords/index.ts` (revoke/thaw
endpoints), and [`docs/runbooks/ses.md`](ses.md) (the fallback path while delisting is pending).

## Purpose

The edge's public IP (whose PTR is `mx.d3cloud.io`) gets listed on Spamhaus ZEN, Barracuda,
SpamCop, UCEPROTECT Level 1, PSBL or Mailspike — the six zones the `blocklist` monitor checks every
6 hours (`BLOCKLIST_INTERVAL_MS`, `BLOCKLIST_ZONES`). Respond to the alert, find the cause, get
delisted, and route around it in the meantime.

## When to use

The blocklist monitor fires:

```
[Postroom] FIRING: blocklist — <ip> listed on <zone(s)>: <zone> (<code>; delist at <url>); …
```

or `/health`'s `monitors` array shows the `blocklist` entry with `ok: false`.

## Prerequisites

- Read access to the delivery log and app-password/audit tables (or the admin console's
  equivalent screens) to find what actually sent the listed traffic.
- Admin session with step-up (`requireAdmin` + `requireStepUp` on the app-password revoke/thaw
  routes) to revoke a compromised credential or leave a cap-frozen one frozen.
- For SES: the credentials and steps in [`ses.md`](ses.md).

## Steps

### 1. Read the alert precisely

The alert names every zone that listed the IP and, for each, the code label (e.g. `XBL`, `SBL`,
`spam source`) and its `delistingUrl` (`apps/worker/src/monitors/blocklist.ts`'s
`ZONE_REGISTRY`/`defaultZoneRegistry`). A zone reported as "unknown" (query error, rate limit,
timeout) is **not** a listing — do not chase a delisting URL for it; it means that zone's own DNS
answer could not be trusted this cycle, and the monitor will recheck it.

### 2. Check what could have caused it, in order

1. **Open relay.** Confirm smtp-in and submission still require authentication for outbound
   relay and never accept a message to an outside domain without a valid app password. A quick
   external check (e.g. `telnet <edge-ip> 25` and attempting `MAIL FROM` / `RCPT TO` an
   unaffiliated domain without authenticating) should be refused. If it is not, that is the
   priority fix before anything else — a real open relay will get re-listed immediately after
   delisting.
2. **A compromised app password.** Look at recent outbound in the delivery log and app-password
   list (`GET /api/app-passwords`) for a credential sending abnormal volume or destinations it has
   never used. Revoke it:

   ```
   DELETE /api/app-passwords/:id
   ```

   (`apps/api/src/app-passwords/index.ts`) — this is immediate and irreversible; a new password
   must be issued if the account still needs to send.
3. **Outbound caps already caught it.** If the credential exceeded `SUBMISSION_CAP_HOURLY` /
   `SUBMISSION_CAP_DAILY` (or its own `dailyRecipientCap`), `enforceCaps`
   (`apps/submission/src/caps/index.ts`) already froze it and held its queued mail
   (`apps/delivery/src/hold.ts`'s `holdGroup`) — check `frozenAt` on the credential before assuming
   nothing caught this. Leave it frozen until you have confirmed the cause; only then:

   ```
   POST /api/app-passwords/:id/thaw
   ```

   which re-enqueues everything that was held (`reenqueueHeld`).
4. **Freeze/hold everything manually** if the cause is not yet isolated and mail is still going
   out: revoke or leave frozen every credential that could be responsible rather than waiting for
   the cap to catch a slower abuse pattern.

### 3. Switch to SES while delisting is pending

Delisting can take time and some zones' automated forms have their own cooldowns. Route affected
domains — or everything — through SES in the meantime (full steps in [`ses.md`](ses.md)):

```bash
DELIVERY_SES_DOMAINS=*   # or a specific list
```

Redeploy through [`deploy.md`](deploy.md). SES's own sending IPs are not the listed edge IP, so
mail keeps moving while the listing is resolved.

### 4. Request delisting, per zone

Use the `delistingUrl` the alert (or the table below) names for each zone that listed the IP:

| Zone | Delisting URL |
|---|---|
| Spamhaus ZEN | https://check.spamhaus.org/ |
| Barracuda | https://www.barracudacentral.org/rbl/removal-request |
| SpamCop | https://www.spamcop.net/bl.shtml |
| UCEPROTECT Level 1 | https://www.uceprotect.net/en/rblcheck.php |
| PSBL | https://psbl.org/remove |
| Mailspike | https://mailspike.org/appeal |

Follow each zone's own form; most ask what was fixed (cite the cause found in step 2) and will
re-check the IP automatically over the following hours to days.

### 5. Confirm the fix, then switch back

Once every listed zone shows clear (either their own web checker or the next `blocklist` monitor
cycle — up to 6 hours), narrow or remove `DELIVERY_SES_DOMAINS` and redeploy so direct delivery
resumes as the primary path.

## Verification

- `/health`'s `monitors` array shows the `blocklist` entry `ok: true` with `not listed on <zones>`
  for all six zones, or the monitor's alert shows `RESOLVED`.
- The cause is closed: the compromised app password is revoked (not just thawed) or the abusive
  sender's credential remains frozen; an open-relay check (if that was the cause) now refuses
  unauthenticated relay.
- No stray `DELIVERY_SES_DOMAINS` entries left in place beyond what step 5 intends.

## Rollback / abort

- Revoking an app password is not reversible — issue a new one if the account still needs to send.
- Thawing a credential re-enqueues its held mail; if you thaw before the cause is actually fixed,
  the same recipients may be attempted again and re-trigger the same listing. When in doubt, leave
  it frozen and confirm first.
- Turning SES on/off is fully reversible at any time (an env var + redeploy).

## Execution record

| Field | Value |
|---|---|
| Last executed | not yet executed |
| By | — |
| Result | — |
| Precondition needed | an actual blocklist alert to respond to (or a rehearsal against a real listed test IP), admin/step-up session, and — if SES is used — SES already configured per `ses.md` |

## Relates to

PST-REQ-163 · PST-REQ-124 · PST-T-13.2

See also: [`docs/runbooks/README.md`](README.md) · [`docs/runbooks/ses.md`](ses.md) (fallback transport) · [`docs/runbooks/alerts.md`](alerts.md) (how the monitor alert itself is delivered) · [`docs/runbooks/aws-port25.md`](aws-port25.md) (a different edge-IP problem, same fallback).
