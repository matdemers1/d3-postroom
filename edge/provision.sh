#!/usr/bin/env bash
# Build a fresh Postroom edge on Lightsail (PST-REQ-017): render cloud-init, create the instance,
# attach the static IP (moving it off any previous edge), open the firewall, and print the edge's
# WireGuard public key for home's .env. The previous instance is left running for the operator to
# delete once the new one is confirmed — rebuilding never destroys anything by itself.
#
#   edge/provision.sh                # uses the default AWS profile, us-east-1
#   HOME_WG_PUBLIC_KEY=… edge/provision.sh
#
# Home's WireGuard keypair is generated on first run into edge/.secrets/ (gitignored, mode 600) when
# HOME_WG_PUBLIC_KEY is not given; its private half belongs in the Zima's postroom .env only.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION=${AWS_REGION:-us-east-1}
AZ=${EDGE_AZ:-${REGION}a}
BUNDLE=${EDGE_BUNDLE:-nano_3_0}          # $5: 512 MB, one public IPv4
BLUEPRINT=${EDGE_BLUEPRINT:-debian_13}
STATIC_IP_NAME=${EDGE_STATIC_IP:-postroom-edge-ip}
NAME=${EDGE_NAME:-postroom-edge-$(date -u +%Y%m%d%H%M)}
SECRETS=edge/.secrets
ls=(aws lightsail --region "$REGION")

mkdir -p "$SECRETS" && chmod 700 "$SECRETS"
admin_cidr=${ADMIN_CIDR:-$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')/32}

if [[ -z "${HOME_WG_PUBLIC_KEY:-}" ]]; then
  if [[ ! -f $SECRETS/home-wg.key ]]; then
    command -v wg >/dev/null || { echo "need wireguard-tools (brew install wireguard-tools) or HOME_WG_PUBLIC_KEY" >&2; exit 1; }
    (umask 077 && wg genkey > "$SECRETS/home-wg.key")
  fi
  HOME_WG_PUBLIC_KEY=$(wg pubkey < "$SECRETS/home-wg.key")
fi

echo "» bundling the forwarder"
pnpm --silent --filter @postroom/edge bundle >/dev/null
bundle=apps/edge/dist/edge.mjs
bundle_sha=$(shasum -a 256 "$bundle" | cut -d' ' -f1)
bundle_b64=$(gzip -9c "$bundle" | base64 | tr -d '\n')

userdata=$(mktemp)
trap 'rm -f "$userdata"' EXIT
sed -e "s|@@EDGE_BUNDLE_B64@@|${bundle_b64}|" \
    -e "s|@@EDGE_BUNDLE_SHA256@@|${bundle_sha}|" \
    -e "s|@@HOME_WG_PUBLIC_KEY@@|${HOME_WG_PUBLIC_KEY}|" \
    -e "s|@@ADMIN_CIDR@@|${admin_cidr}|" \
    edge/cloud-init.yaml > "$userdata"
grep -q '@@' "$userdata" && { echo "unrendered placeholder in cloud-init" >&2; exit 1; }
echo "» user data: $(wc -c < "$userdata") bytes, forwarder sha256 ${bundle_sha:0:12}"

echo "» creating $NAME ($BUNDLE, $BLUEPRINT, $AZ)"
"${ls[@]}" create-instances --instance-names "$NAME" --availability-zone "$AZ" \
  --blueprint-id "$BLUEPRINT" --bundle-id "$BUNDLE" --ip-address-type ipv4 \
  --user-data "file://$userdata" --tags key=app,value=postroom key=role,value=edge >/dev/null
until [[ $("${ls[@]}" get-instance-state --instance-name "$NAME" --query state.name --output text) == running ]]; do sleep 5; done

if ! "${ls[@]}" get-static-ip --static-ip-name "$STATIC_IP_NAME" >/dev/null 2>&1; then
  echo "» allocating static IP $STATIC_IP_NAME"
  "${ls[@]}" allocate-static-ip --static-ip-name "$STATIC_IP_NAME" >/dev/null
fi
previous=$("${ls[@]}" get-static-ip --static-ip-name "$STATIC_IP_NAME" --query 'staticIp.attachedTo' --output text)
if [[ "$previous" != "None" && "$previous" != "$NAME" ]]; then
  echo "» moving $STATIC_IP_NAME off $previous"
  "${ls[@]}" detach-static-ip --static-ip-name "$STATIC_IP_NAME" >/dev/null
fi
"${ls[@]}" attach-static-ip --static-ip-name "$STATIC_IP_NAME" --instance-name "$NAME" >/dev/null
ip=$("${ls[@]}" get-static-ip --static-ip-name "$STATIC_IP_NAME" --query 'staticIp.ipAddress' --output text)

# The Lightsail firewall is the outer wall: WireGuard from anywhere (it is silent to strangers),
# SSH from the operator only. Mail ports stay closed until go-live (PST-REQ-086); edge/ports.sh
# opens them deliberately.
"${ls[@]}" put-instance-public-ports --instance-name "$NAME" --port-infos \
  "fromPort=51820,toPort=51820,protocol=udp,cidrs=0.0.0.0/0" \
  "fromPort=22,toPort=22,protocol=tcp,cidrs=${admin_cidr}" >/dev/null

key=$SECRETS/lightsail-default.pem
if [[ ! -f $key ]]; then
  "${ls[@]}" download-default-key-pair --query privateKeyBase64 --output text > "$key"
  chmod 600 "$key"
fi
ssh_edge() { ssh -i "$key" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$SECRETS/known_hosts" -o ConnectTimeout=10 "admin@$ip" "$@"; }

echo "» waiting for cloud-init on $ip"
for _ in $(seq 1 60); do ssh_edge true 2>/dev/null && break; sleep 10; done
ssh_edge 'sudo cloud-init status --wait >/dev/null; sudo cloud-init status --long | head -3'
edge_pub=$(ssh_edge 'sudo cat /etc/wireguard/edge.pub')
ssh_edge 'systemctl is-active postroom-edge wg-quick@wg0 nftables'

cat <<SUMMARY

Edge $NAME is up at $ip (static IP $STATIC_IP_NAME).
Home .env (on the Zima, never committed):
  WG_PRIVATE_KEY=<contents of $SECRETS/home-wg.key>
  WG_EDGE_PUBLIC_KEY=$edge_pub
  WG_EDGE_ENDPOINT=$ip:51820
  WG_ADDRESS=10.77.0.2/24
  EDGE_PEER_ADDRESS=10.77.0.1
Inventory: edge/inventory.sh $ip
Previous instance (delete once this one is confirmed): ${previous}
SUMMARY
