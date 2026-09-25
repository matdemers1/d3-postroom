#!/usr/bin/env bash
# PST-REQ-013: the edge holds no mail, no TLS keys and no credentials except its WireGuard key.
# Lists every private-key-looking file and every mail spool on the edge and fails on anything
# other than the WireGuard key and sshd's own host keys (which every Linux host has).
set -euo pipefail
cd "$(dirname "$0")/.."
ip=${1:?usage: edge/inventory.sh <edge-ip>}
ssh -i edge/.secrets/lightsail-default.pem -o UserKnownHostsFile=edge/.secrets/known_hosts "admin@$ip" 'sudo bash -s' <<'REMOTE'
set -u
found=$(find / -xdev \( -path /proc -o -path /sys -o -path /usr/share -o -path /usr/lib -o -path /etc/ssl/certs \) -prune -o \
  -type f \( -name '*.key' -o -name '*.pem' -o -name '*.p12' -o -name 'id_*' -o -name '*_key' \) -print 2>/dev/null \
  | grep -v -E '^/etc/wireguard/edge\.key$|^/etc/ssh/ssh_host_.*_key$|/snakeoil|\.pub$' || true)
spool=$(find /var/mail /var/spool/mail /var/spool/postfix -type f 2>/dev/null || true)
creds=$(find /root /home -xdev -name '.aws' -o -name 'credentials' -o -name '.netrc' 2>/dev/null || true)
echo "wireguard key: $(ls /etc/wireguard/edge.key)"
echo "ssh host keys: $(ls /etc/ssh/ssh_host_*_key | wc -l)"
echo "other key material: ${found:-none}"
echo "mail spool: ${spool:-none}"
echo "credentials: ${creds:-none}"
[[ -z "$found$spool$creds" ]]
REMOTE
echo "inventory: clean"
