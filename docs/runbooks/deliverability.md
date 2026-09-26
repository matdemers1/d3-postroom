# Deliverability reports (DMARC aggregate and TLS-RPT)

PST-T-7.1, PST-REQ-122. Receivers mail us DMARC aggregate reports (RFC 7489 Appendix C) and SMTP TLS
reports (RFC 8460). Postroom reads them out of a service mailbox and charts them on
**Admin → Deliverability** (`/admin/deliverability`, API `GET /api/admin/deliverability?days=N`).

## How it works

1. The DMARC record's `rua=` and the `_smtp._tls` record's `rua=` point at report mailboxes.
2. Mail to those addresses is delivered like any other mail (smtp-in → inbound pipeline → filed).
3. The worker's **report sweep** (`apps/worker/src/reports`, every `REPORTS_SWEEP_MS`, default 10 s)
   finds messages in those accounts' receiving folders (every folder except Sent, Drafts, Trash and
   Rejects — the classifier may file a report under Updates) that have no `report_ingest` row, reads
   their attachments with `@postroom/reports`, and stores `dmarc_report`/`dmarc_record` and
   `tlsrpt_report`/`tlsrpt_policy`/`tlsrpt_failure` rows. Every write is audited, actor `system`.
4. `report_ingest` holds one row per message read, with its outcome: `ingested`, `duplicate` (the
   same `(org_name, report_id)` was already stored — a re-delivery), `no-report`, or `error` with the
   `ReportError` code in `detail`. A parse error is not retried; a database error leaves no row and
   the next tick retries.

Accepted containers: `.xml`, `.xml.gz`, `.zip` (exactly one entry, STORED or DEFLATE, CRC checked,
no encryption, no ZIP64), `.json`, `.json.gz`. Decompressed size is capped at 32 MiB, attachments at
16 MiB. The XML reader refuses any DOCTYPE, so there is no XXE and no entity expansion.

### Foreign reports (PST-T-7.9, PST-REQ-122)

Every stored `dmarc_report` / `tlsrpt_report` row carries a `status` (`ours` | `foreign`) and a
`reason`. At ingest, the worker checks the report's own domain — the DMARC report's
`policy_published/domain`, or (for TLS-RPT) whether *any* of `policies[].policy-domain` — against
the `domain` table (`apps/worker/src/reports/domains.ts`). A report about a domain we do not own
(a misdirected `rua=`, a shared reporting address, or a receiver batching several domains to one
address) is still stored — it is evidence, and it is audited exactly like any other row — but it is
marked `foreign` and **excluded from every Deliverability aggregate query** (`d.status = 'ours'` /
`t.status = 'ours'` on each one in `apps/api/src/deliverability/aggregate.ts`). Rows written before
this existed default to `ours`.

To see what came in foreign: `SELECT org_name, report_id, domain, reason FROM dmarc_report WHERE
status = 'foreign';` (and the equivalent on `tlsrpt_report`).

## Setting it up

1. Create the service mailboxes on **Admin → Service accounts**: local part `dmarc` and `tlsrpt`
   (or whatever `REPORTS_MAILBOX` / `TLSRPT_MAILBOX` name). No app password is needed — nothing
   submits through them.
2. Publish the records (verify with `dig @1.1.1.1`, never the local resolver):
   ```
   _dmarc.d3cloud.io.     TXT "v=DMARC1; p=quarantine; rua=mailto:dmarc@d3cloud.io"
   _smtp._tls.d3cloud.io. TXT "v=TLSRPTv1; rua=mailto:tlsrpt@d3cloud.io"
   ```
   Never touch `no-reply.d3cloud.io`'s records — that subdomain belongs to Cloudflare Email Service.
3. Reports arrive about once a day per receiver. Google and Microsoft are the first two to expect.

## Configuration (worker)

| Variable | Default | Meaning |
|---|---|---|
| `REPORTS_MAILBOX` | `dmarc@<primary domain>` | DMARC report address(es), comma-separated |
| `TLSRPT_MAILBOX` | `tlsrpt@<primary domain>` | TLS-RPT report address(es), comma-separated |
| `REPORTS_SWEEP_MS` | `10000` | How often the sweep looks for new messages |

API: `DELIVERABILITY_RDNS=0` turns off the reverse-DNS column (lookups are bounded to the 25 busiest
sources, one second, cached for an hour).

## DMARC progression proposals (PST-T-7.2, PST-REQ-123)

`GET /api/admin/deliverability/proposals` returns one result per domain we own. For each, it checks
the 14 whole UTC days before today: if every one of them has at least one (`ours`) report, and every
record in every one of those reports is **clean** — `disposition = none`, an aligned DKIM or SPF
pass, and the source is one we authorize — it proposes moving one stage
(`none → quarantine → reject`), or ramping `pct` toward 100 first if the current record is not yet
at `pct=100`. One unclean or unauthorized record, or one missing day, resets the streak, and the
response says which day and why (`reason`). A proposal never disappears silently: it is
`{ eligible: false, proposal: null, reason: "…" }` until the streak completes.

"Authorized source" (`apps/api/src/deliverability/authorized.ts`) is deliberately narrow and
independent of SPF's own DNS-driven evaluation, so it never trusts something a spoofer's SPF record
could grant: it is exactly `EDGE_PUBLIC_IP` (our one outbound edge, PST-ADR-002) plus, only when
`SES_SMTP_USER` is set, the CIDR ranges in `SES_IP_RANGES` (comma-separated; there is no fixed,
publishable list of AWS SES sending ranges, so this must be entered by the operator to match
whatever SES actually assigns). Set both to match what the domain's own SPF record authorizes —
Postroom does not read DNS for this and never publishes DNS on the operator's behalf.

The response names the exact TXT value to publish at `_dmarc.<domain>` (`proposal.txtValue`) and
attaches the evidence (`proposal.evidence.days`: per-day report count, message count, sources and
reporting orgs) — visible on **Admin → Deliverability** with a copy button. **Postroom never
publishes it**; publishing the new record is always a manual DNS step.

| Variable | Default | Meaning |
|---|---|---|
| `EDGE_PUBLIC_IP` | unset | Our outbound edge's public IP — always authorized |
| `SES_IP_RANGES` | unset | Comma-separated CIDRs authorized only when `SES_SMTP_USER` is also set |

## When something looks wrong

- **No reports appear.** Check the address exists (`SELECT … FROM address WHERE local_part='dmarc'`)
  and that messages are arriving in its INBOX. Then `SELECT outcome, detail FROM report_ingest ORDER
  BY processed_at DESC LIMIT 20;` — an `error` row names the `ReportError` code (`zip`, `gzip`,
  `not-dmarc`, `invalid-field`, `too-large`, …) and the attachment.
- **A report was rejected that should not have been.** Save the attachment (never commit a real
  report — they name real senders), reproduce with `parseReportAttachment` in a unit test using a
  synthetic equivalent, fix the parser, and re-read the message:
  `DELETE FROM report_ingest WHERE message_id = '<id>';` — the next sweep reads it again, and the
  unique `(org_name, report_id)` keeps anything already stored from duplicating.
- **A failing source.** A low pass rate from an IP you own means SPF or DKIM is broken for it; from
  an IP you do not own it is someone sending as your domain, and `p=quarantine`/`reject` is doing
  its job.
- **A fuzz crasher** in the nightly `dmarc-report` target: see `fuzz-crasher.md`.
