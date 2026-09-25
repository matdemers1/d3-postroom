#!/bin/sh
# Healthy when unconfigured (bare namespace) or when wg0 has had a handshake in the last 3 minutes.
[ -z "${WG_PRIVATE_KEY:-}" ] && exit 0
last=$(wg show wg0 latest-handshakes 2>/dev/null | awk '{print $2}' | head -1)
[ -n "$last" ] && [ "$last" -gt 0 ] && [ $(( $(date +%s) - last )) -lt 180 ]
