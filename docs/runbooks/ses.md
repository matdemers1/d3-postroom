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

## Bounces and complaints after SES said yes

PST-T-11.15, PST-REQ-176. SES answering `250 Ok <id>` is what marks a recipient `delivered`, so a
hard bounce or a complaint that comes *later* is only seen if SES tells Postroom. Without this,
the suppression list only learns from synchronous 5.1.x replies, and the SES complaint rate — the
number that gets an SES account paused — is invisible.

### Set it up (once, in us-east-1)

1. **SNS topic.** SNS → Topics → Create topic → *Standard*, name `postroom-ses`. Copy its ARN
   (`arn:aws:sns:us-east-1:<account>:postroom-ses`).
2. **Tell Postroom the topic** before subscribing, or the confirmation is refused. On the `api`
   service (via Shipyard):

   ```bash
   SES_SNS_TOPIC_ARNS=arn:aws:sns:us-east-1:<account>:postroom-ses
   SES_SNS_REGION=us-east-1     # the certificate must come from sns.us-east-1.amazonaws.com
   ```

   Redeploy. An empty `SES_SNS_TOPIC_ARNS` refuses every POST (403 `sns_topic_refused`).
3. **HTTPS subscription.** On the topic → Create subscription → protocol *HTTPS*, endpoint
   `https://mail.d3cloud.io/api/ses/sns`, **raw message delivery off** (Postroom verifies the SNS
   envelope's signature; a raw delivery has none). SNS posts a `SubscriptionConfirmation`;
   Postroom verifies it and fetches its `SubscribeURL`, and the subscription shows *Confirmed*.
   The audit log has `ses.sns.subscription-confirmed`. If it stays *Pending confirmation*, the api
   log's `ses-sns-refused` line says why (topic, certificate URL, signature).
4. **Configuration set.** SES → Configuration sets → Create `postroom` → Event destinations → Add
   → event types **Hard bounces** and **Complaints** (Bounce and Complaint) → destination *Amazon
   SNS* → the `postroom-ses` topic.
5. **Use the configuration set for every message.** SES → Verified identities → `d3cloud.io` →
   Configuration set → *Default configuration set* = `postroom`. (Postroom does not add an
   `X-SES-CONFIGURATION-SET` header; the identity default applies to everything it relays.)
6. Leave **email feedback forwarding** on for the identity: the sender then also gets the bounce
   as a normal DSN in their INBOX. That DSN goes through the inbound pipeline too and is only
   recorded (the recipient is already bounced, or the DSN names a Message-ID SES rewrote), so
   nothing is counted twice.

### Check it

Send to `bounce@simulator.amazonses.com` and `complaint@simulator.amazonses.com` from webmail.
Within a minute: the first recipient's delivery timeline shows `delivered` then a
`ses-notification` attempt `bounced` with `5.1.1`, and the address is on Admin → Suppressions; the
second produces an operator alert email ("complaint (abuse) about outbound mail"). Remove the
simulator address from the suppression list afterwards.

### What Postroom does with each notification

| SNS message | Postroom |
|---|---|
| `SubscriptionConfirmation` | fetch the `SubscribeURL` (SNS hosts only); audited |
| `UnsubscribeConfirmation` | audited; never resubscribes by itself |
| Bounce, `Permanent` | the correlated recipient `delivered → bounced` with SES's status and diagnostic (a `ses-notification` attempt row; `lastText` starts `[SES bounce notification]`); with status 5.1.x **or no status**, the address is suppressed |
| Bounce, `Transient` / `Undetermined` | recorded only |
| Complaint | recorded against the message; **one operator alert** per notification (D3 Auth relay) |
| anything else (Delivery, Send, …) | 200 and ignored, so SNS does not retry |

Every event is a `delivery_feedback` row with what was done and why (`reasons`), and an audit row.
The SNS `MessageId` is the dedupe key, so SNS redelivering a message changes nothing.

**Correlation.** SES may rewrite the `Message-ID` header, so a notification is tied to the outbound
recipient by SES's own message id — the one it answered DATA with, kept on the delivered attempt —
and by the `Message-ID` in the notification's headers when SES left it alone. A Permanent bounce
suppresses the address even when no outbound row matches (the queue row was purged): the signature
makes the notification trustworthy on its own.

**Security.** The route has no session and no CSRF check; its authentication is the SNS signature
(SignatureVersion 1 = SHA1withRSA, 2 = SHA256withRSA, over AWS's string-to-sign). The TopicArn is
checked against `SES_SNS_TOPIC_ARNS` *before* anything is fetched; the signing certificate is only
fetched from `https://sns.<region>.amazonaws.com/….pem` (no redirects, 5 s timeout) and cached by
URL. Bodies over 256 KB get 413, non-JSON 400, a bad signature 403. A message is never logged whole.

## Bounces and complaints that arrive as mail

The same happens without SES in the loop. The inbound pipeline's last stage, `feedback`, reads every
filed message that is a `multipart/report`:

- **`report-type=delivery-status`** (RFC 3464 DSN): each `Action: failed` recipient bounces the
  matching delivered recipient with the remote status; 5.1.x suppresses the address. Only when the
  DSN comes from a null reverse-path or a `MAILER-DAEMON`/`postmaster` From, was not quarantined,
  and names — by returned `Message-ID` or `Original-Envelope-Id` — outbound mail sent by an account
  the DSN was delivered to, with that recipient on it. Anything else is recorded as `ignored` with
  the reason. The DSN is still filed to the user's mailbox like any mail.
- **`report-type=feedback-report`** (RFC 5965 ARF, e.g. from a mailbox provider's feedback loop to
  `abuse@`): recorded against the outbound message its returned copy names, with one operator alert.
  An ARF report that names no message of ours is recorded without an alert.

Replaying the `feedback` stage (Admin → Jobs) records nothing twice and alerts once.
