# Registering Postroom with D3 Auth (PST-T-0.9)

`postroom.d3auth.json` is the app manifest for Sign in with D3 Auth (PST-REQ-005, PST-REQ-007).

1. In the D3 Auth console (`https://auth.d3cloud.io`), Apps → Add app → paste the manifest (or add it
   to the provider's `SEED_FILE` and redeploy D3 Auth through Shipyard — it is approval-required).
2. Grant the operator the `admin` role on `postroom`.
3. Put the issued secret in the Zima's `/DATA/postroom/.env`:
   `D3AUTH_ISSUER=https://auth.d3cloud.io`, `D3AUTH_CLIENT_ID=postroom`, `D3AUTH_CLIENT_SECRET=…`.
4. Check the redirect URI is allowed without deploying anything:
   `GET https://auth.d3cloud.io/oidc/auth?client_id=postroom&response_type=code&redirect_uri=https%3A%2F%2Fmail.d3cloud.io%2Fapi%2Fauth%2Foidc%2Fcallback&scope=openid`
   — an allowed URI is answered with a 303 back to it (complaining about PKCE).

Postroom reads the admin role from the `roles` claim (`d3:roles` scope) and links identities by
`(iss, sub)`, never by email.
