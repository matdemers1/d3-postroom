# DNS records

## Autoconfig

Mail client autoconfiguration (PST-T-3.6, PST-REQ-076). Published 2026-09-27:

| Type | Name | Value | Notes |
| --- | --- | --- | --- |
| CNAME (proxied) | `autoconfig.d3cloud.io` | `mail.d3cloud.io` | Thunderbird's first guess is `https://autoconfig.<domain>/mail/config-v1.1.xml`. |
| CNAME (proxied) | `autodiscover.d3cloud.io` | `mail.d3cloud.io` | Outlook and Apple Mail POST to `https://autodiscover.<domain>/autodiscover/autodiscover.xml`. |

Each hostname also needs a **public hostname on the Postroom tunnel**, routed to `http://api:3300`.
A proxied CNAME alone reaches the tunnel with a Host header the tunnel does not know, and the
tunnel's catch-all answers 404. The tunnel's ingress is the list in Zero Trust → Networks → Tunnels
→ `postroom` → Public hostnames.

There is no `_autodiscover._tcp` SRV record. An SRV target cannot be a Cloudflare-proxied hostname:
Cloudflare rewrites the target to a `_dc-srv.…` name that points at `<tunnel>.cfargotunnel.com`,
which has no public address, so a client following the SRV reaches nothing. The
`autodiscover.` CNAME covers the same clients.

The plain `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml` and
`https://<domain>/autodiscover/autodiscover.xml` paths need no new record: `apps/api` mounts the
autoconfig router at the site root ahead of the session gate and the SPA fallback.

> [!note] Apple `.mobileconfig`
> iOS/macOS Mail can also be provisioned by the signed `.mobileconfig` profile (PST-T-8.6), which
> needs no DNS record.

The documents name `mx.d3cloud.io` for IMAP (993) and submission (465/587). That host exists only
once the edge does, so autoconfiguration completes end to end after go-live. The XML documents,
both URLs, unknown-domain 404s and the POX exchange are covered by
`apps/api/test/unit/autoconfig.test.ts`.

Check:

```bash
curl -s "https://autoconfig.d3cloud.io/mail/config-v1.1.xml?emailaddress=test@d3cloud.io"
```

## Calendar and contacts discovery

PST-T-8.3. Discovery is **`.well-known` only** (operator decision, 2026-09-27). Published:

| Type | Name | Value | Why |
| --- | --- | --- | --- |
| CNAME (proxied) | `dav.d3cloud.io` | `<postroom tunnel>.cfargotunnel.com` | The tunnel routes it to `http://dav:8008` |

The redirects need no DNS record:

- `dav.d3cloud.io/.well-known/caldav` and `/.well-known/carddav` return 301 to `/dav/`. The DAV
  daemon answers these for any method, because iOS sends PROPFIND.
- `mail.d3cloud.io` answers the same two paths with a 301 to `https://dav.d3cloud.io/dav/`
  (`apps/api/src/autoconfig`, honouring `DAV_HOSTNAME`).

A client given the address `name@d3cloud.io` and the server `mail.d3cloud.io` (or `dav.d3cloud.io`)
lands on `/dav/`, which asks for an app password (401 Basic).

**No RFC 6764 SRV/TXT records.** `_caldavs._tcp` and `_carddavs._tcp` were published once and
removed the same day: their target has to be a proxied tunnel hostname, and Cloudflare rewrites a
proxied SRV target to a `_dc-srv.…` name with no public address, so a client following them reaches
nothing. They become possible only if DAV gets a non-proxied address. `discoveryRecords()` in
`apps/dav/src/well-known.ts` still generates the full RFC 6764 set for that case.

Check:

```bash
dig +short @1.1.1.1 dav.d3cloud.io
```

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" -X PROPFIND https://mail.d3cloud.io/.well-known/caldav
```
