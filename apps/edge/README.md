# @postroom/edge

The hand-rolled forwarder that runs on the $5 Lightsail box (PST-ADR-002). It listens on the
public SMTP/submission/IMAP/Sieve ports (25, 465, 587, 993, 4190), forwards each connection over
WireGuard to home prefixed with a PROXY protocol v2 header carrying the real client address, and
answers with a `421` when home is unreachable so a client backs off instead of hanging.

## Why L4 only

The edge holds no mail, no TLS keys and no credentials but WireGuard's (PST-REQ-013). TLS
terminates at home. `forwarder.ts` never inspects the bytes it relays beyond the PROXY v2 header
it writes itself — it is a byte pipe with connection accounting on top, nothing more. That is also
why HAProxy and an nftables DNAT were rejected for this role (PST-ADR-002): DNAT loses the client
IP, and reaching for a ready-made proxy here would mean not understanding the one thing this box
does.

## Env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `EDGE_LISTEN_HOST` | `0.0.0.0` | Address the forwarder listens on |
| `EDGE_PORTS` | `25,465,587,993,4190` | Comma-separated list of ports to listen on; each is mapped to a role (`smtp`, `submission-starttls`, `implicit-tls`, `sieve`) by its canonical port number |
| `HOME_HOST` | — | The home WireGuard peer address (e.g. `10.77.0.2`) connections are forwarded to |
| `EDGE_MAX_PER_IP` | `20` | Concurrent connections allowed from one client address; the 21st is refused |
| `EDGE_MAX_TOTAL` | `1000` | Concurrent connections allowed in total |
| `EDGE_CONNECT_TIMEOUT_MS` | `5000` | How long to wait for the connection to home to establish |
| `EDGE_IDLE_TIMEOUT_MS` | `600000` | Idle timeout applied to each client connection |

A blank value for any of the above is treated as unset (the default applies).

## Behaviour on refusal / failure

- **Per-IP or total cap hit:** for `smtp` (25) and `submission-starttls` (587) — which speak
  plaintext SMTP before any TLS handshake — the client gets `421 4.7.0 mx.d3cloud.io Too many
  connections from your address` and the socket closes. For `implicit-tls` (465, 993) and `sieve`
  (4190) the socket is just closed; those protocols expect TLS/binary framing from byte one, so no
  banner can be written safely.
- **Home unreachable or the connect attempt times out:** same split — `smtp`/`submission-starttls`
  get `421 4.3.2 mx.d3cloud.io Service temporarily unavailable, try again later`, the rest are
  closed silently.
- **Once piping has started, the edge never writes anything else to the client** — from that point
  it is a pure relay.

## Shutdown

`SIGTERM`/`SIGINT` stop accepting new connections immediately and let open ones drain for up to
30 seconds before the process force-closes what remains.

## Logging

One structured JSON line per connection to stdout: timestamp, port, role, client address,
outcome, bytes in/out, duration. No payload is ever logged.
