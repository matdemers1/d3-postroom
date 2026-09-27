#!/usr/bin/env bash
# Open or close the edge's public mail ports in the Lightsail firewall. Closed until go-live
# (PST-REQ-086); `open 465` alone is used for the PST-P-0 exit demo. `open <ports|all> <cidr>`
# opens to one CIDR only — for pre-gate tests from a known IP, never to 0.0.0.0/0 by accident
# (PST-T-4.14 / PST-REQ-088). No CIDR argument still means the world, as before.
#   edge/ports.sh open 465 | open 465 203.0.113.9/32 | open all | close all | show
# DRY_RUN=1 prints the aws command instead of running it.
set -euo pipefail

is_cidr() {
  local cidr=$1 ip prefix octet
  [[ $cidr =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/([0-9]{1,2})$ ]] || return 1
  ip=${BASH_REMATCH[1]}
  prefix=${BASH_REMATCH[2]}
  (( prefix >= 0 && prefix <= 32 )) || return 1
  IFS='.' read -ra octets <<<"$ip"
  for octet in "${octets[@]}"; do
    (( octet >= 0 && octet <= 255 )) || return 1
  done
  return 0
}

aws_lightsail() {
  if [[ -n ${DRY_RUN:-} ]]; then
    # stderr, not stdout: callers that redirect the real command's stdout to /dev/null (open/close,
    # which only want the "opened $p" echo after) must still see the command DRY_RUN prints.
    echo "aws lightsail --region $REGION $*" >&2
  else
    aws lightsail --region "$REGION" "$@"
  fi
}

REGION=${AWS_REGION:-us-east-1}
action=${1:?open|close|show}
which=${2:-all}
cidr=${3:-0.0.0.0/0}

if [[ $action != show ]]; then
  is_cidr "$cidr" || { echo "not a CIDR: $cidr" >&2; exit 2; }
fi

if [[ -n ${DRY_RUN:-} ]]; then
  NAME=dry-run-instance
else
  NAME=$(aws lightsail --region "$REGION" get-static-ip --static-ip-name "${EDGE_STATIC_IP:-postroom-edge-ip}" --query staticIp.attachedTo --output text)
fi
ports=(25 465 587 993 4190)
[[ $which != all ]] && ports=("$which")

case $action in
  show) aws_lightsail get-instance-port-states --instance-name "$NAME" --query 'portStates[].{port:fromPort,protocol:protocol,cidrs:cidrs}' --output table ;;
  open) for p in "${ports[@]}"; do aws_lightsail open-instance-public-ports --instance-name "$NAME" --port-info "fromPort=$p,toPort=$p,protocol=tcp,cidrs=$cidr" >/dev/null; echo "opened $p to $cidr"; done ;;
  close) for p in "${ports[@]}"; do aws_lightsail close-instance-public-ports --instance-name "$NAME" --port-info "fromPort=$p,toPort=$p,protocol=tcp,cidrs=$cidr" >/dev/null; echo "closed $p"; done ;;
  *) echo "usage: $0 open|close|show [port|all] [cidr]" >&2; exit 2 ;;
esac
