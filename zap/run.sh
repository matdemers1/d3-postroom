#!/usr/bin/env bash
# The authenticated ZAP scan of the webmail and its API (PST-T-4.3, PST-REQ-090).
#
#   COMPOSE_FILE=docker-compose.yml:docker-compose.e2e.yml docker compose up -d --wait   # fresh DB
#   ./zap/run.sh
#
# Exits non-zero on any High finding. Reports land in zap/report/.
set -euo pipefail

# Pinned by digest, like the actions and the Semgrep image. ZAP 2.17.0.
ZAP_IMAGE="ghcr.io/zaproxy/zaproxy@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

# The e2e overlay publishes the api on loopback only, and WEB_ORIGIN is that same URL, so the
# scanner is a same-origin client. ZAP runs on the host network to reach it.
export POSTROOM_URL="${POSTROOM_URL:-http://127.0.0.1:3300}"
export ZAP_TARGET="$POSTROOM_URL"

echo "==> Signing an operator in at $POSTROOM_URL"
ZAP_COOKIE="$(node "$HERE/session.mjs")"
export ZAP_COOKIE

rm -rf "$HERE/report" && mkdir -p "$HERE/report"
chmod 777 "$HERE/report"

echo "==> Scanning $ZAP_TARGET"
# An explicit heap and a matching container limit: left to itself ZAP sizes the heap from the host,
# and D3 Auth's active scan was killed mid-run on a runner that shares memory with the stack.
status=0
docker run --rm \
  --memory 3g \
  --network host \
  -e ZAP_TARGET -e ZAP_COOKIE \
  -v "$HERE:/zap/wrk:rw" \
  "$ZAP_IMAGE" \
  zap.sh -Xmx2g -cmd -autorun /zap/wrk/automation.yaml || status=$?

# ZAP exits 1 for a High (or a broken plan) and 2 when the worst finding is a Medium. The gate is
# "no High" (PST-REQ-090), so 2 is reported and passes; the report is where Mediums are triaged.
case "$status" in
  0) echo "==> No findings above Informational" ;;
  2) echo "==> Medium or lower findings only — read zap/report/zap-report.html" ;;
  *) echo "==> ZAP failed the gate (exit ${status})" >&2; exit "$status" ;;
esac
