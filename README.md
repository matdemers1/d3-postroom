# Postroom

A mail server and webmail written from scratch, as a way to understand every part of email.

SMTP in and out, submission, IMAP4rev1/rev2, CalDAV/CardDAV and Sieve are all hand-rolled in
TypeScript on Node 22, and so is every authentication check (SPF, DKIM, DMARC, ARC). The webmail
sorts your mail into buckets by itself, and every decision it makes can be inspected: which checks
passed, how a message travelled, why it landed where it did.

> **Status:** planned. Nothing here runs yet. The plan of record is in Foreman under the code `PST`.

## Shape

- A stateless edge on AWS Lightsail forwards the mail ports home over WireGuard, with PROXY v2 so
  the home daemons see real client addresses. It holds no mail and no keys.
- Everything else runs as one Docker Compose stack: a container per daemon, PostgreSQL 16, an
  encrypted content-addressed blob store and a validating resolver.
- The webmail is React 19 on `@d3cloud/ui`, with sign-in by password + TOTP or D3 Auth.
- Nothing listens on the public internet until the security gate passes: adversarial tests,
  parser fuzzing, Semgrep, ZAP and ASVS L2.

## Layout

| Path | What |
|---|---|
| `apps/` | edge forwarder, smtp-in, submission, imap, delivery, dav, api, worker, web |
| `packages/` | protocol parsers and shared libraries (smtp-proto, mime, imap-proto, ical, vcard, sieve, auth-checks, classifier, blobstore, queue, crypto, …) |
| `workers/canary` | Cloudflare Worker that watches the whole thing from outside |
| `edge/` | Lightsail provisioning script and cloud-init |
| `fixtures/golden` | Synthetic calibration mail — the only corpus ever committed |
| `security/`, `fuzz/` | Adversarial suite and fuzz harnesses |
| `docs/` | Runbooks, device QA checklist, Shipyard and D3 Auth manifests |

## License

Apache-2.0.
