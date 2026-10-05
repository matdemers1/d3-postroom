# CLAUDE.md — Postroom

Hand-rolled mail server + webmail for **d3cloud.io only**. A public Apache-2.0 **learning build**:
the point is to understand every part, so protocols, parsers and auth checks are written here, not
wrapped. demers.dev stays on Outlook and is out of scope forever.

## Foreman

The plan of record is **PST** in Foreman (`foreman_brief PST`). Documents: `foreman://PST/overview`,
`/discovery`, `/research`, `/architecture`, `/data_model`, `/ux_flows`, `/api_contract`,
`/test_strategy`, `/feature_ideas`. ADRs PST-ADR-001…013, risks PST-R-001…012, 17 phases (PST-P-0…16).
Cite requirements and tasks by human ID (`PST-REQ-049`, `PST-T-1.5`) in commits; declare
attribution with `foreman_attribute`.

## Stack

Node 22 (ESM, TS strict) · pnpm 10 workspaces · Express · Prisma + PostgreSQL 16 · React 19 + Vite +
`@d3cloud/ui` · Vitest · fast-check · Jazzer.js (nightly) · Playwright · Docker Compose · Shipyard deploys ·
AWS Lightsail edge (us-east-1) + WireGuard · Cloudflare Tunnel (web/DAV), Worker (canary).

## Commands

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

```bash
pnpm test:integration   # needs DATABASE_URL pointing at PostgreSQL 16
```

Workspace packages export a `source` condition pointing at `src/`: tests, typecheck and `tsx` resolve
siblings from source, and `tsc -p tsconfig.build.json` resolves their built `dist`. `pnpm -r build`
is topological, so a clean build works in one command.

## Non-negotiables

- **Strict CRLF.** Only `<CRLF>.<CRLF>` ends DATA; bare LF/CR is a 5xx (PST-REQ-049, SMTP smuggling).
- **Stream everything.** 100 MB messages; no parser buffers a whole message (PST-REQ-050).
- **250 only after fsync + commit** (PST-REQ-060). `kill -9` after 250 never loses mail — a gating test.
- **No relay, ever**, from any source (PST-REQ-053).
- **Protocols accept app passwords only**, never the account password (PST-REQ-027).
- **PROXY v2 only from the edge's WireGuard peer**, and required on that path (PST-REQ-016).
- **Nothing public until the gate passes**; MX is published after it (PST-REQ-086). Outbound may go first.
- **The edge holds no mail and no keys.** TLS terminates at home.
- **Every mutation is audited** (PST-REQ-009). **No telemetry, no third-party scripts** (PST-REQ-159).
- **Sorting decisions always store their reasons.** No LLM in v1 (PST-ADR-007).
- **Postroom's own alerts go through the D3 Auth relay**, never its own queue (PST-REQ-096).
- **Dual login**: app-native (Argon2id + pepper + TOTP) and D3 Auth; identities link by (iss, sub), never email.
- **The private corpus is never committed.** Only `fixtures/golden` (synthetic) is.

## Conventions

- One image, one entrypoint per daemon; the protocol daemons share the wireguard sidecar's netns.
- Parsers live in `packages/*` with fast-check properties beside them and a fuzz harness in `fuzz/`.
  A fuzzer crasher becomes a regression fixture before it is fixed.
- Deploy through Shipyard, never by SSH. The edge is rebuilt from `edge/`, never patched.
- DNS: always verify with `dig @1.1.1.1` — the local resolver on this Mac has returned empty TXT answers.
- `no-reply.d3cloud.io` belongs to Cloudflare Email Service (D3 Auth relay, Sarah Byrne form) and has
  its own DMARC `p=reject`. Never touch it.
- No time estimates anywhere; T-shirt sizes only. No Claude attribution in commits.

## The native app contract (PST-P-19)

D3 Constellation reaches Postroom through the D3 App contract (`matdemers1/d3-app-contract`,
CON-ADR-003). All of it is `apps/api/src/auth/native.ts`, `native-sessions.ts` and `d3auth-bearer.ts`:

- `GET /.well-known/d3-app.json` — the manifest, endpoints on `webOrigin`. `d3auth` and `link` appear
  only while Sign in with D3 Auth is configured.
- `POST /api/auth/native/signin` — password (`202 {next: "totp", challenge}`), then `{challenge, totp}`
  for tokens, or `{challenge, recoveryCode}` → `403 reenrol_required` with a new secret, then
  `{challenge, enrolTotp}` replaces the authenticator, issues ten codes and ends every other session
  (CON-ADR-014). Throttles, attempt caps, decoy hashing and audit actions are the web sign-in's.
- `refresh` rotates through `native_refresh`; a replaced token presented again ends the session
  (`refresh_reused`). `revoke` and `me` take the Bearer access token. Refusals are problem+json.
- **A native session is a `session` row** with `native = true`, a device name, and a 15-minute
  access token as its `idHash` that never slides. A cookie only ever resolves a browser row and a
  Bearer token only a native one. The sessions screens list a native row while its refresh token is
  live (`liveSessionWhere`), so an idle phone stays visible and revocable.
- **D3 Auth tokens** are verified against the issuer's JWKS (issuer, `aud` = this origin, 60 s
  leeway, the SDK's algorithms) and mapped by `(iss, sub)` only. A linked token becomes a native row
  keyed by its own hash, expiring with it — so every route, SSE and step-up work unchanged — and is
  never listed: D3 Auth governs those devices. Unlinked is `identity_not_linked` at `me`;
  `POST /api/auth/native/link` proves the account once with password and code.
- `/api/auth/native/*` is exempt from the CSRF header (no cookie is read or set there), and so is any
  request carrying a Bearer token and no cookie.
- **Push** (PST-T-20.4/20.5, `packages/push`): `POST /api/push/native/register` takes the device's
  P-256 key and its relay registration; the send key is sealed under the KEK. A registration belongs
  to the native session that made it (cascade), or for a D3 Auth token to the identity link; a 410
  from the relay forgets it. Every notification is envelope v1 sealed to the device and signed with
  HMAC-SHA256 over `timestamp.body`. The worker pushes new Priority mail after filing, never awaited.
  Only https relays, except `RELAY_ALLOW_LOOPBACK_HTTP=1` for CI's mock relay.
- Conformance: `apps/api/test/conformance-server.ts` boots the api on a throwaway database and writes
  the suite's arguments; CI's `conformance` job runs `ghcr.io/matdemers1/d3-app-conformance:contract-1`
  against it, and needs a `D3_CONTRACT_TOKEN` (read:packages) secret while the contract repo is private.
