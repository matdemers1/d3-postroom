#!/usr/bin/env python3
"""External gate probe (PST-T-4.4, PST-REQ-086): run from a host OUTSIDE the edge, with the edge's
ports opened to that host only (edge/ports.sh open all <probe-ip>/32). Standard library only.

    python3 gate-probe.py mx.d3cloud.io [local-recipient]

Prints one JSON line per check and exits non-zero when any check fails. It never completes a DATA
transaction to an outside address; the only message it may deliver is the smuggling probe to the
local recipient, and only if the server wrongly accepts it (which is itself a failure).
"""
import imaplib
import json
from concurrent.futures import ThreadPoolExecutor
import smtplib
import socket
import ssl
import sys

HOST = sys.argv[1] if len(sys.argv) > 1 else "mx.d3cloud.io"
LOCAL = sys.argv[2] if len(sys.argv) > 2 else f"postmaster@{HOST.split('.', 1)[1]}"
DOMAIN = LOCAL.split("@", 1)[1]
OUTSIDE = "relay-test@example.com"
EXPECTED_OPEN = {25, 465, 587, 993}
results = []


def record(name, ok, detail):
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    print(json.dumps(results[-1]), flush=True)


def ctx():
    c = ssl.create_default_context()
    c.minimum_version = ssl.TLSVersion.TLSv1_2
    return c


def port_open(port, timeout=4):
    try:
        with socket.create_connection((HOST, port), timeout=timeout):
            return True
    except OSError:
        return False


# 1. Only the mail ports answer.
sweep = sorted(set(range(1, 1025)) | {1433, 2525, 3000, 3300, 3306, 4190, 5432, 6379, 8008, 8080, 8443, 9101, 9102, 9103, 9104, 9105, 9106, 9108, 51820})
with ThreadPoolExecutor(max_workers=128) as pool:
    open_ports = {p for p, up in zip(sweep, pool.map(lambda p: port_open(p, 3), sweep)) if up}
record("port-sweep", open_ports == EXPECTED_OPEN, {"open": sorted(open_ports), "expected": sorted(EXPECTED_OPEN)})


def smtp25():
    s = smtplib.SMTP(HOST, 25, local_hostname="gate-probe.invalid", timeout=30)
    return s


# 2. Port 25: banner, STARTTLS offered, certificate valid for the MX name.
try:
    s = smtp25()
    code, msg = s.ehlo()
    offered = s.has_extn("starttls")
    record("25-starttls-offered", code == 250 and offered, {"ehlo": code, "starttls": offered})
    s.starttls(context=ctx())
    cert = s.sock.getpeercert()
    record("25-certificate", True, {"subject": dict(x[0] for x in cert["subject"]), "notAfter": cert["notAfter"], "tls": s.sock.version()})
    s.quit()
except Exception as e:  # noqa: BLE001
    record("25-certificate", False, repr(e))

# 3. No relay, from any angle (PST-REQ-053), with and without TLS.
RELAY_CASES = [
    ("outside->outside", "someone@example.org", OUTSIDE),
    ("own-domain-sender->outside", f"spoof@{DOMAIN}", OUTSIDE),
    ("null-sender->outside", "", OUTSIDE),
    ("percent-hack", "someone@example.org", f"relay-test%example.com@{DOMAIN}"),
    ("source-route", "someone@example.org", f"@{DOMAIN}:relay-test@example.com"),
    ("double-at", "someone@example.org", f"relay-test@example.com@{DOMAIN}"),
    ("quoted-local", "someone@example.org", f'"relay-test@example.com"@{DOMAIN}'),
    ("bang-path", "someone@example.org", f"example.com!relay-test@{DOMAIN}"),
    ("bracket-ip", "someone@example.org", "relay-test@[93.184.215.14]"),
]
for tls in (False, True):
    for name, sender, rcpt in RELAY_CASES:
        label = f"relay-{'tls' if tls else 'plain'}-{name}"
        try:
            s = smtp25()
            s.ehlo()
            if tls:
                s.starttls(context=ctx())
                s.ehlo()
            mcode, mmsg = s.docmd(f"MAIL FROM:<{sender}>")
            if mcode >= 400:
                record(label, True, {"refusedAt": "MAIL", "reply": f"{mcode} {mmsg.decode(errors='replace')}"})
            else:
                rcode, rmsg = s.docmd(f"RCPT TO:<{rcpt}>")
                record(label, rcode >= 500 or (400 <= rcode < 500), {"mail": mcode, "rcpt": f"{rcode} {rmsg.decode(errors='replace')}"})
            s.close()
        except smtplib.SMTPServerDisconnected as e:
            record(label, True, {"disconnected": repr(e)})
        except Exception as e:  # noqa: BLE001
            record(label, False, repr(e))

# 4. A real local recipient is accepted (so the refusals above are about relaying, not a dead server).
try:
    s = smtp25()
    s.ehlo()
    s.starttls(context=ctx())
    s.ehlo()
    mcode, _ = s.docmd("MAIL FROM:<gate-probe@example.org>")
    rcode, rmsg = s.docmd(f"RCPT TO:<{LOCAL}>")
    s.docmd("RSET")
    s.quit()
    record("local-recipient-accepted", mcode == 250 and rcode == 250, {"mail": mcode, "rcpt": f"{rcode} {rmsg.decode(errors='replace')}"})
except Exception as e:  # noqa: BLE001
    record("local-recipient-accepted", False, repr(e))

