# Runbook: signed .mobileconfig for Mail + Calendar + Contacts

PST-T-8.6, PST-REQ-139. One button on the web app's **Set up iPhone / Mac** screen
(`/account/device-setup`) mints a fresh app password (scoped `imap`, `smtp`, `dav`) and hands back
an Apple configuration profile carrying Mail (com.apple.mail.managed), Calendar
(com.apple.caldav.account) and Contacts (com.apple.carddav.account) for the signed-in account, in
one file. `POST /api/mobileconfig` is behind a session, a fresh step-up and CSRF, exactly like
minting an app password by hand — and it is audited the same way.

The whole thing is hand-rolled: `apps/api/src/mobileconfig/plist.ts` writes the XML property list,
`apps/api/src/mobileconfig/der.ts` and `cms.ts` build and sign a CMS (PKCS#7) `SignedData`
structure with `node:crypto`. No node-forge, no third-party CMS/plist library.

## Signed vs unsigned

- **Unsigned** (no signing certificate configured): the profile still installs on iOS, but the
  install screen shows **"Unverified"** in red, and the web app says so before the download.
  Nothing about Mail/Calendar/Contacts stops working — the warning is purely about who vouches for
  the profile's origin.
- **Signed**: with `MOBILECONFIG_SIGNING_CERT_FILE` and `MOBILECONFIG_SIGNING_KEY_FILE` set (PEM,
  RSA or EC), the server wraps the plist in a CMS `SignedData` and iOS shows **"Verified"** with the
  certificate's identity, as long as the certificate chains to something iOS trusts (a public CA) or
  the device already trusts it.

## Getting a signing certificate

The signing certificate does not need to be the TLS certificate for any of Postroom's own
hostnames — it only has to be a certificate iOS is willing to call "Verified", which in practice
means it chains to a public root. The simplest option that already exists in this stack:

1. Issue a certificate for a hostname this Postroom deployment controls (e.g. `mail.d3cloud.io`)
   through the same ACME path used for the mail/web TLS certificates — Let's Encrypt via the
   existing `certbot`/ACME client on the Zima, or Cloudflare's origin CA if the domain is proxied.
2. Point the two env vars at the resulting files:

   ```bash
   MOBILECONFIG_SIGNING_CERT_FILE=/etc/postroom/mobileconfig/cert.pem
   MOBILECONFIG_SIGNING_KEY_FILE=/etc/postroom/mobileconfig/key.pem
   # optional: an intermediate bundle, concatenated PEM certificates
   MOBILECONFIG_SIGNING_CHAIN_FILE=/etc/postroom/mobileconfig/chain.pem
   ```

3. Restart the `api` daemon. The files are read once at startup — a certificate renewal needs a
   restart to pick up (the same operational shape as the mail TLS certificates already have).

A self-signed certificate works too (and is what the test suite uses), but iOS will still say
"Unverified" unless that certificate — or a CA above it — has separately been installed and trusted
on the device, which defeats the point for anyone but the person who made it.

## Installing on iOS

1. Open `/account/device-setup` in Safari on the phone (or AirDrop/email the downloaded
   `.mobileconfig` to it — Mail and Files both offer to install a profile they recognize).
2. Tap the downloaded file. iOS shows **Settings → Profile Downloaded** was configured; tap it.
3. **Settings → General → VPN & Device Management → \<profile name\> → Install.** Enter the device
   passcode. Review the three payloads (Mail, Calendar, Contacts) and tap Install again to confirm.
4. Mail, Calendar and Contacts all populate from that one install — no separate account setup in
   each app.

On a Mac: double-click the file, then **System Settings → Privacy & Security → Profiles** to
review and install it — the same three payloads.

## Why one app password, three payloads

A single app password is minted with all three scopes (`imap`, `smtp`, `dav`) and embedded in every
payload that needs it: Mail's incoming (IMAP, 993) and outgoing (SMTP, 465) servers, and both DAV
payloads' password field. Revoking it on the **App passwords** screen signs the device out of Mail,
Calendar and Contacts at their next sync — there is no separate credential per app to hunt down.
Each generation mints a **new** password, labelled `iPhone profile <date>`; the old one (from a
previous install) still works until it is revoked by hand.

## Troubleshooting

- **"Unverified" in red on the install screen** — no signing certificate is configured (see above),
  or the certificate does not chain to a CA the device already trusts. Cosmetic only.
- **The profile does not install at all / "profile could not be downloaded"** — the browser saved
  the file with the wrong extension, or an intercepting proxy altered the bytes in transit (any
  change at all invalidates the CMS signature, if one is present, but does not stop an unsigned
  profile from installing).
- **Mail authenticates but Calendar/Contacts do not** — check the app password still has the `dav`
  scope on the **App passwords** screen (a manually edited/older password might not); generating a
  new profile always mints one with all three scopes.
- **Wrong CalDAV/CardDAV principal URL** — it is built from the account id
  (`https://<DAV_HOSTNAME>/dav/principals/<account-id>/`), the same path `apps/dav` itself answers
  `current-user-principal` with; see `docs/runbooks/dav.md`.

## Env reference

| Variable | Default | Meaning |
|---|---|---|
| `MOBILECONFIG_SIGNING_CERT_FILE` | unset | PEM certificate; unset serves an unsigned profile |
| `MOBILECONFIG_SIGNING_KEY_FILE` | unset | PEM private key matching the certificate |
| `MOBILECONFIG_SIGNING_CHAIN_FILE` | unset | optional PEM bundle of intermediate certificates |
| `IMAP_HOSTNAME` | `mx.d3cloud.io` | Mail payload's incoming server |
| `SUBMISSION_HOSTNAME` | `mx.d3cloud.io` | Mail payload's outgoing server |
| `DAV_HOSTNAME` | `dav.d3cloud.io` | Calendar/Contacts payloads' server and principal URL |

In production, `IMAP_HOSTNAME`/`SUBMISSION_HOSTNAME` should be set to `mail.d3cloud.io` (the edge
hostname mail clients actually connect to) alongside the api daemon's other environment, the same
place `autoconfig`'s Thunderbird/Outlook config already reads them from.
