# The WireGuard sidecar whose network namespace smtp-in, submission, imap and delivery share
# (PST-ADR-002, PST-T-0.14). Userspace-free: it needs the host kernel's wireguard module.
FROM alpine:3.22
RUN apk add --no-cache wireguard-tools-wg iproute2 nftables tini
COPY entrypoint.sh /usr/local/bin/wg-entrypoint
COPY health.sh /usr/local/bin/wg-health
RUN chmod +x /usr/local/bin/wg-entrypoint /usr/local/bin/wg-health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/wg-entrypoint"]
