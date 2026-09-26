# Runbooks

PST-REQ-163: the repository shall include runbooks for deploy, edge rebuild, restore with the
escrowed KEK, AWS port-25 denial and IP blocklisting. This folder holds all of them; each one is
purpose, when to use, prerequisites, exact steps (copied from the code and scripts that back them),
verification, and rollback/abort, plus its own execution-record section.

| Runbook | One line |
|---|---|
| [`deploy.md`](deploy.md) | Ship a commit to the live stack through Shipyard — dry run, migrate, swap, verify, soak, rollback |
| [`edge-rebuild.md`](edge-rebuild.md) | Rebuild the stateless Lightsail edge from `cloud-init.yaml`, move the static IP, rotate the WireGuard key |
| [`kek-restore.md`](kek-restore.md) | Restore Postgres + blobs on a clean host and unseal the escrowed KEK bundle to prove disaster recovery |
| [`aws-port25.md`](aws-port25.md) | Get AWS's default outbound port-25 block lifted for the edge, with SES as the interim path |
| [`blocklisting.md`](blocklisting.md) | Respond to a DNSBL listing of the edge IP: find the cause, freeze/revoke, delist, fall back to SES |

Two related runbooks already existed before this task and are referenced from the ones above rather
than duplicated: [`backups.md`](backups.md) (the full nightly backup and automatic drill design that
`kek-restore.md` is the disaster-recovery walk-through for) and [`ses.md`](ses.md) (the SES fallback
transport that `aws-port25.md` and `blocklisting.md` both route through).

## Execution log

Every runbook starts unexecuted. A row is updated only when the runbook is actually run, by whom,
and what happened — never inferred from the code being correct.

| Runbook | Last executed | By | Result |
|---|---|---|---|
| [`deploy.md`](deploy.md) | not yet executed | — | needs operator access to Shipyard (console/MCP token or Zima shell) and a green `main` build |
| [`edge-rebuild.md`](edge-rebuild.md) | not yet executed | — | needs operator AWS Lightsail access (`us-east-1`) |
| [`kek-restore.md`](kek-restore.md) | not yet executed | — | needs a clean host, AWS backup-bucket access, and the operator's escrowed `BACKUP_KEK_PASSPHRASE` |
| [`aws-port25.md`](aws-port25.md) | not yet executed | — | needs operator access to AWS Support Center and a live edge instance |
| [`blocklisting.md`](blocklisting.md) | not yet executed | — | needs an actual (or rehearsed) blocklist alert and an admin/step-up session |

## Relates to

PST-REQ-163 · PST-T-13.2
