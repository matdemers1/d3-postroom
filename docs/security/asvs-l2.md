# Postroom — OWASP ASVS 5.0 Level 2 Self-Assessment

PST-T-4.3 · PST-REQ-091. The webmail (`apps/web`) and its HTTP API (`apps/api`), assessed against
every Level 1 and Level 2 requirement of OWASP ASVS 5.0.0 — 253 of them, V1 to V17. Requirement
text is paraphrased in the tables; the source is `OWASP/ASVS` tag `v5.0.0_release`,
`5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv`.

> [!abstract] Result
> **253 requirements, no open fail.** 148 pass as they stood, 26 pass only after a fix made during
> this assessment, 22 pass on a documented decision recorded below, 9 are accepted deviations (in
> four groups) with a written rationale, compensating controls and the change that would retire
> each, and 48 do not apply to a single-domain webmail that has no GraphQL, WebSocket, SAML, SMS,
> authorization server, file upload or WebRTC.

> [!success] What the assessment changed
> The point of reading all 253 was finding the rows that would not pass. These did not, and now do —
> each fix has a test that fails without it (`apps/api/src/auth/asvs-hardening.test.ts` unless
> named otherwise):
> - **Cookie prefixes** (3.3.1, 3.3.3) — the session and OIDC transaction cookies are
>   `__Host-postroom_session` / `__Host-postroom_oidc` on a secure origin. `7fd2297`
> - **HSTS** (3.4.1) — two years, `includeSubDomains`, on a secure origin. `7fd2297`
> - **Password policy** (6.1.2, 6.2.4, 6.2.11, 6.2.12) — the 9,985 most common breached passwords of
>   policy length and a context-word list, checked at setup and on change. `7fd2297`
> - **Password change** (6.2.2, 6.2.3, 7.4.3, 7.5.1) — there was none. `POST /api/auth/password`
>   needs the current password and a TOTP code, applies the policy, and ends every other session.
>   `7fd2297`
> - **Session rotation** (7.2.4) — a new sign-in now ends the session the browser presented. `7fd2297`
> - **Linking D3 Auth** (7.5.1) — adding a sign-in pathway needed only a signed-in browser; it now
>   needs a sign-in or step-up from the last five minutes. `7fd2297`
> - **Ending sessions** (7.4.5, 7.5.2) — a person can end their own sessions, and an admin one
>   account's or everyone's, all behind step-up. `7fd2297`
> - **Errors** (16.3.4, 16.5.1) — one error handler: generic JSON with the request id to the client,
>   the detail to stderr. A malformed JSON body used to get Express's HTML page. `adb0879`
> - **Caching** (14.2.2, 14.3.2) — every `/api` response is `no-store` unless a route says otherwise.
>   `adb0879`
> - **Sign-out** (14.3.1) — `Clear-Site-Data: "cache", "storage"`. `adb0879`
> - **Failed authorization** (16.3.2) and **bypass attempts** (16.3.3) — audited (`authz.denied`) and
>   logged (`csrf-refused`, `auth-throttled`). `adb0879`
> - **Password spraying** (6.1.1, 2.4.1) — failures are now also counted per address across every
>   login. `178377d`
> - **GCM tag length** (11.3.3) and **decoy randomness** (11.5.1) — found by Semgrep first. `83b519c`

```mermaid
pie showDataOnly title 253 requirements at L1 + L2
  "Pass" : 148
  "Pass — fixed in the assessment" : 26
  "Pass — documented decision" : 22
  "Accepted deviation" : 9
  "Not applicable" : 48
```

## How to read this

| Status | Means |
|---|---|
| ✅ Pass | Implemented, with the evidence named. |
| 🔧 Pass — fixed | Did not pass when this assessment began; fixed, with the commit and the test that proves it. |
| 📝 Pass — documented | The requirement is that something is documented and decided; the decision is in this document. |
| ⚖️ Accepted | Deliberately not met as written. The rationale, the compensating controls and the change that would retire it are recorded, which is what ASVS asks of a relaxation. |
| ➖ N/A | The mechanism does not exist in the webmail or its API. |

Evidence paths are relative to the repository root. `api/` means `apps/api/src/`; `hardening` means
`apps/api/src/auth/asvs-hardening.test.ts`; `it/` means `apps/api/test/integration/`; `e2e/` means
`e2e/tests/`. A commit hash names the fix.

**Scope.** The webmail and the API behind `mail.d3cloud.io`, and the packages they call
(`@postroom/audit`, `@postroom/credentials`, `@postroom/crypto`, `@postroom/db`,
`@d3cloudio/auth-client`). The protocol daemons (SMTP, submission, IMAP, DAV, Sieve) are assessed by
their own gate (PST-T-4.1 adversarial suite, PST-T-4.2 fuzzing); where a V12 row reaches them it
says so.

> [!info] The context the accepted deviations rest on
> Postroom serves **one domain and one household**: one operator, the few people they give a
> mailbox, and the ecosystem's own service accounts. It runs on one host behind a Cloudflare Tunnel,
> with PostgreSQL, the daemons and `cloudflared` on one Docker network that never leaves the host's
> kernel. There is no public sign-up. If any of that changes — a second host, strangers signing up,
> or a database on another machine — rows 6.3.3, 12.3.1, 12.3.3, 12.3.4, 13.2.1, 13.2.2 and 13.3.1
> must be reassessed first.

---

## Documented controls

These sections are the documentation several requirements ask for (2.1.x, 6.1.x, 7.1.x, 8.1.x,
11.1.x, 13.1.1, 14.1.x, 15.1.x, 16.1.1).

### Against credential stuffing and brute force (6.1.1, 6.3.1, 2.4.1)

| Control | Where | Configured as | Proven by |
|---|---|---|---|
| Per-login throttle | `api/auth/throttle.ts`, checked **before** any hashing | per (login, address): 5 free failures, then a delay doubling from 1 s to 5 min; decays after 15 quiet minutes. A delay, never a lockout — an attacker cannot lock the operator out | `test/unit/auth.test.ts` "throttles with doubling"; `it/auth.test.ts` "throttles repeated failures per login and IP before hashing" |
| Per-address throttle | same, `rt.ipThrottle` | every login from one address counted together: 20 free failures, then the same curve; a completed sign-in clears it | `hardening` "per-address throttle" (`178377d`) |
| TOTP throttled | `/signin/totp`, `/step-up`, `/password` | the per-login counter, plus 5 codes per challenge | `it/auth.test.ts` "rejects a wrong TOTP code and a replayed one" |
| Uniform answers | `/signin` | unknown login and wrong password both answer `401 invalid_credentials` after the same Argon2id work (decoy hash) | `it/auth.test.ts` "answers an unknown login exactly like a wrong password" |
| Protocol logins | `@postroom/credentials` `verifyProtocolLogin` | app passwords only, decoy hash on a miss; the account password is never accepted by IMAP/SMTP/DAV (PST-REQ-027) | `packages/credentials/test` |
| Setup gate | `api/auth/setup-gate.ts` | first-run setup only from a private address or with `SETUP_TOKEN` | `it/setup-gate.test.ts` |

### Authentication pathways (6.1.3, 6.3.4)

Every way to end up signed in to the webmail, and what each requires. There is no other.

| Pathway | Requires | Strength |
|---|---|---|
| Password + TOTP | login, password (policy below), then a 6-digit TOTP from a KEK-sealed seed | 2 factors, always — TOTP is part of the password path, not an option on it (PST-REQ-005) |
| Sign in with D3 Auth | the D3 Auth code flow (PKCE S256, state, nonce, `client_secret_basic`) bound to this browser by a sealed transaction cookie; identity by `(iss, sub)` | whatever D3 Auth required — see 6.3.3 |
| First-run setup | no operator yet **and** a private client address or `SETUP_TOKEN`; ends with a confirmed TOTP | enrolment of the operator |
| Protocol clients | app passwords, scoped per protocol, never the account password | 1 factor, 100-bit random secret — not a webmail pathway |

### Password policy (6.1.2, 6.2.x)

`api/auth/password-policy.ts`: at least 12 characters (grapheme clusters), at most 1024, no
composition rules, no expiry, checked at setup and on change. Refused when it is among the 9,985
most common breached passwords of 12+ characters (`api/auth/common-passwords.ts`, from the SecLists
corpus D3 Auth ships), or contains a context word:

> `postroom`, `d3cloud`, `d3auth`, `demers`, `webmail`, `mailserver`, and the first label of the
> instance's mail domain.

The list is checked locally: the API makes no outbound call for it.

### Session lifetimes and concurrency (7.1.1, 7.1.2, 7.1.3, 7.6.1)

| Limit | Value | Enforced by | Proven by |
|---|---|---|---|
| Idle | 12 hours, slid at most once a minute | `api/auth/sessions.ts` `IDLE_MS`, `resolveSession` | `it/auth.test.ts` "ends after 12 hours idle" |
| Absolute | 7 days from sign-in | `ABSOLUTE_MS`, checked on every request in `resolveSession` | the same check as idle; no dedicated test |
| Step-up window | 5 minutes | `requireStepUp`, `freshlyAuthenticated` | `it/auth.test.ts` "step-up expires after five minutes" |
| SSE stream | re-checks its session on every heartbeat; never slides the idle timeout | `api/mail/index.ts` `/events` `stillValid` | code |

