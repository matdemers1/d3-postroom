#!/bin/sh
# Served by busybox httpd on :9108 (PST-T-4.13, PST-REQ-182) so the worker — which does not share
# this container's network namespace — can learn the peer's handshake age. `{"configured":false}`
# when WG_PRIVATE_KEY is unset (a bare namespace, deliberately not brought up): the worker's
# wireguard monitor must stay quiet on that, not treat it as a down tunnel.
# CGI header lines end in CRLF: busybox httpd passes them through verbatim, and a strict HTTP client
# (Node's) refuses a bare LF (HPE_INVALID_HEADER_TOKEN) — the monitor would then read a healthy tunnel as down.
printf 'Content-Type: application/json\r\n\r\n'
if [ -z "${WG_PRIVATE_KEY:-}" ]; then
  printf '{"configured":false}'
  exit 0
fi
last=$(wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}' | head -1)
if [ -n "$last" ] && [ "$last" -gt 0 ] 2>/dev/null; then
  age=$(( $(date +%s) - last ))
  printf '{"configured":true,"latestHandshake":%s,"ageSeconds":%s}' "$last" "$age"
else
  printf '{"configured":true,"latestHandshake":null,"ageSeconds":null}'
fi
