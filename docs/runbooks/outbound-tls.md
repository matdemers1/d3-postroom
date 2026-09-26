# Runbook: outbound DANE and MTA-STS

PST-REQ-126, PST-T-7.5. When a recipient domain publishes DANE TLSA records or an MTA-STS policy in
`enforce` mode, the delivery daemon refuses to deliver without a TLS session that verifies. Mail to
such a domain defers — it never falls back to plaintext or to an unverified certificate. Code:
`apps/delivery/src/policy/`.

## Reading an attempt

Every `DeliveryAttempt.tls_peer` for a policy domain starts with the decision:

```text
tls-policy=mta-sts-enforce; policy-verified=no; policy-reason=certificate did not verify: DEPTH_ZERO_SELF_SIGNED_CERT; CN=mx.example.com; …
tls-policy=dane; policy-verified=yes; policy-reason=DANE-EE 3 1 1 matched the leaf; CN=…
tls-policy=mta-sts-testing; policy-verified=no; policy-reason=MX mx3.example.com is not in the MTA-STS policy
```

and the attempt's remote text (`4.7.5`) repeats the reason: `mx.example.com [192.0.2.1]
mta-sts-enforce requires verified TLS: …`. The daemon log has `tls-policy-refused`,
`mx-skipped-by-tls-policy`, `mta-sts-policy` (id, mode, fetched or cached) and
`mta-sts-testing-would-fail`.

## Mail to a domain is stuck deferred with 4.7.5

1. **Look at the reason** on the latest attempt. It is one of:
   - `certificate did not verify` / `certificate not valid for <mx>` — their MX certificate is
     broken or expired (MTA-STS). Their problem; mail retries on the normal schedule for 5 days.
   - `STARTTLS not offered` — their MX lost TLS, or something on the path strips STARTTLS. Check
     from the Zima: `openssl s_client -starttls smtp -connect <mx>:25 -servername <mx>` through the
     same egress (the WireGuard netns), not from the Mac.
   - `is not in the MTA-STS policy` — the MX set changed without the policy, or someone is
     answering MX queries they should not be. Compare `dig @1.1.1.1 MX <domain>` with
     `curl https://mta-sts.<domain>/.well-known/mta-sts.txt`.
   - `DANE: no TLSA record … matched` — their certificate rolled without the TLSA record following.
     `dig @1.1.1.1 +dnssec TLSA _25._tcp.<mx>` and compare with the leaf's SPKI hash.
   - `TLSA lookup … failed: SERVFAIL` — their DNSSEC is bogus (or our Unbound cannot validate).
     `dig @127.0.0.1 -p <unbound port> TLSA _25._tcp.<mx>` on the host; `+cd` shows the answer
     without validation.
2. **Do not route around it.** Relaying such a domain through SES (`DELIVERY_SES_DOMAINS`) is the
   only sanctioned escape hatch, and only for a domain whose operator has confirmed the fault; SES
   applies its own TLS policy. There is no switch that downgrades a single domain.
3. If the fault is ours (our Unbound, our trust store), fix that; deferred mail picks up on its next
   retry.

## Policy cache

MTA-STS policies are cached per domain until `max_age`, and refetched when the `_mta-sts` TXT id
changes. A vanished TXT record does not clear an unexpired cached policy (RFC 8461 §5.1). The daemon
uses an in-memory cache today, so a restart refetches; `createSettingPolicyStore` in
`src/policy/mta-sts.ts` persists to the `setting` table (`mta-sts:<domain>`) once the daemon wires
it in. To force a refetch for one domain: restart the delivery service (memory cache), or delete
the `mta-sts:<domain>` setting row (persisted cache).

## What is not here yet

- TLS-RPT (RFC 8460) reports: the would-fail lines under `testing` are recorded, not reported.
- DANE via a CNAME'd MX host name (RFC 7672 §2.2.3) uses the MX name as the TLSA base only.
