# The WireGuard sidecar whose network namespace smtp-in, submission, imap and delivery share
# (PST-ADR-002, PST-T-0.14). Userspace-free: it needs the host kernel's wireguard module.
FROM alpine:3.22
RUN apk add --no-cache wireguard-tools-wg iproute2 nftables tini
COPY entrypoint.sh /usr/local/bin/wg-entrypoint
COPY health.sh /usr/local/bin/wg-health
# The handshake-age endpoint for the worker's wireguard monitor (PST-T-4.13): busybox httpd's CGI,
# not a new dependency — busybox ships in the alpine base already.
RUN mkdir -p /www/cgi-bin
COPY health-http.cgi /www/cgi-bin/health
RUN chmod +x /usr/local/bin/wg-entrypoint /usr/local/bin/wg-health /www/cgi-bin/health
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/wg-entrypoint"]
