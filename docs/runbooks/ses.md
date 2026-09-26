# Runbook: the SES fallback

PST-REQ-045, PST-T-1.11, PST-ADR-003. When direct delivery to a domain is not working (an IP
reputation block at Gmail, the edge's port 25 unavailable), relay that domain — or everything —
through Amazon SES's SMTP interface on 587. Same queue, same retries, same DKIM signature.

## Turn it on

1. In SES (us-east-1): verify the `d3cloud.io` domain identity. Keep **Easy DKIM off** for it if
   you want Postroom's signature to be the only `d=d3cloud.io` one; SES adds its own
   `d=amazonses.com` signature either way, which does not disturb ours.
2. SES console → SMTP settings → **Create SMTP credentials**. These are not the IAM access key;
   store the SMTP user name and password as Docker secrets.
3. Set on the `delivery` service (via Shipyard, never by SSH):

   ```bash
   SES_REGION=us-east-1
   SES_SMTP_USER_FILE=/run/secrets/ses_smtp_user
   SES_SMTP_PASSWORD_FILE=/run/secrets/ses_smtp_password
   DELIVERY_SES_DOMAINS=gmail.com,googlemail.com   # or * for everything
   ```

4. Redeploy. The delivery log shows one `ses-enabled` line with the host, port and domains (the
   user name is shown as `[redacted]`). If it says `ses-disabled` instead, its `missing` field names
   the variable that was not set; SES is not used and those domains go direct.

The choice is made at each attempt, so mail already deferred for a listed domain moves to SES on
its next retry. Removing a domain from the list moves it back the same way.

## Check it

- `GET /api/messages/:id/delivery`: attempts for a listed domain show transport `ses`, MX host
  `email-smtp.us-east-1.amazonaws.com`, the TLS version and a peer line ending `verified=true`.
- At the recipient, `Authentication-Results` should show `dkim=pass header.d=d3cloud.io`.
  Postroom's signature is made at submission over the stored bytes and SES relays them unchanged.
- SPF: SES sends from its own MAIL FROM domain unless a custom MAIL FROM is configured, so DMARC
  alignment comes from DKIM. Keep it that way, or set a custom MAIL FROM subdomain in SES.

## When it goes wrong

| Attempt says | Meaning | Do |
|---|---|---|
| `smarthost did not complete STARTTLS: refusing to authenticate in plaintext` | the endpoint offered no STARTTLS | check `SES_SMTP_HOST`/port; never work around it |
| `smarthost certificate did not verify` / TLS handshake error | wrong host name, or interception | check the host; nothing is sent |
| `AUTH: 535 …` (outcome deferred) | bad SMTP credentials | recreate them; mail waits, it does not bounce |
| `454 4.7.0 Throttling failure` | sending rate exceeded | nothing; the queue retries |
| `554 Message rejected: Email address is not verified` | sandbox, or the identity is not verified | leave the sandbox / verify `d3cloud.io` |

Credentials never appear in logs or attempt rows: the session logs events and server reply text,
never the commands it sent.
