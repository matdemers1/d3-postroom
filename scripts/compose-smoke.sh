#!/bin/sh
# PST-REQ-004: daemons are separate containers from one image — killing imap leaves smtp-in
# listening. Run against a stack that `docker compose up -d --wait` already brought up.
set -eu
dc() { docker compose "$@"; }
banner() { dc exec -T wireguard sh -c "nc -w 3 127.0.0.1 $1 </dev/null" | head -1 | tr -d '\r'; }

before=$(banner 25)
echo "smtp-in before: $before"
case "$before" in 554*|220*) ;; *) echo "smtp-in did not answer on 25" >&2; exit 1 ;; esac

dc kill imap >/dev/null 2>&1
echo "imap killed: $(dc ps imap --format '{{.State}}' || true)"
imap=$(banner 993 || true)
[ -z "$imap" ] || { echo "993 still answers after imap was killed: $imap" >&2; exit 1; }

after=$(banner 25)
echo "smtp-in after: $after"
[ "$after" = "$before" ] || { echo "smtp-in stopped answering after imap was killed" >&2; exit 1; }

dc up -d --wait imap >/dev/null 2>&1
echo "compose smoke: ok"
