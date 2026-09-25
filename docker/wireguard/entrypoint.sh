#!/bin/sh
# Bring up wg0 to the Lightsail edge when configured; otherwise hold a bare namespace.
set -eu
if [ -z "${WG_PRIVATE_KEY:-}" ]; then
  echo '{"event":"wireguard-unconfigured","note":"WG_PRIVATE_KEY unset; holding a bare namespace"}'
  exec sleep infinity
fi
: "${WG_ADDRESS:=10.77.0.2/24}"
: "${WG_EDGE_PUBLIC_KEY:?WG_EDGE_PUBLIC_KEY is required}"
: "${WG_EDGE_ENDPOINT:?WG_EDGE_ENDPOINT is required}"
umask 077
printf '%s\n' "$WG_PRIVATE_KEY" > /run/wg.key
ip link add wg0 type wireguard
wg set wg0 private-key /run/wg.key peer "$WG_EDGE_PUBLIC_KEY" \
  endpoint "$WG_EDGE_ENDPOINT" allowed-ips 0.0.0.0/0 persistent-keepalive 25
rm -f /run/wg.key
ip address add "$WG_ADDRESS" dev wg0
ip link set wg0 up
# Inbound needs no routing: the edge forwarder is an L4 proxy, so home sees connections from the
# edge's tunnel address (on wg0's own subnet) and the real client arrives in PROXY v2.
# Outbound :25 (delivery) is the only traffic steered into the tunnel, to egress from the edge IP.
# Everything else (Postgres, DNS to unbound, the api) stays on the compose network.
ip route add default dev wg0 table 51820
ip rule add fwmark 0x51820 table 51820
nft -f - <<NFT
table inet postroom {
  chain output {
    type route hook output priority mangle; policy accept;
    tcp dport 25 meta mark set 0x51820
  }
}
NFT
echo "{\"event\":\"wireguard-up\",\"address\":\"$WG_ADDRESS\",\"endpoint\":\"$WG_EDGE_ENDPOINT\"}"
exec sleep infinity
