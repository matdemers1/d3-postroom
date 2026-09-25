# CLAUDE.md — Postroom

Hand-rolled mail server + webmail for **d3cloud.io only**. A public Apache-2.0 **learning build**:
the point is to understand every part, so protocols, parsers and auth checks are written here, not
wrapped. demers.dev stays on Outlook and is out of scope forever.

## Foreman

The plan of record is **PST** in Foreman (`foreman_brief PST`). Documents: `foreman://PST/overview`,
`/discovery`, `/research`, `/architecture`, `/data_model`, `/ux_flows`, `/api_contract`,
`/test_strategy`, `/feature_ideas`. ADRs PST-ADR-001…010, risks PST-R-001…012, 14 phases (PST-P-0…13).
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
