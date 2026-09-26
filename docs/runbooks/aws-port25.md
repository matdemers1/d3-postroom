# Runbook: AWS port-25 denial

PST-T-13.2, PST-REQ-163. Builds on PST-ADR-002/PST-ADR-003, `edge/cloud-init.yaml`,
`edge/provision.sh`, and [`docs/runbooks/ses.md`](ses.md) (the interim fallback this runbook points
at — read that one for the mechanics of turning SES on).

## Purpose

AWS blocks outbound TCP 25 on Lightsail (and EC2) instances by default, ecosystem-wide anti-spam
policy. Comcast also blocks outbound 25 from home, which is why the edge exists at all
(PST-ADR-002): the edge's static IP, whose PTR is `mx.d3cloud.io`, is meant to be the one place
Postroom's outbound SMTP actually leaves from. If that IP's port 25 is denied by AWS — a fresh
Lightsail account, or an existing one after abuse review — direct delivery to any destination that
does not offer an alternative (nearly everyone, on 25) has no path out at all until it is lifted.

## When to use

- Provisioning the edge for the first time (`edge/provision.sh`) and outbound 25 does not connect.
- After an [edge rebuild](edge-rebuild.md) on a fresh Lightsail account.
- Delivery attempts show a connect timeout or refusal specifically on port 25, from the edge's own
  IP, to destinations that are known to accept SMTP (rule that out against a well-known MX first).

## Prerequisites

- Access to the AWS account's Support Center (Lightsail's port-25 request is filed through AWS
  Support, not the Lightsail console itself).
- The edge's static IP and instance ID/name (`edge/provision.sh`'s summary output, or
  `aws lightsail get-static-ip --static-ip-name postroom-edge-ip`).
- A description of what the instance is for and how outbound mail is authenticated (SPF/DKIM/DMARC
  on `d3cloud.io`) — AWS's form asks for this to distinguish a mail server from a spam source.

## Steps

1. Confirm the block is actually AWS's egress filter and not something else: from the edge
   instance,

   ```sh
   timeout 5 nc -zv <known-mx-host> 25
   ```

   A connection that hangs until timeout (never refused, never accepted) on a destination that is
   reachable from elsewhere is the signature of AWS's silent drop.
2. File the request: AWS Support Center → Create case → **Service limit increase** → category
   **EC2 → Other** (Lightsail routes through the same form) → "Remove email sending limitations".
   Fill in:
   - the region (`us-east-1`) and the instance/Elastic-or-static IP;
   - that this is a self-hosted SMTP relay for `d3cloud.io`, sending real correspondence, not bulk
     or marketing mail;
   - that SPF, DKIM (`docs/runbooks/dkim-rotation.md`) and DMARC are already published for the
     domain;
   - a rough expected volume (low — personal domain mail).
3. While the case is open (AWS's review can take some time and is not guaranteed to approve), turn
   on the SES fallback for outbound so mail keeps moving — see [`ses.md`](ses.md) for the exact
   steps. Set `DELIVERY_SES_DOMAINS=*` to route everything through SES until port 25 opens, or list
   specific domains if only some destinations are affected.
4. Once AWS confirms the limit is lifted, verify (step below), then remove or narrow
   `DELIVERY_SES_DOMAINS` so direct delivery on port 25 resumes being the primary path — SES stays
   configured as the standing fallback (PST-ADR-003) rather than being torn down.

## Verification

- `timeout 5 nc -zv <known-mx-host> 25` from the edge now connects (TCP handshake completes; you
  do not need to complete a full SMTP transaction to confirm the port itself is open).
- A real message's delivery attempt (`GET /api/messages/:id/delivery`) shows a direct attempt on
  port 25 succeeding, not falling to a connect error.
- Nothing in the request changes the edge's own firewall — `edge/ports.sh show` should already
  show 25 open on the Postroom side; this runbook is entirely about AWS's outbound egress filter,
  not Postroom's own inbound rules.

## Rollback / abort

- There is nothing to undo on the Postroom side while the case is open: the SES fallback (step 3)
  is additive and reversible by editing `DELIVERY_SES_DOMAINS` and redeploying through
  [`deploy.md`](deploy.md).
- If AWS denies the request, the SES fallback becomes the standing path for the affected domains
  rather than a temporary one — update `DELIVERY_SES_DOMAINS` accordingly and note it in the
  execution record below.

## Execution record

| Field | Value |
|---|---|
| Last executed | not yet executed |
| By | — |
| Result | — |
| Precondition needed | operator access to AWS Support Center for the Lightsail account, and a live edge instance/IP to cite in the request |

## Relates to

PST-REQ-163 · PST-ADR-002 · PST-ADR-003 · PST-T-13.2

See also: [`docs/runbooks/README.md`](README.md) · [`docs/runbooks/ses.md`](ses.md) (turning on the interim fallback) · [`docs/runbooks/edge-rebuild.md`](edge-rebuild.md) (where this block is first hit, on a new edge).
