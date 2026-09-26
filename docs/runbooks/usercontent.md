# Runbook: the usercontent origin

PST-REQ-081, PST-REQ-082, PST-T-3.12. Mail HTML is never served from the mail origin. It is
sanitised on the server (`apps/api/src/usercontent/sanitize.ts`) and served from a separate origin,
`https://usercontent.d3cloud.io`, framed by the webmail in
`<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer">` — no
`allow-scripts`, no `allow-same-origin`. The ASVS self-assessment's V3 rows depend on this staying
true.

## How it is wired

One api process, two origins, chosen by the `Host` header:

| Host | Answered by | Has |
|------|-------------|-----|
| `mail.d3cloud.io` (`WEB_ORIGIN`) | the mail app | the session cookie, `/api`, the SPA |
| `usercontent.d3cloud.io` (`USERCONTENT_ORIGIN`) | `usercontentApp` only | `/m/:token`, `/m/:token/cid/:cid`, `/img`, `/csp-report` — nothing else, no cookie |

A request for the usercontent host never falls through to the mail app (anything else there is a
plain-text 404), and the mail app never serves `/m/…`.

Because the usercontent origin has no session, the webmail asks the mail origin for a **render
ticket** — `GET /api/messages/:id/render[?images=1]` — which mints a 15-minute HMAC capability for
one message of the caller's, under the caller's session. The usercontent routes verify the token
and re-check that the session is still live, so signing out ends every open frame's reach too. The
key is derived from `SESSION_SECRET`; rotating that secret invalidates every open render (and every
session), nothing else.

The render's response headers:

```text
Content-Security-Policy: default-src 'none'; img-src data: cid: https://usercontent.d3cloud.io;
  style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none';
  frame-ancestors https://mail.d3cloud.io; sandbox allow-popups allow-popups-to-escape-sandbox;
  report-uri https://usercontent.d3cloud.io/csp-report
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-DNS-Prefetch-Control: off
Cache-Control: private, no-store
```

There is no `script-src`: `default-src 'none'` covers it. The mail origin's own CSP gains exactly
one directive, `frame-src https://usercontent.d3cloud.io`.

`allow-popups allow-popups-to-escape-sandbox` is there only so that a link — always rewritten to
`target="_blank" rel="noopener noreferrer"` — opens in an ordinary tab. Nothing else is granted.

The frame has a fixed height (70vh) and scrolls inside itself: no script runs in it to report its
content height, and a server-side guess would be wrong for any layout that depends on width.

## Remote images

Blocked by default. The sanitizer replaces every remote `<img src>` with a transparent 1×1 GIF and
keeps the address in `data-src`; CSS `url()` and `@import` are removed outright. The reading pane
says how many were blocked and offers **Load images**, which asks for a new render with
`images=1`: each remote image is then rewritten to `/img?u=<url>&t=<token>&s=<mac>` on the
usercontent origin, and the server fetches it. The browser never contacts a sender's host.

The image proxy (`apps/api/src/usercontent/proxy.ts`) refuses loopback, private, link-local, CGNAT,
multicast, documentation and unspecified addresses (IPv4-mapped and NAT64 forms too), connects to
the address it checked, re-checks every redirect hop (at most three), allows ports 80, 443, 8080
and 8443, and serves only PNG, JPEG, GIF, WebP, AVIF, BMP and ICO whose bytes match their declared
type, up to 10 MB, within 10 s. It sends no cookie and no referrer, and its User-Agent is
`Postroom-ImageProxy/1`. Each `/img` URL carries a MAC over (token, address), so the proxy fetches
only addresses the sanitizer wrote into that render.

`IMAGE_PROXY_ALLOW_PRIVATE=1` lifts the address rule, and only when `POSTROOM_E2E_SEED=1` is also
set — which is `docker-compose.e2e.yml` and nowhere else.

## Turn it on (the Zima)

1. Cloudflare Zero Trust → Tunnels → Postroom's tunnel → **Public hostname** → add
   `usercontent.d3cloud.io` → service `http://api:3300`. Same service as `mail.d3cloud.io`.
   Leave **HTTP Host Header** empty: the api needs the original Host to choose the app.
2. Set on the `api` service (via Shipyard, never by SSH), as `docs/install/compose.host.yml` does:

   ```bash
   USERCONTENT_ORIGIN=https://usercontent.d3cloud.io
   ```

3. Redeploy. If rendering is off, the api's log has one `usercontent-disabled` line whose `reason`
   says why: unset or not http(s), the same host as `WEB_ORIGIN` (refused — that would put mail
   HTML beside the session cookie), or no `SESSION_SECRET`. While it is off, the render endpoint
   answers 503 and the reading pane falls back to the text/plain part.

Do not put `usercontent.d3cloud.io` behind Cloudflare Access: the frame loads without credentials.
A capability URL is the access control.

## Check it

```bash
# The render endpoint mints a URL on the other origin (needs a session cookie):
curl -s -b 'postroom_session=…' https://mail.d3cloud.io/api/messages/<id>/render | jq .url

# The usercontent origin serves no mail app:
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://usercontent.d3cloud.io/api/mailboxes
# → 404 text/plain; charset=utf-8

# The mail origin frames only usercontent:
curl -sI https://mail.d3cloud.io/ | grep -i content-security-policy | tr ';' '\n' | grep frame-src
```

The api logs a `usercontent-csp-violation` line for every CSP report. There should never be one: the
sanitizer removes everything the CSP would block. One means the sanitizer let something through —
treat it as a security bug, keep the report, and write the payload into
`apps/api/test/unit/usercontent-sanitize.test.ts` before fixing it.

## Development and e2e

Any host that differs from `WEB_ORIGIN`'s works. The e2e stack uses `WEB_ORIGIN=http://127.0.0.1:3300`
and `USERCONTENT_ORIGIN=http://localhost:3300`: the same published port, a different origin and a
different *site*, so the `127.0.0.1` session cookie is never sent to it. A locally started api does
the same on its own port. `e2e/tests/html-render.spec.ts` starts a listener standing in for the
sender's server; it names `127.0.0.1` against a local api and `host.docker.internal` under CI (the
e2e compose maps that to the runner), or `E2E_PIXEL_HOST` if set.
