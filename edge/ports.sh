#!/usr/bin/env bash
# Open or close the edge's public mail ports in the Lightsail firewall. Closed until go-live
# (PST-REQ-086); `open 465` alone is used for the PST-P-0 exit demo.
#   edge/ports.sh open 465 | open all | close all | show
set -euo pipefail
REGION=${AWS_REGION:-us-east-1}
NAME=$(aws lightsail --region "$REGION" get-static-ip --static-ip-name "${EDGE_STATIC_IP:-postroom-edge-ip}" --query staticIp.attachedTo --output text)
action=${1:?open|close|show}; which=${2:-all}
ports=(25 465 587 993 4190); [[ $which != all ]] && ports=("$which")
case $action in
  show) aws lightsail --region "$REGION" get-instance-port-states --instance-name "$NAME" --output table ;;
  open) for p in "${ports[@]}"; do aws lightsail --region "$REGION" open-instance-public-ports --instance-name "$NAME" --port-info "fromPort=$p,toPort=$p,protocol=tcp,cidrs=0.0.0.0/0" >/dev/null; echo "opened $p"; done ;;
  close) for p in "${ports[@]}"; do aws lightsail --region "$REGION" close-instance-public-ports --instance-name "$NAME" --port-info "fromPort=$p,toPort=$p,protocol=tcp,cidrs=0.0.0.0/0" >/dev/null; echo "closed $p"; done ;;
  *) echo "usage: $0 open|close|show [port|all]" >&2; exit 2 ;;
esac