NIST 800-63B AAL2 asks for 12 hours absolute and 30 minutes idle. Postroom keeps an inbox open all
day on the operator's own devices; the absolute limit is a week, and everything that changes how the
account signs in or ends sessions asks for fresh proof on its own (step-up or a password + TOTP).
**Concurrent sessions** are unlimited; each is listed (`GET /api/auth/sessions`, and for an admin
`/admin/sessions`) and can be ended. **Federation**: a D3 Auth sign-in creates an ordinary Postroom
session with the limits above; D3 Auth's back-channel logout ends every Postroom session that
`(iss, sub)` created (`/api/auth/oidc/backchannel-logout`, `it/oidc.test.ts`), never a password
session of the same account.

### Authorization rules (8.1.1, 8.1.2)

| Subject | May | Enforced by |
|---|---|---|
| Anonymous | `/health`, client autoconfiguration, `/api/auth/state`, the sign-in and setup steps | `app.ts` mounts |
| Signed-in account | its own mailboxes, messages, threads, search, events, outbound status, app passwords and sessions — every lookup scoped by `accountId`; anything else is `404`, never `403`, so existence does not leak | `requireSession`; `api/mail/store.ts` `findOwnMessage`, `ownMailbox`, `findOwnThread` |
| Admin (native `is_admin`, or D3 Auth roles claim `admin` for this client) | the above, plus `/api/admin/*` (sessions, jobs, service accounts) and a service account's app passwords | `requireAdmin` |
| Admin, stepped up in the last 5 minutes | end sessions, thaw a frozen credential | `requireStepUp` |

**Fields**: responses are built field by field (`toJson`, `detailJson`, `summaryJson`), never by
returning a row; the only writable message fields are the ones `MessagePatch` names (flags,
mailbox). Nobody — admin or not — can read another person's mail through the API.

### Cryptographic inventory and key management (11.1.1, 11.1.2)

| Key / secret | Algorithm | Where it lives | Protects | Rotation |
|---|---|---|---|---|
| KEK (`POSTROOM_KEK`) | AES-256-GCM, 12-byte random nonce, 16-byte tag, format byte + 8-byte key id | host `.env` (mode 600); escrowed in the backup bucket sealed under `BACKUP_KEK_PASSPHRASE` | per-blob DEKs, TOTP seeds, DKIM private keys | key id in every ciphertext, so a new KEK can be introduced and old data re-sealed (PST-ADR-009) |
| Per-blob DEK | AES-256-GCM streaming | wrapped by the KEK, beside its blob row | message bodies at rest; crypto-shred by deleting the wrapped DEK | one per blob, never reused |
| Password pepper (`PASSWORD_PEPPER`) | Argon2id `secret` input (64 MiB, t=3, p=1) | host `.env` only — never in the database | account passwords, app passwords | rotation requires re-setting passwords; recorded as a limitation |
| `SESSION_SECRET` | HKDF-SHA-256 → AES-256-GCM | host `.env` | the 10-minute OIDC transaction cookie | rotate freely: in-flight sign-ins restart |
| Session tokens | 256 random bits; SHA-256 in the database | cookie / `session.id_hash` | web sessions | per sign-in |
| TOTP seeds | 160 random bits (`otpauth` `Secret`) | KEK-sealed, AAD `totp:<accountId>` | second factor | re-enrol |
| App passwords | 40-bit public prefix + 100-bit secret, Argon2id + pepper | `app_password.hash` | protocol logins | revoke and re-issue |
| DKIM keys | RSA-2048 and Ed25519 | KEK-sealed in the database | outbound signatures (not the webmail) | selector rotation (`dkim-keys` CLI) |
| TLS | Cloudflare's edge certificate for the web; ACME certificates for the mail ports (PST-ADR-010) | Cloudflare; the host | transport | automatic |

Keys are held by one entity each: the host (and the escrow bundle, which needs a separate
passphrase). Nothing is shared with a third party.

### Sensitive data (14.1.1, 14.1.2)

| Class | Examples | Requirements |
|---|---|---|
| **Secret** | passwords, app passwords, TOTP seeds, KEK/DEKs, pepper, session tokens | never logged (Semgrep `postroom.secret-in-log`, audit `redact`); hashed (Argon2id / SHA-256) or KEK-sealed at rest; never in a URL; shown once when generated |
| **Mail content** | bodies, attachments, headers | AES-256-GCM at rest under per-blob DEKs; served only to its owner, `no-store`; HTML only on the usercontent origin; retention is the owner's (delete = crypto-shred) |
| **Personal metadata** | addresses, display names, IPs and user agents on sessions and audit rows | access-controlled per account; audit rows append-only; kept with the database and its backups |
| **Operational** | job state, revision, schema revision | public on `/health` by intent (Shipyard verifies deploys with it) |

### Communication inventory (13.1.1)

| From | To | Why | Who chooses the destination |
|---|---|---|---|
| browser | `mail.d3cloud.io` (Cloudflare → tunnel → `api:3300`) | the webmail | fixed |
| api | PostgreSQL on the Docker network | state | fixed |
| api | D3 Auth (`D3AUTH_ISSUER`) discovery, JWKS, token endpoint | Sign in with D3 Auth | the operator's configuration; never a user |
| api | nothing else | — | the web app makes no third-party request (Semgrep `postroom.web-third-party-request`, CSP `connect-src 'self'`) |

No user can supply a URL the API then fetches: there is no remote-content proxy, webhook or
avatar fetch in the API.

### Resource-demanding functions (15.1.3)

| Function | Cost | Defence |
|---|---|---|
| Password sign-in, setup, password change | Argon2id, 64 MiB each | both throttles run before hashing; request bodies capped at 1 MB |
| Search | full-text + `ILIKE` over the account's messages | scoped to one account; page size capped by `SearchQuery` |
| Message body / attachment | parse of a message up to 100 MB | streamed, never buffered whole (PST-REQ-050); text parts truncated with a flag |
| SSE `/api/events` | one connection per tab | one shared `LISTEN` per process, heartbeat re-checks the session |
| Autodiscover POST | XML body | 16 KiB cap before reading, regex extraction, no XML parser |

### Third-party components (15.1.1, 15.1.2)

The inventory is `pnpm-lock.yaml`, resolved only from the npm registry under the workspace's
supply-chain policy: nothing published in the last seven days, no provenance downgrades, no exotic
transitive sources, install scripts only for the three packages named (`pnpm-workspace.yaml`).
**Remediation time frames**: a High or Critical advisory reachable from shipped code is fixed or
mitigated within 7 days; Moderate within 30; an advisory in a path the running service never loads
is triaged and recorded, and fixed with the next upgrade of its parent. Every Actions step is pinned
to a commit SHA and every image to a digest.

At this assessment `pnpm audit --prod` reports three advisories, all under the **Prisma CLI**
(`prisma → mysql2`, `prisma → @prisma/config → deepmerge-ts`): the migration tool, which speaks only
to PostgreSQL and never loads the MySQL driver, and whose config merge reads only this repository's
own file. Not reachable; recorded here, fixed with the next Prisma upgrade.

### Logging inventory (16.1.1)

| Log | What | Format | Where | Access | Kept |
|---|---|---|---|---|---|
| `audit_event` | every mutation (actor, action, entity, before/after with secrets redacted, IP, user agent, request id), every sign-in and its failures, setup, step-up, `authz.denied` | JSONB rows, `timestamptz` UTC | PostgreSQL; **append-only by trigger** (`audit_event_append_only`, init migration) | admins through the database; no API writes or deletes it | with the database; nightly dump to the SSE-KMS bucket through a put-only IAM user |
| stderr | structured JSON lines: `unhandled-error` (with request id and stack), `csrf-refused`, `auth-throttled`, `audit-missing`, `oidc-discovery-failed`, `kek-invalid`, `authz-denied-unrecorded` | one JSON object per line | Docker's log driver on the host | the host operator | Docker's rotation |
| Alerts | failed backups, drills, health | email | D3 Auth's mail relay (PST-REQ-096) | the operator | the operator's mailbox |

---