# 5. SMTP smuggling: a bare-LF end of data must not end DATA, and bare LF is refused (PST-REQ-049).
try:
    s = smtp25()
    s.ehlo()
    s.starttls(context=ctx())
    s.ehlo()
    s.docmd("MAIL FROM:<gate-probe@example.org>")
    rcode, _ = s.docmd(f"RCPT TO:<{LOCAL}>")
    dcode, _ = s.docmd("DATA")
    payload = (b"From: gate-probe@example.org\r\nTo: " + LOCAL.encode() + b"\r\nSubject: PST-T-4.4 smuggling probe\r\n\r\n"
               b"line\n.\nMAIL FROM:<smuggled@example.org>\r\nRCPT TO:<" + LOCAL.encode() + b">\r\nDATA\r\nsmuggled\r\n.\r\n")
    s.sock.sendall(payload)
    reply = s.getreply()
    s.close()
    record("smuggling-bare-lf", reply[0] >= 500, {"rcpt": rcode, "data": dcode, "final": f"{reply[0]} {reply[1].decode(errors='replace')}"})
except smtplib.SMTPServerDisconnected as e:
    record("smuggling-bare-lf", True, {"disconnected": repr(e)})
except Exception as e:  # noqa: BLE001
    record("smuggling-bare-lf", False, repr(e))

# 6. A PROXY v2 header from the outside is not trusted (PST-REQ-016): the edge adds its own, so an
# inner one arrives as garbage in place of a command.
try:
    sock = socket.create_connection((HOST, 25), timeout=15)
    banner = sock.recv(512)
    sig = b"\r\n\r\n\x00\r\nQUIT\n"
    fake = sig + b"\x21\x11\x00\x0c" + socket.inet_aton("10.77.0.1") + socket.inet_aton("10.77.0.1") + (25).to_bytes(2, "big") + (25).to_bytes(2, "big")
    sock.sendall(fake + b"EHLO spoof.invalid\r\n")
    sock.settimeout(10)
    reply = b""
    try:
        while not reply.endswith(b"\r\n") or reply.count(b"\r\n") < 1:
            chunk = sock.recv(4096)
            if not chunk:
                break
            reply += chunk
    except socket.timeout:
        pass
    sock.close()
    first = reply.split(b"\r\n", 1)[0].decode(errors="replace")
    record("proxy-v2-spoof", not first.startswith("250"), {"banner": banner[:60].decode(errors="replace").strip(), "reply": first})
except Exception as e:  # noqa: BLE001
    record("proxy-v2-spoof", True, {"closed": repr(e)})

# 7. Submission: no AUTH before TLS on 587, no mail without AUTH, bad credentials refused; same on 465.
try:
    s = smtplib.SMTP(HOST, 587, local_hostname="gate-probe.invalid", timeout=30)
    s.ehlo()
    auth_plain = s.has_extn("auth")
    mcode, mmsg = s.docmd("MAIL FROM:<gate-probe@example.org>")
    record("587-no-auth-before-tls", not auth_plain, {"authAdvertised": auth_plain})
    record("587-mail-needs-tls-and-auth", mcode >= 500, f"{mcode} {mmsg.decode(errors='replace')}")
    s.close()
except Exception as e:  # noqa: BLE001
    record("587-no-auth-before-tls", False, repr(e))
for port in (587, 465):
    try:
        if port == 465:
            s = smtplib.SMTP_SSL(HOST, 465, local_hostname="gate-probe.invalid", timeout=30, context=ctx())
        else:
            s = smtplib.SMTP(HOST, 587, local_hostname="gate-probe.invalid", timeout=30)
            s.ehlo()
            s.starttls(context=ctx())
        s.ehlo()
        mcode, _ = s.docmd("MAIL FROM:<gate-probe@example.org>")
        try:
            s.login("nobody@" + DOMAIN, "not-a-password")
            ok, detail = False, "bogus credentials accepted"
        except smtplib.SMTPAuthenticationError as e:
            ok, detail = True, f"{e.smtp_code} {e.smtp_error.decode(errors='replace')}"
        record(f"{port}-unauthenticated-mail-refused", mcode >= 500, {"mail": mcode})
        record(f"{port}-bad-credentials-refused", ok, detail)
        s.close()
    except Exception as e:  # noqa: BLE001
        record(f"{port}-bad-credentials-refused", False, repr(e))

# 8. IMAP 993: valid certificate, bad credentials refused; 143 is not reachable.
try:
    m = imaplib.IMAP4_SSL(HOST, 993, ssl_context=ctx(), timeout=30)
    cert = m.sock.getpeercert()
    try:
        m.login("nobody@" + DOMAIN, "not-a-password")
        ok, detail = False, "bogus credentials accepted"
    except imaplib.IMAP4.error as e:
        ok, detail = True, str(e)
    record("993-certificate", True, {"subject": dict(x[0] for x in cert["subject"]), "tls": m.sock.version()})
    record("993-bad-credentials-refused", ok, detail)
    m.shutdown()
except Exception as e:  # noqa: BLE001
    record("993-bad-credentials-refused", False, repr(e))

# 9. Old TLS is refused.
for port in (465, 993):
    c = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    c.minimum_version = ssl.TLSVersion.TLSv1
    c.maximum_version = ssl.TLSVersion.TLSv1_1
    try:
        c.set_ciphers("ALL:@SECLEVEL=0")
    except ssl.SSLError:
        pass
    try:
        with socket.create_connection((HOST, port), timeout=10) as raw, c.wrap_socket(raw, server_hostname=HOST) as t:
            record(f"{port}-tls1.1-refused", False, f"negotiated {t.version()}")
    except (ssl.SSLError, OSError) as e:
        record(f"{port}-tls1.1-refused", True, repr(e)[:160])

failed = [r["check"] for r in results if not r["ok"]]
print(json.dumps({"summary": {"checks": len(results), "failed": failed}}))
sys.exit(1 if failed else 0)
