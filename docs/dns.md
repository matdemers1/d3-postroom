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
