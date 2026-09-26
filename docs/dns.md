# DNS records

## Autoconfig

Mail client autoconfiguration (PST-T-3.6, PST-REQ-076) needs these records on `d3cloud.io` (and any
other domain Postroom serves) once the tunnel is up:

| Type | Name | Value | Notes |
| --- | --- | --- | --- |
| CNAME | `autoconfig.d3cloud.io` | the Cloudflare Tunnel hostname | Thunderbird's first guess is `https://autoconfig.<domain>/mail/config-v1.1.xml`. Point it at the same tunnel that serves the API so `GET /mail/config-v1.1.xml` reaches `apps/api`'s autoconfig router. |
| SRV | `_autodiscover._tcp.d3cloud.io` | `0 0 443 autoconfig.d3cloud.io` (or the tunnel hostname directly) | Outlook falls back to an SRV lookup after direct `https://autodiscover.<domain>/...` and `https://<domain>/autodiscover/autodiscover.xml` attempts fail; this record is what lets it find the host without a separate `autodiscover.` A record. |

The plain `https://<domain>/.well-known/autoconfig/mail/config-v1.1.xml` and
`https://<domain>/autodiscover/autodiscover.xml` paths need no new record — they resolve on the
existing `d3cloud.io` apex/API hostname, since `apps/api` mounts the autoconfig router at the site
root ahead of the session gate and the SPA fallback.

> [!note] Apple `.mobileconfig`
> iOS/macOS Mail can also be provisioned by a signed `.mobileconfig` profile the user installs by
> hand — no DNS record is required for it, and Apple Mail otherwise falls back to the same
> `/autodiscover/autodiscover.xml` POX endpoint Outlook uses. A `.mobileconfig` generator is not
> part of PST-T-3.6; if it's wanted later it hangs off the same `autoconfig/` router.

**Manual verification pending:** the live Thunderbird "type the address, it configures itself"
check needs `autoconfig.d3cloud.io` routed through the Cloudflare Tunnel first. Everything short of
that — the exact XML documents, both URLs, unknown-domain 404s, and the Outlook/Apple POX exchange
— is covered by `apps/api/test/unit/autoconfig.test.ts`.

## Calendar and contacts discovery (RFC 6764)

PST-T-8.3. These records let Apple Calendar, Contacts, DAVx⁵ and Thunderbird configure CalDAV and
CardDAV from nothing but the address. `discoveryRecords()` in `apps/dav/src/well-known.ts` is the
source of these rows, and its unit test pins them.

| Type | Name | Value | Why |
| --- | --- | --- | --- |
| CNAME | `dav.d3cloud.io` | the Cloudflare Tunnel hostname | The tunnel routes it to `http://dav:8008` |
| SRV | `_caldavs._tcp.d3cloud.io` | `0 1 443 dav.d3cloud.io.` | CalDAV over TLS lives on `dav.` |
| TXT | `_caldavs._tcp.d3cloud.io` | `"path=/dav/"` | The context path, so no well-known round trip is needed |
| SRV | `_carddavs._tcp.d3cloud.io` | `0 1 443 dav.d3cloud.io.` | CardDAV over TLS lives on `dav.` |
| TXT | `_carddavs._tcp.d3cloud.io` | `"path=/dav/"` | The same context path |
| SRV | `_caldav._tcp.d3cloud.io` | `0 0 0 .` | Plaintext CalDAV is **not offered** (RFC 6764 §3), so no client falls back to sending an app password in the clear |
| SRV | `_carddav._tcp.d3cloud.io` | `0 0 0 .` | The same for CardDAV |

The redirects need no DNS record:

- `dav.d3cloud.io/.well-known/caldav` and `/.well-known/carddav` return 301 to `/dav/`. The DAV
  daemon answers these for any method, because iOS sends PROPFIND.
- `mail.d3cloud.io` answers the same two paths with a 301 to `https://dav.d3cloud.io/dav/`
  (`apps/api/src/autoconfig`, honouring `DAV_HOSTNAME`).

The apex `d3cloud.io` belongs to the landing site. Clients try SRV before the apex well-known, so
the apex needs no redirect.

Check what is published:

```bash
dig +short @1.1.1.1 SRV _caldavs._tcp.d3cloud.io _carddavs._tcp.d3cloud.io _caldav._tcp.d3cloud.io
```

```bash
dig +short @1.1.1.1 TXT _caldavs._tcp.d3cloud.io
```

Publish these when the P8 build (the `dav` daemon) is deployed. An SRV record pointing at a host
that answers nothing is worse than no record at all.
