# Security gate report

PST-T-4.4 · PST-REQ-086 ("the MX record for d3cloud.io shall not be published until the security gate
report shows every gate item passing") · phase PST-P-4.

**Result: every item passes — 2026-09-28, production `90651e0`.**

| # | Gate item | Requirement / task | Evidence | Result |
|---|---|---|---|---|
| 1 | Adversarial suite: relay, auth bypass, smuggling, STARTTLS injection, header injection, PROXY spoofing, blob traversal, IMAP literal abuse | PST-T-4.1 | `security/adversarial`, run by CI's integration job; green on `90651e0` (CI run 36490980220), 140 tests including submission PROXY spoofing (PST-T-4.17) | pass |
| 2 | Parser fuzzing, nightly, every parser | PST-T-4.2 | `.github/workflows/fuzz.yml`, run 36443548828: all 13 targets green (smtp-proto, imap-proto, mime, ical, vcard, sieve, dmarc-report, dsn-report, dav-proto, dns, auth-checks, attachments, proxy-protocol); `fuzz:smoke` on every CI run | pass |
| 3 | Semgrep zero | PST-T-4.3, PST-REQ-089 | `.github/workflows/security.yml` job `semgrep` on `ebee97c` (run 36456474364) and every PR since: zero findings; gitleaks green | pass |
| 4 | ZAP authenticated scan, no High | PST-T-4.3, PST-REQ-090 | nightly `zap` job, run 36436255294: success | pass |
| 5 | ASVS 5.0 L2 self-assessment, no open fail | PST-T-4.3, PST-REQ-091 | `docs/security/asvs-l2.md`: 253 requirements, no open fail | pass |
| 6 | TLS certificate for the MX host from a public CA | PST-T-0.15, PST-REQ-020 | Let's Encrypt `CN=mx.d3cloud.io` (issuer YR2, until 2026-12-27), issued by the worker's ACME job after its staging gate; served on 25/465/587/993, TLS 1.3 | pass |
| 7 | External open-relay and port tests against the edge IP | PST-T-4.4, PST-REQ-053, -016, -049, -025, -027 | below | pass |

## 7. External tests

Run with `security/external/gate-probe.py` from a throwaway Lightsail host outside the edge
(`pst-gate-probe`, 100.59.223.163, us-east-1b — AWS lets it reach port 25), with the edge's Lightsail
firewall opened to that one address only (`edge/ports.sh open all 100.59.223.163/32`; PST-T-4.14).
Every connection went through the real path: public IP 18.208.39.127 → edge forwarder → PROXY v2
over WireGuard → the home daemons.

`python3 gate-probe.py mx.d3cloud.io postmaster@d3cloud.io` → **34 checks, 0 failed.**

| Check | Expected | Observed |
|---|---|---|
| Port sweep (1–1024 and 19 service ports) | only 25, 465, 587, 993 | 25, 465, 587, 993 |
| 25: STARTTLS offered, certificate valid for `mx.d3cloud.io` | yes | yes, TLS 1.3 |
| No relay, 9 variants × plain and STARTTLS: outside→outside, own-domain sender, null sender, `%` hack, source route, double `@`, quoted local part, bang path, `[IP]` literal | refused at RCPT | `550 5.7.1 Relay not permitted`, `550 5.1.1 No such user` or `501 5.1.3` — all 18 refused |
| A real local recipient (`postmaster@`) is accepted | 250 | `250 2.1.5` (so the refusals are about relaying, not a dead server) |
| SMTP smuggling: `\n.\n` inside DATA | 5xx, no second transaction | `550 5.6.0 Bare LF/CR not allowed` |
| A PROXY v2 header sent from outside | not trusted | read as a command: `500 Command not recognized` |
| 587: AUTH not offered before TLS; MAIL without AUTH | no AUTH; 5xx | not offered; `530 5.7.0 Authentication required` |
| 587 and 465: bad credentials | 535 | `535 5.7.8` on both |
| 993: certificate, bad credentials | valid; NO | valid, TLS 1.3; `[AUTHENTICATIONFAILED]` |
| 465 and 993: TLS 1.1 | refused | `protocol version` alert on both |

The first run (on `ebee97c`) failed three checks, and each was fixed before this report:

- **465 and 587 did not work over the edge.** The submission daemon had no PROXY v2 support, so the
  edge's header broke the 465 handshake and was read as a command on 587. Fixed by PST-T-4.17
  (#19): PROXY v2 required from the edge peer, source address used for throttling, audit and
  transcripts; verified adversarially.
- **4190 answered.** The edge forwards ManageSieve, but production runs no managesieve daemon. The
  port stays closed in the firewall until it does.

Raw output: one JSON line per check, kept with the run in the lead's notes; re-run the script to
reproduce.

## After the gate

Go-live (PST-T-4.5): `edge/ports.sh open 25`, `465`, `587`, `993` to the world (not 4190), publish
`MX 10 mx.d3cloud.io` for `d3cloud.io`, keep MTA-STS in `testing`, and delete the probe host.