## V1 Encoding and Sanitization

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 1.1.1 | 2 | Decode to canonical form once, before validation | ✅ Pass | JSON is parsed once by `express.json`, then validated by zod; MIME encoded-words are decoded once, at read (`decodeEncodedWords` in `api/mail/index.ts` `/body`) |
| 1.1.2 | 2 | Output encoding as the final step, or by the interpreter | ✅ Pass | React escapes at render; `res.json` encodes at send; the autoconfig XML escapes each value as it is placed (`api/autoconfig/index.ts` `escapeXml`) |
| 1.2.1 | 1 | Context-relevant output encoding for HTTP, HTML, XML | ✅ Pass | as 1.1.2; `Content-Disposition` filenames per RFC 6266 (`attachmentDisposition`, `api/mail/index.ts:59`); Semgrep `postroom.reflected-user-input` refuses request input in `res.send/write/end` |
| 1.2.2 | 1 | URL building encodes untrusted data; only safe schemes | ✅ Pass | `URLSearchParams` (`signinError`), `encodeURIComponent` in `apps/web/src/api.ts`; the only user-visible link built from data is the `otpauth:` URI from the server's own secret |
| 1.2.3 | 1 | Encoding when building JavaScript/JSON | ✅ Pass | no JavaScript is generated; JSON only through `JSON.stringify`/`res.json` |
| 1.2.4 | 1 | Parameterised queries / ORM | ✅ Pass | Prisma everywhere; raw SQL only as tagged templates (`Prisma.sql`, `$queryRaw\``), which bind every value — `packages/search/src/imap.ts`; Semgrep `postroom.raw-sql-interpolated` |
| 1.2.5 | 1 | OS command injection | ✅ Pass | the API runs no process; the worker's `pg_dump`/`pg_restore` use `spawn` with an argument array (`apps/worker/src/backup/pgtools.ts`); Semgrep `postroom.shell-command-injection` |
| 1.2.6 | 2 | LDAP injection | ➖ N/A | no LDAP |
| 1.2.7 | 2 | XPath injection | ➖ N/A | no XPath |
| 1.2.8 | 2 | LaTeX injection | ➖ N/A | no LaTeX |
| 1.2.9 | 2 | Regex metacharacters escaped | ✅ Pass | no `RegExp` is built from input in the API; search terms become `ILIKE` patterns with `%`/`_`/`\` escaped (`likeContains`, `ESCAPE '\\'`) |
| 1.3.1 | 1 | Untrusted HTML sanitised by a known library | ✅ Pass | the webmail never renders mail HTML on its own origin: `/body` returns it as data, marked "NOT sanitised: render it only on the usercontent origin" (`api/mail/schemas.ts:131`); CSP `script-src 'self'` would refuse inline script regardless. The three-pane UI must keep to this (see notes) |
| 1.3.2 | 1 | No `eval` or dynamic code | ✅ Pass | none; Semgrep `postroom.dynamic-code`, and CI proves a planted `eval()` fails the build (`security.yml`) |
| 1.3.3 | 2 | Sanitise for dangerous contexts; length limits | ✅ Pass | zod `max()` on every string input; filenames stripped of quotes and control characters before a header (`attachmentDisposition`) |
| 1.3.4 | 2 | User SVG sanitised | ✅ Pass | an SVG attachment is served `application/octet-stream`, `attachment`, `CSP: sandbox` — never rendered on this origin (`api/mail/index.ts:253–256`) |
| 1.3.5 | 2 | Scriptable template content (Markdown, CSS, XSL) | ✅ Pass | none is rendered; mail CSS lives only inside mail HTML, on the usercontent origin |
| 1.3.6 | 2 | SSRF | ✅ Pass | the API fetches only the configured D3 Auth issuer; no user-supplied URL is ever fetched (§Communication inventory) |
| 1.3.7 | 2 | Template injection | ➖ N/A | no server-side template engine; the XML documents are fixed templates with escaped values |
| 1.3.8 | 2 | JNDI | ➖ N/A | not Java |
| 1.3.9 | 2 | Memcache | ➖ N/A | no memcache |
| 1.3.10 | 2 | Format strings | ✅ Pass | no `printf`-style formatting of input; template literals only |
| 1.3.11 | 2 | SMTP/IMAP injection | ✅ Pass | the API sends no mail and speaks no IMAP; outbound status routes read only. The daemons refuse bare CR/LF (PST-REQ-049) and write CRLF only (Semgrep `postroom.bare-lf-on-the-wire`) |
| 1.4.1 | 2 | Memory-safe strings and copies | ✅ Pass | TypeScript on Node: bounds-checked `Buffer`/`string` only; no native code of ours |
| 1.4.2 | 2 | Integer overflow | ✅ Pass | modseq and UIDs are `BigInt`/`bigint` columns; If-Match parsed to at most 20 digits (`parseIfMatch`); limits are zod-bounded integers |
| 1.4.3 | 2 | Memory released, no dangling pointers | ✅ Pass | garbage-collected runtime; streams closed on `close` (`/attachments` drain handler) |
| 1.5.1 | 1 | XML parsers without external entities | ✅ Pass | no XML parser: autodiscover extracts one element with a bounded regex from a 16 KiB body (`api/autoconfig/index.ts:152`) |
| 1.5.2 | 2 | Safe deserialisation | ✅ Pass | `JSON.parse` only, into zod-validated shapes; the OIDC transaction cookie is authenticated (GCM) before it is parsed and then field-checked (`openTransaction`) |

## V2 Validation and Business Logic

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 2.1.1 | 1 | Documented input validation rules | 📝 Pass — documented | the zod schemas are the rules and are published as the OpenAPI document (`api/mail/schemas.ts`, `apps/api/openapi.json`, PST-REQ-085); auth inputs in `api/auth/routes.ts` (`SetupBegin`, `SignIn`, `PasswordChange`) |
| 2.1.2 | 2 | Documented rules for combined items | 📝 Pass — documented | the combinations that exist: a recipient cap only on a service account (`api/app-passwords/index.ts`), `accountId` only for an admin on a service account, a cursor only with its query |
| 2.1.3 | 2 | Documented business limits | 📝 Pass — documented | §Resource-demanding functions; §Against credential stuffing |
| 2.2.1 | 1 | Positive validation of all input | ✅ Pass | zod on every body, query and path parameter (`parse()` in `api/mail/index.ts`); UUID regexes on ids |
| 2.2.2 | 1 | Validation at a trusted layer | ✅ Pass | all in the API; the web app's checks are convenience |
| 2.2.3 | 2 | Combined items reasonable | ✅ Pass | as 2.1.2, enforced in the handlers (`dailyRecipientCap` refused unless managed) |
| 2.3.1 | 1 | Business flows in order, no skipped steps | ✅ Pass | setup: `begin` → `complete` via a single-use enrol token; sign-in: password → TOTP via a single-use challenge bound to the account; OIDC: start → callback via the sealed transaction |
| 2.3.2 | 2 | Documented business limits implemented | ✅ Pass | the throttles, caps and page limits in §Documented controls |
| 2.3.3 | 2 | Transactions for business operations | ✅ Pass | setup, sign-in, step-up, password change, session revocation and every message PATCH are single `db.$transaction`s with their audit row inside (`audited()`) |
| 2.3.4 | 2 | Locking against double-booking | ✅ Pass | setup takes `pg_advisory_xact_lock` (`api/auth/setup.ts`); a TOTP step is burnt by one conditional `UPDATE` (`burnStep`) so two uses cannot both win; PATCH needs `If-Match` |
| 2.4.1 | 2 | Anti-automation against excessive calls | 🔧 Pass — fixed | both sign-in throttles, 5 codes per challenge, 1 MB bodies, capped pages; spraying many logins from one address was unthrottled before `178377d` |

## V3 Web Frontend Security

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 3.2.1 | 1 | Content not rendered in the wrong context | ✅ Pass | API responses are JSON with `nosniff`; raw messages `text/plain` + `attachment`; attachments `application/octet-stream` + `attachment` + `CSP: sandbox` (`api/mail/index.ts:196–256`) |
| 3.2.2 | 1 | Text rendered as text | ✅ Pass | React text nodes only; no `dangerouslySetInnerHTML` or `innerHTML` in `apps/web/src` |
| 3.3.1 | 1 | Cookies `Secure`, and `__Host-`/`__Secure-` named | 🔧 Pass — fixed | `__Host-postroom_session`, `__Host-postroom_oidc` on a secure origin, `Secure` always there (`sessions.ts:15`, `oidc.ts` `SECURE_TX_COOKIE`); `hardening` "uses the __Host- prefix". `7fd2297` |
| 3.3.2 | 2 | `SameSite` by purpose | ✅ Pass | `Lax` on both — the D3 Auth callback is a cross-site top-level GET; cross-site POSTs are refused by `csrfGuard` as well (`sessions.ts:174`) |
| 3.3.3 | 2 | `__Host-` unless shared | 🔧 Pass — fixed | as 3.3.1; the transaction cookie moved to `Path=/` to qualify. `7fd2297` |
| 3.3.4 | 2 | `HttpOnly` for session cookies; token only via `Set-Cookie` | ✅ Pass | `httpOnly: true` on both; the token never appears in a body or URL; Semgrep `postroom.cookie-without-httponly`; `e2e/auth.spec.ts` asserts `httpOnly` |
| 3.4.1 | 1 | HSTS ≥ 1 year, subdomains at L2 | 🔧 Pass — fixed | `max-age=63072000; includeSubDomains` on a secure origin (`app.ts:45`); `hardening` "sends HSTS for two years". `7fd2297` |
| 3.4.2 | 1 | CORS origin fixed or allowlisted | ✅ Pass | no CORS headers are ever sent; cross-origin reads are refused by the browser |
| 3.4.3 | 2 | CSP with `object-src 'none'`, `base-uri 'none'`, allowlist | ✅ Pass | `default-src 'self'; script-src 'self'; … object-src 'none'; base-uri 'none'` on every response (`app.ts:19`); `test/unit/app.test.ts` "sends a strict CSP" |
| 3.4.4 | 2 | `X-Content-Type-Options: nosniff` everywhere | ✅ Pass | `securityHeaders` on every response |
| 3.4.5 | 2 | Referrer policy | ✅ Pass | `Referrer-Policy: no-referrer` |
| 3.4.6 | 2 | `frame-ancestors` | ✅ Pass | `frame-ancestors 'none'` |
| 3.5.1 | 1 | CSRF: anti-forgery token or non-safelisted header | ✅ Pass | every non-GET under `/api` needs `x-postroom-csrf: 1` or our own `Origin` (`middleware.ts:114`); `test/unit/auth.test.ts` "refuses a cross-site POST" |
| 3.5.2 | 1 | Preflight relied on properly | ✅ Pass | as 3.5.1 — a custom header forces a preflight this server never answers |
| 3.5.3 | 1 | Sensitive functions not on safe methods | ✅ Pass | every state change is POST/PATCH/DELETE; the one GET that starts something, `/oidc/start`, only redirects to D3 Auth, and linking through it needs fresh authentication (7.5.1) |
| 3.5.4 | 2 | Separate apps on separate hostnames | ✅ Pass | webmail `mail.`, DAV `dav.`, untrusted mail HTML `usercontent.` (PST-T-3.12), D3 Auth `auth.` |
| 3.5.5 | 2 | `postMessage` origin checked | ➖ N/A | the webmail neither sends nor listens for `postMessage` |
| 3.7.1 | 2 | Only supported client technologies | ✅ Pass | React 19, ES modules; no plugins |
| 3.7.2 | 2 | Redirects to other hosts only on an allowlist | ✅ Pass | the only off-site redirect is to the configured D3 Auth issuer (`/oidc/start`); every other redirect is a fixed local path (`/`, `/signin?…`) |

## V4 API and Web Service

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 4.1.1 | 1 | `Content-Type` with charset matches the body | 🔧 Pass — fixed | `application/json; charset=utf-8` from `res.json`, including errors now (`errorHandler`, `app.ts:116`); XML and text set `charset=utf-8`. A malformed body used to get Express's HTML page; `hardening` "answers malformed JSON". `adb0879` |
| 4.1.2 | 2 | Only user-facing endpoints redirect HTTP→HTTPS | 📝 Pass — documented | the only listener is behind Cloudflare, which serves HTTPS; HSTS keeps browsers off HTTP; the API has no non-browser clients |
| 4.1.3 | 2 | Intermediary headers not end-user overridable | ✅ Pass | `trust proxy` is exactly one hop, `cloudflared` (`app.ts:51`): `req.ip` is the address Cloudflare appended, not one the client wrote. No other intermediary header is read |
| 4.2.1 | 2 | Message boundaries, no request smuggling | ✅ Pass | Node's `llhttp` refuses `Transfer-Encoding` + `Content-Length` conflicts; Cloudflare terminates the client connection |
| 4.3.1 | 2 | GraphQL depth/cost limits | ➖ N/A | no GraphQL |
| 4.3.2 | 2 | GraphQL introspection off | ➖ N/A | no GraphQL |
| 4.4.1 | 1 | WSS only | ➖ N/A | no WebSocket; live updates are SSE over the same HTTPS origin |
| 4.4.2 | 2 | WebSocket Origin checked | ➖ N/A | no WebSocket |
| 4.4.3 | 2 | Dedicated WebSocket tokens | ➖ N/A | no WebSocket |
| 4.4.4 | 2 | WebSocket tokens via the HTTPS session | ➖ N/A | no WebSocket |

## V5 File Handling

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 5.1.1 | 2 | Documented upload types and sizes | ➖ N/A | the webmail has no upload feature; mail arrives over SMTP, governed by that daemon's limits (PST-REQ-050) |
| 5.2.1 | 1 | Only process files of a manageable size | ✅ Pass | JSON bodies 1 MB, autodiscover 16 KiB; messages are streamed, never buffered whole |
| 5.2.2 | 1 | Extension and content type validated | ➖ N/A | no upload |
| 5.2.3 | 2 | Compressed files checked before decompression | ✅ Pass | request bodies: `express.json` enforces its limit on the inflated size; archives inside mail are inspected only up to a 25 MiB cap and reported uninspectable beyond it (`packages/attachments/src/policy.ts`) |
| 5.3.1 | 1 | Uploaded files never executed | ✅ Pass | nothing from mail is written into a served directory; blobs are encrypted and addressed by hash |
| 5.3.2 | 1 | File paths from trusted data | ✅ Pass | blob paths come from SHA-256 hashes, never from a filename (`@postroom/blobstore`) |
| 5.4.1 | 2 | Filenames validated or ignored; `Content-Disposition` set | ✅ Pass | `attachmentDisposition` on every download (`api/mail/index.ts:59`) |
| 5.4.2 | 2 | Served filenames encoded (RFC 6266) | ✅ Pass | ASCII fallback with quotes, backslashes and non-printables replaced, plus `filename*=UTF-8''` percent-encoded |
| 5.4.3 | 2 | Untrusted files scanned by antivirus | ⚖️ Accepted | See below |

> [!warning] 5.4.3 — no signature antivirus
> **Deviation.** Attachments are not scanned by a signature-based antivirus engine.
> **Why.** A signature scanner catches yesterday's commodity malware; for one household the larger
> risk is a novel executable or macro document, which signatures miss.
> **Compensating controls.** The dangerous-attachment policy (PST-REQ-065, `@postroom/attachments`):
> content-sniffed, not extension-trusted; executables, scripts, `.lnk` and disc images are
> quarantined regardless of sender, macro and active-content documents and risky archives from a
> sender without history; the webmail serves every attachment as a sandboxed download, never inline.
> **Retire by** adding a ClamAV sidecar the worker calls before filing, as a further quarantine reason.

## V6 Authentication

### V6.1 Documentation

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 6.1.1 | 1 | Anti-stuffing and brute-force controls documented; no malicious lockout | 🔧 Pass — fixed | §Against credential stuffing — delays, never lockout; the per-address layer is `178377d` |
| 6.1.2 | 2 | Context-specific word list documented | 🔧 Pass — fixed | §Password policy; `CONTEXT_WORDS` (`password-policy.ts:24`). `7fd2297` |
| 6.1.3 | 2 | Multiple pathways documented with their controls | 📝 Pass — documented | §Authentication pathways |

### V6.2 Password security

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 6.2.1 | 1 | At least 8 characters (15 recommended) | ✅ Pass | 12 (`MIN_PASSWORD_LENGTH`, `passwords.ts:18`); `it/auth.test.ts` "refuses a short password" |
| 6.2.2 | 1 | Users can change their password | 🔧 Pass — fixed | `POST /api/auth/password` (`routes.ts:645`). `7fd2297`. The account screen that calls it is listed for the web app (see notes) |
| 6.2.3 | 1 | Change requires current and new password | 🔧 Pass — fixed | `PasswordChange` needs `currentPassword`, `newPassword` and a TOTP `code`. `7fd2297` |
| 6.2.4 | 1 | Checked against the top 3000 policy-matching passwords | 🔧 Pass — fixed | 9,985 of 12+ characters (`common-passwords.ts`), at setup and change; `hardening` "refuses short, common and context-word passwords". `7fd2297` |
| 6.2.5 | 1 | No composition rules | ✅ Pass | length, list and context only (`checkPassword`) |
| 6.2.6 | 1 | `type=password` masking | ✅ Pass | `PasswordInput` from `@d3cloud/ui` on every password field (`Setup.tsx`, `SignIn.tsx`) |
| 6.2.7 | 1 | Paste and password managers permitted | ✅ Pass | no paste blocking; `autoComplete="current-password"`/`"new-password"` |
| 6.2.8 | 1 | Verified exactly as received | ✅ Pass | the password schema has no `trim` or case change (`Password`, `SetupBegin.password`); only the login is normalised |
| 6.2.9 | 2 | At least 64 characters permitted | ✅ Pass | up to 1024 (`MAX_PASSWORD_LENGTH`); `hardening` "accepts 64+ characters" |
| 6.2.10 | 2 | No periodic rotation | ✅ Pass | no expiry exists |
| 6.2.11 | 2 | The context-specific list is used | 🔧 Pass — fixed | `checkPassword` refuses a password containing a listed word or the domain label. `7fd2297` |
| 6.2.12 | 2 | Checked against breached passwords | 🔧 Pass — fixed | as 6.2.4, locally — the API makes no outbound call for it. `7fd2297` |

### V6.3 General authentication security

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 6.3.1 | 1 | Anti-stuffing controls implemented as documented | ✅ Pass | every row of §Against credential stuffing has its test |
| 6.3.2 | 1 | No default accounts | ✅ Pass | the seed leaves an operator with **no credential**; it becomes usable only through first-run setup, which is gated (`setup-gate.ts:32`, `it/setup-gate.test.ts`) and closes for good (`e2e/auth.spec.ts` "/setup redirects to /signin") |
| 6.3.3 | 2 | MFA (or a combination) required | ⚖️ Accepted | See below |
| 6.3.4 | 2 | No undocumented pathways; consistent strength | 📝 Pass — documented | §Authentication pathways; the routers mounted in `app.ts` are the whole surface, and the ZAP plan seeds every one (`zap/automation.yaml`) |

> [!warning] 6.3.3 — a D3 Auth sign-in carries D3 Auth's strength
> **Deviation.** The password path always needs TOTP. The D3 Auth path accepts whatever D3 Auth
> accepted, and D3 Auth lets guests (not admins) sign in with a password alone (AUTH ASVS 6.3.3).
> Postroom does not yet read `amr` to insist on a second factor.
> **Compensating controls.** D3 Auth owners and admins must hold a verified factor; Postroom's admin
> role over D3 Auth comes only from the `admin` role for this client, which an owner grants; D3 Auth
> grants are deny-by-default, so a guest reaches Postroom only if given it; the protocols never
> accept the account password, only app passwords; step-up and password change need Postroom's own
> TOTP.
> **Retire by** refusing a D3 Auth sign-in whose `amr` has no second factor (`otp`, `hwk`, `swk`) in
> `/oidc/callback`, once every Postroom user's D3 Auth account has one.

### V6.4 Factor lifecycle and recovery

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 6.4.1 | 1 | Initial secrets random, short-lived or single-use | ✅ Pass | the setup enrol token is 256 random bits, 15 minutes, single use (`routes.ts` `/setup/begin`); app passwords are random, shown once; the person sets their own password — no system password exists |
| 6.4.2 | 1 | No hints or security questions | ✅ Pass | none exist |
| 6.4.3 | 2 | Reset does not bypass MFA | ✅ Pass | there is no password reset; a forgotten password is recovered by signing in with a linked D3 Auth identity or by the operator at the host |
| 6.4.4 | 2 | Lost factor → proofing at enrolment level | 📝 Pass — documented | enrolment is first-run setup on the host's private network or with `SETUP_TOKEN`; re-enrolling a lost TOTP needs the same host-level access. No remote self-service path exists to bypass it |

### V6.5 General multi-factor requirements

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 6.5.1 | 2 | Lookup/OOB/TOTP usable once | ✅ Pass | every accepted step burnt by `burnStep` (`totp.ts:56`); `it/auth.test.ts` "rejects … a replayed one" |
| 6.5.2 | 2 | Low-entropy lookup secrets hashed | ➖ N/A | no lookup secrets or recovery codes |
| 6.5.3 | 2 | CSPRNG for TOTP seeds | ✅ Pass | 160-bit `otpauth` `Secret` (Web Crypto), KEK-sealed with AAD `totp:<accountId>` (`totp.ts:41`) |
| 6.5.4 | 2 | Lookup/OOB codes ≥ 20 bits | ➖ N/A | none exist |
| 6.5.5 | 2 | Defined lifetimes; TOTP ≤ 30 s | ✅ Pass | 30-second period, ±1 step for skew (`TOTP_WINDOW`), each step once |

### V6.6 Out-of-band authentication

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 6.6.1 | 2 | PSTN/SMS only with conditions | ➖ N/A | no SMS or phone authentication |
| 6.6.2 | 2 | OOB bound to the original request | ➖ N/A | no out-of-band authenticator |
| 6.6.3 | 2 | OOB codes rate limited | ➖ N/A | as above |

### V6.8 Authentication with an identity provider

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 6.8.1 | 2 | Identity not spoofable across IdPs — `(iss, sub)` | ✅ Pass | `resolveIdentity` keys on `(issuer, subject)` and refuses to adopt an account by email (`oidc.ts:186`); `it/oidc.test.ts` "a different subject asserting the same email is a different account" |
| 6.8.2 | 2 | Assertion signatures always validated | ✅ Pass | `@d3cloudio/auth-client` verifies every ID token and logout token signature with pinned algorithms (AUTH ASVS 6.8.2, its adversarial tests) |
| 6.8.3 | 2 | SAML assertions used once | ➖ N/A | no SAML |
| 6.8.4 | 2 | Strength/recency from `acr`/`amr`, or a documented fallback | 📝 Pass — documented | Postroom requires no particular D3 Auth strength; the documented fallback is to treat a D3 Auth sign-in as single-factor for anything sensitive — which is why step-up and password change ask for Postroom's own TOTP (see 6.3.3) |

## V7 Session Management

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 7.1.1 | 2 | Idle and absolute lifetimes documented, deviations justified | 📝 Pass — documented | §Session lifetimes |
| 7.1.2 | 2 | Concurrent-session policy documented | 📝 Pass — documented | §Session lifetimes — unlimited, all listed and endable |
| 7.1.3 | 2 | Federated session coordination documented | 📝 Pass — documented | §Session lifetimes — back-channel logout |
| 7.2.1 | 1 | Tokens verified by a trusted backend | ✅ Pass | the cookie's SHA-256 names a `session` row; resolved server-side on every request (`resolveSession`, `sessions.ts:112`) |
| 7.2.2 | 1 | Dynamic tokens, not static secrets | ✅ Pass | as above |
| 7.2.3 | 1 | Reference tokens ≥ 128 bits from a CSPRNG | ✅ Pass | 256 bits from `randomBytes(32)` (`sessions.ts:64`); only the hash is stored |
| 7.2.4 | 1 | New token on authentication; old one ended | 🔧 Pass — fixed | every sign-in issues a new session, and now also deletes the one the browser presented (`endPresentedSession`, `routes.ts:85`). `7fd2297` |
| 7.3.1 | 2 | Inactivity timeout | ✅ Pass | 12 hours (`IDLE_MS`) |
| 7.3.2 | 2 | Absolute maximum lifetime | ✅ Pass | 7 days (`ABSOLUTE_MS`) |
| 7.4.1 | 1 | Termination disallows further use | ✅ Pass | sign-out deletes the row (`/signout`); `it/auth.test.ts` "sign-out ends the session and audits it" |
| 7.4.2 | 1 | Disabled account → sessions ended | ✅ Pass | `resolveSession` returns nothing for an account with `disabledAt` set, on every request and every SSE heartbeat |
| 7.4.3 | 2 | Option to end other sessions after a factor change | 🔧 Pass — fixed | a password change ends every other session unless the caller sends `endOtherSessions: false`. TOTP cannot be changed in the webmail. `7fd2297` |
| 7.4.4 | 2 | Logout visible on every authenticated page | ✅ Pass | *Sign out* in the account menu of `Shell`, which wraps every signed-in route (`apps/web/src/App.tsx`) |
| 7.4.5 | 2 | Admins can end sessions for one user or all | 🔧 Pass — fixed | one session: `DELETE /api/admin/sessions/:id`; one account or everyone: `DELETE /api/admin/sessions?accountId=…` / `?all=1` (`admin.ts:73`), step-up and audited. `7fd2297` |
| 7.5.1 | 2 | Re-authentication before changing authentication attributes | 🔧 Pass — fixed | password change: current password + TOTP; linking D3 Auth: a sign-in or step-up from the last five minutes (`freshlyAuthenticated`, `routes.ts:95`). Linking needed only a signed-in browser before. `7fd2297` |
| 7.5.2 | 2 | View and (re-authenticated) end sessions | 🔧 Pass — fixed | `GET /api/auth/sessions`; `DELETE /api/auth/sessions/:id` and `DELETE /api/auth/sessions` (all others), behind step-up. `7fd2297`. The screen for it is listed for the web app (see notes) |
| 7.6.1 | 2 | RP/IdP lifetimes behave as documented | ✅ Pass | back-channel logout ends the `(iss, sub)`'s D3 Auth sessions only, idempotent by `jti` — `it/oidc.test.ts` "back-channel logout ends the D3 Auth sessions of that subject, once" |
| 7.6.2 | 2 | Session creation needs consent or an explicit action | ✅ Pass | *Sign in with D3 Auth* is a button the person clicks; D3 Auth's own *Continue as* follows (AUTH REQ-059) |

## V8 Authorization

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 8.1.1 | 1 | Function- and data-level rules documented | 📝 Pass — documented | §Authorization rules |
| 8.1.2 | 2 | Field-level rules documented | 📝 Pass — documented | §Authorization rules — Fields |
| 8.2.1 | 1 | Function-level access restricted | ✅ Pass | `requireSession`/`requireAdmin`/`requireStepUp` at the mounts (`app.ts`); `it/auth.test.ts` "403 for a non-admin on every /api/admin route" |
| 8.2.2 | 1 | Data-level access (IDOR/BOLA) | ✅ Pass | every lookup scoped by the session's account; `it/mail.test.ts` "never reaches another account's mail (404, not 403)", `it/mail-search.test.ts` "not for another account" |
| 8.2.3 | 2 | Field-level access (BOPLA) | ✅ Pass | explicit field-by-field serialisers; `MessagePatch` accepts only flags and mailbox |
| 8.3.1 | 1 | Enforced at a trusted layer | ✅ Pass | server-side only; the web's `redirectFor` is navigation, not a control |
| 8.4.1 | 2 | Cross-tenant controls | ✅ Pass | each account is its own tenant for mail; the admin role grants operations, not other people's mail; an admin reaches only *service* accounts' app passwords (`api/app-passwords/index.ts` `targetOf`) |

## V9 Self-contained Tokens

Postroom consumes two JWTs, both from D3 Auth and both through `@d3cloudio/auth-client`: ID tokens
at `/oidc/callback` and logout tokens at `/oidc/backchannel-logout`. It issues none.

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 9.1.1 | 1 | Validated by signature before use | ✅ Pass | `completeSignIn` and `verifyLogoutToken` verify against the issuer's JWKS before any claim is read |
| 9.1.2 | 1 | Algorithm allowlist; no `none` | ✅ Pass | the SDK pins ES256/RS256 (AUTH ASVS 9.1.2) |
| 9.1.3 | 1 | Keys only from trusted pre-configured sources | ✅ Pass | the JWKS from the configured issuer's own discovery; `jku`/`x5u`/`jwk` headers never consulted |
| 9.2.1 | 1 | `exp`/`nbf` enforced | ✅ Pass | SDK; logout tokens also refused when old |
| 9.2.2 | 2 | Correct token type | ✅ Pass | logout tokens must be `logout+jwt` with the back-channel event and no `nonce` |
| 9.2.3 | 2 | Audience checked | ✅ Pass | `aud` must be Postroom's `client_id` (`verifyLogoutToken({ issuer, clientId })`, `routes.ts` backchannel) |
| 9.2.4 | 2 | Shared key → audience restriction | ✅ Pass | every D3 Auth token names its client in `aud` |

## V10 OAuth and OIDC

Postroom is an OIDC **relying party** only. The authorization-server, resource-server, provider and
consent rows are D3 Auth's, assessed in its own self-assessment.

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 10.1.1 | 2 | Tokens only where needed (BFF) | ✅ Pass | the code exchange is server-side; the browser only ever holds Postroom's own session cookie; tokens are not kept |
| 10.1.2 | 2 | Code/ID token only from the same user-agent session | ✅ Pass | verifier, state and nonce ride in an AES-GCM-sealed `HttpOnly` cookie set on the starting browser, and `state` must match it (`routes.ts` `/oidc/callback`); `it/oidc.test.ts` "refuses a callback whose state does not match" |
| 10.2.1 | 2 | CSRF on the code flow (PKCE or `state`) | ✅ Pass | both: S256 PKCE and `state` from `beginSignIn` |
| 10.2.2 | 2 | Mix-up defence with several AS | ✅ Pass | exactly one issuer is configured; the SDK checks `iss` |
| 10.3.1 | 2 | RS accepts only its audience | ➖ N/A | Postroom accepts no access tokens |
| 10.3.2 | 2 | RS decisions from delegated claims | ➖ N/A | as above |
| 10.3.3 | 2 | RS identifies users by non-reassignable claims | ➖ N/A | as above (for ID tokens, see 10.5.2) |
| 10.3.4 | 2 | RS enforces strength/recency | ➖ N/A | as above |
| 10.4.1 | 1 | AS: exact redirect URI matching | ➖ N/A | not an authorization server |
| 10.4.2 | 1 | AS: single-use codes | ➖ N/A | not an authorization server |
| 10.4.3 | 1 | AS: short-lived codes | ➖ N/A | not an authorization server |
| 10.4.4 | 1 | AS: only needed grants | ➖ N/A | not an authorization server |
| 10.4.5 | 1 | AS: refresh-token replay | ➖ N/A | not an authorization server; Postroom requests no refresh token |
| 10.4.6 | 2 | AS: PKCE required | ➖ N/A | not an authorization server (Postroom does use PKCE, 10.2.1) |
| 10.4.7 | 2 | AS: dynamic registration | ➖ N/A | not an authorization server |
| 10.4.8 | 2 | AS: refresh-token absolute expiry | ➖ N/A | not an authorization server |
| 10.4.9 | 2 | AS: token revocation UI | ➖ N/A | not an authorization server |
| 10.4.10 | 2 | Confidential client authenticated on back-channel | ✅ Pass | `client_secret_basic` on the token request (`oidc.ts` `OidcProvider`) |
| 10.4.11 | 2 | AS: only required scopes | ➖ N/A | not an authorization server; Postroom asks for `openid profile email d3:roles` only (`SCOPE`) |
| 10.5.1 | 2 | ID-token replay mitigated by `nonce` | ✅ Pass | SDK checks the nonce sealed in the transaction cookie |
| 10.5.2 | 2 | User identified by `sub` | ✅ Pass | `(iss, sub)` — 6.8.1 |
| 10.5.3 | 2 | Metadata issuer must match | ✅ Pass | SDK discovery refuses a mismatched `issuer` |
| 10.5.4 | 2 | `aud` equals `client_id` | ✅ Pass | SDK |
| 10.5.5 | 2 | Back-channel logout: typed token, no DoS | ✅ Pass | typed, signed, audience-checked; idempotent by `jti`; ends only D3 Auth sessions of that `(iss, sub)`, never a password session (`endSessionsFor`) |
| 10.6.1 | 2 | OP: allowed response modes | ➖ N/A | not an OpenID Provider |
| 10.6.2 | 2 | OP: forced-logout DoS | ➖ N/A | not an OpenID Provider |
| 10.7.1 | 2 | AS: consent per request | ➖ N/A | not an authorization server |
| 10.7.2 | 2 | AS: clear consent information | ➖ N/A | not an authorization server |
| 10.7.3 | 2 | AS: review and revoke consents | ➖ N/A | not an authorization server |

## V11 Cryptography

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 11.1.1 | 2 | Documented key management policy and lifecycle | 📝 Pass — documented | §Cryptographic inventory — generation, storage, escrow, rotation, one holder per key |
| 11.1.2 | 2 | Cryptographic inventory | 📝 Pass — documented | §Cryptographic inventory |
| 11.2.1 | 2 | Industry-validated implementations | ✅ Pass | Node's OpenSSL (`node:crypto`), `argon2` (reference implementation), `otpauth` over Web Crypto, `jose` in the SDK. Postroom implements no primitive |
| 11.2.2 | 2 | Crypto agility | ✅ Pass | every ciphertext starts with a format byte and a KEK id (`packages/crypto/src/aead.ts`); Argon2 parameters live in the hash string; DKIM carries its algorithm per key |
| 11.2.3 | 2 | ≥ 128-bit security | ⚖️ Accepted | See below |
| 11.3.1 | 1 | No ECB or weak padding | ✅ Pass | AES-GCM only; the RSA-PKCS#1 v1.5 in DKIM signatures is signing, which RFC 6376 mandates, not encryption |
| 11.3.2 | 1 | Approved ciphers and modes (AES-GCM) | ✅ Pass | AES-256-GCM everywhere (`@postroom/crypto`, the OIDC transaction cookie) |
| 11.3.3 | 2 | Encrypted data protected against modification | 🔧 Pass — fixed | GCM with AAD binding each ciphertext to its owner (blob hash, `totp:<accountId>`); the transaction cookie now pins a 16-byte tag (`authTagLength`, `oidc.ts:109`) so a truncated tag cannot be offered; `hardening` "refuses a truncated GCM tag". `83b519c` |
| 11.4.1 | 1 | Approved hash functions; no MD5 | ✅ Pass | SHA-256 for tokens, blob addresses and HKDF; no MD5 or SHA-1 except inside TOTP's HMAC-SHA-1, which RFC 6238 defines and which is not collision-dependent |
| 11.4.2 | 2 | Passwords stored with an approved KDF, tuned | ✅ Pass | Argon2id, 64 MiB, t=3, p=1 (OWASP's second profile) with a server-side pepper (`passwords.ts:11`) |
| 11.4.3 | 2 | Collision-resistant hashes ≥ 256 bits for integrity | ✅ Pass | SHA-256 for blob integrity, backup manifests and signatures |
| 11.4.4 | 2 | Password-derived keys use a stretching KDF | ✅ Pass | the KEK escrow bundle is sealed under Argon2id of `BACKUP_KEK_PASSPHRASE` (`@postroom/crypto` bundle) |
| 11.5.1 | 2 | Non-guessable values from a CSPRNG, ≥ 128 bits | 🔧 Pass — fixed | sessions, enrol tokens and challenges 256 bits from `randomBytes`; the sign-in decoy used `Math.random()` and now uses `randomBytes` (`83b519c`); Semgrep `postroom.insecure-randomness`. App passwords: see 11.2.3 |
| 11.6.1 | 2 | Approved algorithms for key generation and signatures | ✅ Pass | Node's key generation for RSA-2048/Ed25519 DKIM keys; ES256/RS256 verification in the SDK |

> [!warning] 11.2.3 — two primitives under 128 bits of security
> **Deviation.** DKIM's RSA-2048 keys give about 112 bits; an app password's secret part is 100 random
> bits.
> **Why.** DKIM verifiers widely support only RSA, and RFC 8301 sets 1024–2048 as the norm; Postroom
> signs with Ed25519 alongside it. App passwords are typed on phones: 100 bits in 20 characters is
> the length the format chose.
> **Compensating controls.** DKIM keys sign outbound mail only and rotate by selector; app passwords
> are stored as Argon2id with a pepper (so an offline attack needs the host's environment as well as
> the database), throttled online, scoped per protocol, revocable, and never accepted by the webmail.
> **Retire by** moving to RSA-3072 once receivers accept it routinely, and lengthening the app
> password secret to 26 characters (130 bits) in `@postroom/credentials`.

## V12 Secure Communication

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 12.1.1 | 1 | Only TLS 1.2/1.3, latest preferred | ✅ Pass | the web terminates at Cloudflare, whose zone setting *Minimum TLS Version* must read 1.2 (checked at the gate, not in this repository); the mail listeners set `minVersion: 'TLSv1.2'` (`apps/imap/src/server.ts`, `apps/submission/src/server.ts`, `packages/smtp-proto/src/tls.ts`) |
| 12.1.2 | 2 | Recommended cipher suites, strongest preferred | ✅ Pass | Cloudflare's modern suite set; the daemons use Node's OpenSSL defaults for TLS 1.2+ |
| 12.1.3 | 2 | mTLS client certificates validated | ➖ N/A | no mTLS |
| 12.2.1 | 1 | TLS for all client connections to HTTP services; no fallback | ✅ Pass | the only ingress is the Cloudflare Tunnel on HTTPS; HSTS (3.4.1); no port is published (CI checks `docker-compose.yml`) |
| 12.2.2 | 1 | Publicly trusted certificates | ✅ Pass | Cloudflare's edge certificate for `mail.d3cloud.io`; ACME certificates for the mail ports (PST-ADR-010) |
| 12.3.1 | 2 | Encrypted protocol for every connection, including the database | ⚖️ Accepted | See below |
| 12.3.2 | 2 | TLS clients validate certificates | ✅ Pass | the API's only TLS client is its call to D3 Auth, verified by Node's defaults. (The delivery daemon's opportunistic STARTTLS to remote MXes is RFC 3207 and outside this scope; MTA-STS/DANE enforcement is PST-T-7.5) |
| 12.3.3 | 2 | TLS between internal HTTP services | ⚖️ Accepted | See below |
| 12.3.4 | 2 | Internal TLS uses trusted certificates | ⚖️ Accepted | See below |

> [!warning] 12.3.1, 12.3.3, 12.3.4 — plaintext inside the host
> **Deviation.** `api` ↔ PostgreSQL and `cloudflared` → `api` are plaintext on the Compose network.
> **Why.** Every container is on one host, on a Docker bridge that never leaves its kernel; TLS there
> protects against an attacker who already has the host, who also has the keys.
> **Compensating controls.** No database port and no HTTP port is published (CI refuses one in the
> base compose file); the only ingress is the tunnel and WireGuard; mail content in the database is
> already AES-256-GCM ciphertext under per-blob DEKs; backups leave the host encrypted.
> **Retire by** enabling `ssl=on` in PostgreSQL with a private CA and `sslmode=verify-full` in
> `DATABASE_URL`, the day the database moves to another machine.

## V13 Configuration

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 13.1.1 | 2 | Communication needs documented | 📝 Pass — documented | §Communication inventory |
| 13.2.1 | 2 | Backend components authenticated without static credentials | ⚖️ Accepted | See below |
| 13.2.2 | 2 | Least-privilege accounts between components | ⚖️ Accepted | See below |
| 13.2.3 | 2 | No default credentials between components | ✅ Pass | `POSTGRES_PASSWORD` is required on the host; `.env.example` ships every secret empty |
| 13.2.4 | 2 | Allowlist of external resources | ✅ Pass | the API's only destination is the configured issuer (§Communication inventory); the web app is held to its own origin by CSP `connect-src 'self'` and Semgrep |
| 13.2.5 | 2 | Server configured with an allowlist of destinations | ✅ Pass | as 13.2.4: the destination is configuration, never input |
| 13.3.1 | 2 | Secrets in a secrets manager; not in source or artefacts | ⚖️ Accepted | See below |
| 13.3.2 | 2 | Least-privilege access to secrets | ✅ Pass | `.env` is mode 600 on the host; each secret is read once at boot; the backup IAM user is put-only; the KEK escrow needs a separate passphrase |
| 13.4.1 | 1 | No source-control metadata deployed | ✅ Pass | `.dockerignore` excludes `.git`; the image drops `src`, `test`, `fixtures`, `docs`, `e2e`, `.github` (`Dockerfile`) |
| 13.4.2 | 2 | Debug modes off in production | ✅ Pass | the image sets `NODE_ENV=production`; there is no debug route; errors never carry a stack (16.5.1) |
| 13.4.3 | 2 | No directory listings | ✅ Pass | `express.static` with `index: false`; unknown paths fall through to the SPA's `index.html` |
| 13.4.4 | 2 | No HTTP TRACE | ✅ Pass | no route answers TRACE; under `/api` it is refused by `csrfGuard` (not a safe method) |
| 13.4.5 | 2 | Documentation and monitoring endpoints only if intended | 📝 Pass — documented | the OpenAPI document is a file in the repository, not served; `/health` is public by intent (Shipyard reads revision and schema from it) and carries nothing else |

> [!warning] 13.2.1, 13.2.2, 13.3.1 — one database role, secrets in a host file
> **Deviation.** Every daemon connects as the database's owner with a static password, and the
> secrets live in the host's `.env` rather than a vault.
> **Why.** One host, one operator, no secrets manager in the ecosystem; Shipyard deploys from the
> same file.
> **Compensating controls.** The database is reachable only on the Compose network; `audit_event` is
> append-only by trigger; the pepper and KEK never enter the database; secrets are never in source
> or images (Semgrep, `.dockerignore`, `.gitignore`).
> **Retire by** a `postroom_app` role holding only `SELECT, INSERT, UPDATE, DELETE` (and no
> `UPDATE`/`DELETE` on `audit_event`), with migrations alone running as the owner — a new migration
> plus a second URL in `docker-compose.yml` for the `migrate` service.

## V14 Data Protection

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 14.1.1 | 2 | Sensitive data identified and classified | 📝 Pass — documented | §Sensitive data |
| 14.1.2 | 2 | Protection requirements per level | 📝 Pass — documented | §Sensitive data |
| 14.2.1 | 1 | No sensitive data in URLs | ✅ Pass | credentials and tokens only in bodies and cookies; the only query-string secret is the OIDC `code`, single-use and short-lived by protocol; `Referrer-Policy: no-referrer` |
| 14.2.2 | 2 | Not cached in server components | 🔧 Pass — fixed | `Cache-Control: no-store` on every `/api` response unless a route narrows it (`app.ts:72`), so Cloudflare never caches mail; `hardening` "marks every /api response no-store". `adb0879` |
| 14.2.3 | 2 | Not sent to untrusted parties | ✅ Pass | no telemetry, trackers or third-party scripts (PST-REQ-159; CSP; Semgrep `postroom.web-third-party-*`) |
| 14.2.4 | 2 | Controls implemented per level | ✅ Pass | as §Sensitive data: redaction in the audit log (`packages/audit/src/redact.ts`), KEK sealing, Argon2id, `no-store` |
| 14.3.1 | 1 | Client data cleared after the session ends | 🔧 Pass — fixed | sign-out sends `Clear-Site-Data: "cache", "storage"` and clears the cookie; the SPA holds mail only in memory. `adb0879` |
| 14.3.2 | 2 | Anti-caching headers | 🔧 Pass — fixed | as 14.2.2; downloads are `private, no-store`. `adb0879` |
| 14.3.3 | 2 | No sensitive data in browser storage | ✅ Pass | `localStorage` holds only the theme choice (`postroom-theme`); cookies hold only the session and the sealed OIDC transaction |

## V15 Secure Coding and Architecture

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 15.1.1 | 1 | Remediation time frames documented | 📝 Pass — documented | §Third-party components |
| 15.1.2 | 2 | SBOM / inventory from trusted repositories | ✅ Pass | `pnpm-lock.yaml` with integrity hashes, the supply-chain policy in `pnpm-workspace.yaml`, actions pinned by SHA, images by digest |
| 15.1.3 | 2 | Resource-demanding functionality documented | 📝 Pass — documented | §Resource-demanding functions |
| 15.2.1 | 1 | Components within their remediation windows | ✅ Pass | `pnpm audit --prod`: three advisories, none reachable (§Third-party components) |
| 15.2.2 | 2 | Defences against resource exhaustion implemented | ✅ Pass | as §Resource-demanding functions — throttles before hashing, caps, streaming |
| 15.2.3 | 2 | No test or development code in production | ✅ Pass | the image removes `test`, `fixtures`, `e2e`, `fuzz` and dev dependencies; the fake issuer lives in `e2e/` |
| 15.3.1 | 1 | Only required fields returned | ✅ Pass | explicit serialisers (`toJson`, `detailJson`, `summaryJson`); session lists omit token hashes |
| 15.3.2 | 2 | Backend does not follow redirects to external URLs unintentionally | ✅ Pass | the only outbound fetch is OIDC discovery/token at the configured issuer, through the SDK |
| 15.3.3 | 2 | Mass assignment prevented | ✅ Pass | zod objects strip unknown keys and every write names its fields (`MessagePatch`, `CreateBody`, `PasswordChange`) |
| 15.3.4 | 2 | Original client IP carried correctly | ✅ Pass | one trusted hop (4.1.3); the throttles, setup gate, sessions and audit rows all use `req.ip` |
| 15.3.5 | 2 | Strict types and equality | ✅ Pass | TypeScript strict, `@typescript-eslint` strict type-checked, zod at every boundary; `===` throughout |
| 15.3.6 | 2 | No prototype pollution | ✅ Pass | `Map`/`Set` for runtime stores (`BoundedMap`, the throttle); no deep merge of input; zod output is a fresh object |
| 15.3.7 | 2 | HTTP parameter pollution | ✅ Pass | each handler reads one named source; repeated query keys arrive as arrays and fail `typeof === 'string'` or zod |

## V16 Security Logging and Error Handling

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 16.1.1 | 2 | Logging inventory | 📝 Pass — documented | §Logging inventory |
| 16.2.1 | 2 | When, where, who, what in each entry | ✅ Pass | `audit_event`: `at`, `ip`, `user_agent`, `request_id`, actor, action, entity, before/after (`packages/audit`) |
| 16.2.2 | 2 | Synchronised clocks; UTC | ✅ Pass | `timestamptz` columns; ISO-8601 `Z` strings; host NTP |
| 16.2.3 | 2 | Logs only where the inventory says | ✅ Pass | the audit table and stderr — nothing else is written |
| 16.2.4 | 2 | Common, machine-readable format | ✅ Pass | JSON rows and one-object-per-line JSON on stderr |
| 16.2.5 | 2 | Sensitive data logged by protection level | ✅ Pass | `redact()` removes secret-named keys and bearer/basic values from every audit payload; Semgrep `postroom.secret-in-log` refuses secrets on `console`/stderr |
| 16.3.1 | 2 | All authentication operations logged | ✅ Pass | `auth.signin`, `auth.signin.rejected` (factor and reason), `auth.signin.password_accepted`, `auth.setup.*`, `auth.step-up*`, `auth.oidc.rejected`, `auth.signout`, `auth.password.change*` |
| 16.3.2 | 2 | Failed authorization logged | 🔧 Pass — fixed | `authz.denied` with method, path and reason from `requireAdmin`, `requireStepUp` and the app-password target check (`recordDenied`, `middleware.ts:31`). `adb0879` |
| 16.3.3 | 2 | Security events and bypass attempts logged | 🔧 Pass — fixed | CSRF refusals (`csrf-refused`) and throttled attempts (`auth-throttled`) on stderr; setup-gate refusals audited (`auth.setup.denied`); `audit-missing` when a mutation left no row. `adb0879` |
| 16.3.4 | 2 | Unexpected errors and control failures logged | 🔧 Pass — fixed | `unhandled-error` with request id and stack (`errorHandler`); `oidc-discovery-failed`, `kek-invalid`; `hardening` "hides an unexpected failure". `adb0879` |
| 16.4.1 | 2 | Log injection prevented | ✅ Pass | every stderr line is `JSON.stringify`; audit payloads are JSONB |
| 16.4.2 | 2 | Logs protected from access and modification | ✅ Pass | `audit_event_append_only` trigger refuses `UPDATE`/`DELETE` (init migration); no API route writes or deletes audit rows |
| 16.4.3 | 2 | Logs sent to a logically separate system | ✅ Pass | the audit table leaves the host nightly in the dump, to a versioned SSE-KMS bucket through a put-only IAM user — a compromised host cannot rewrite what has left (`docs/runbooks/backups.md`); alerts leave through D3 Auth's relay |
| 16.5.1 | 2 | Generic error messages | 🔧 Pass — fixed | `{ error: 'internal', requestId }` for anything unexpected; body-parser refusals as `invalid_json`/`body_too_large` (`errorHandler`, `app.ts:116`). `adb0879` |
| 16.5.2 | 2 | Secure operation when external resources fail | ✅ Pass | D3 Auth down: discovery is lazy and retried, the password path never awaits it (PST-REQ-005; the e2e stack runs with the issuer unreachable on purpose) |
| 16.5.3 | 2 | Fail securely, no fail-open | ✅ Pass | missing pepper/KEK → `503 auth_not_configured`, never an unhashed or unsealed write; an unreadable session is no session; a stored hash that will not parse is a failed sign-in (`verifyPassword`) |

## V17 WebRTC

| # | L | Requirement (short) | Status | Evidence |
|---|---|---|---|---|
| 17.1.1 | 2 | TURN restricted from reserved addresses | ➖ N/A | no WebRTC |
| 17.2.1 | 2 | DTLS key managed per policy | ➖ N/A | no WebRTC |
| 17.2.2 | 2 | Approved DTLS-SRTP suites | ➖ N/A | no WebRTC |
| 17.2.3 | 2 | SRTP authentication checked | ➖ N/A | no WebRTC |
| 17.2.4 | 2 | Media server survives malformed SRTP | ➖ N/A | no WebRTC |
| 17.3.1 | 2 | Signalling survives floods | ➖ N/A | no WebRTC |
| 17.3.2 | 2 | Signalling survives malformed messages | ➖ N/A | no WebRTC |

---

## Tally

| Chapter | Requirements | ✅ | 🔧 | 📝 | ⚖️ | ➖ |
|---|---|---|---|---|---|---|
| V1 Encoding and Sanitization | 27 | 21 | 0 | 0 | 0 | 6 |
| V2 Validation and Business Logic | 11 | 7 | 1 | 3 | 0 | 0 |
| V3 Web Frontend Security | 19 | 15 | 3 | 0 | 0 | 1 |
| V4 API and Web Service | 10 | 2 | 1 | 1 | 0 | 6 |
| V5 File Handling | 9 | 6 | 0 | 0 | 1 | 2 |
| V6 Authentication | 35 | 17 | 7 | 4 | 1 | 6 |
| V7 Session Management | 18 | 10 | 5 | 3 | 0 | 0 |
| V8 Authorization | 7 | 5 | 0 | 2 | 0 | 0 |
| V9 Self-contained Tokens | 7 | 7 | 0 | 0 | 0 | 0 |
| V10 OAuth and OIDC | 29 | 10 | 0 | 0 | 0 | 19 |
| V11 Cryptography | 14 | 9 | 2 | 2 | 1 | 0 |
| V12 Secure Communication | 9 | 5 | 0 | 0 | 3 | 1 |
| V13 Configuration | 13 | 8 | 0 | 2 | 3 | 0 |
| V14 Data Protection | 9 | 4 | 3 | 2 | 0 | 0 |
| V15 Secure Coding and Architecture | 13 | 11 | 0 | 2 | 0 | 0 |
| V16 Security Logging and Error Handling | 16 | 11 | 4 | 1 | 0 | 0 |
| V17 WebRTC | 7 | 0 | 0 | 0 | 0 | 7 |
| **Total** | **253** | **148** | **26** | **22** | **9** | **48** |

Counted from the rows above; `docs/security/README.md` says how to recount.

## Notes for the web app

Two API fixes need a screen before a person can use them without a tool: **change password**
(`POST /api/auth/password`, body `{ currentPassword, newPassword, code, endOtherSessions? }`,
answering `400 weak_password` with `problems: ['too_short' | 'too_long' | 'common' | 'context_word']`)
and **your sessions** (`GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`,
`DELETE /api/auth/sessions`, both behind step-up). Setup's error text should name
`weak_password`'s problems. Mail HTML must stay off this origin (1.3.1).

## Related

PST-REQ-089 (Semgrep, `.semgrep/postroom.yml`), PST-REQ-090 (ZAP, `zap/`), PST-REQ-091 (this
document), PST-REQ-005 (dual login), PST-REQ-009 (audit), PST-REQ-027 (app passwords only),
PST-REQ-049 (strict CRLF), PST-REQ-065 (dangerous attachments), PST-REQ-159 (no telemetry),
PST-ADR-009 (KEK and DEKs), PST-ADR-010 (ACME), PST-T-3.12 (usercontent origin), PST-T-4.1,
PST-T-4.2, PST-T-7.5 (MTA-STS/DANE). The sibling assessment is D3 Auth's (AUTH, Phase 5).
