# Runbook: edge rebuild

PST-T-13.2, PST-REQ-163. Builds on PST-ADR-002, PST-REQ-013, PST-REQ-017; `edge/cloud-init.yaml`,
`edge/provision.sh`, `edge/inventory.sh`, `edge/ports.sh`, and `docker/wireguard/*`.

## Purpose

Replace the Postroom edge — the stateless AWS Lightsail instance in `us-east-1` that forwards
25/465/587/993/4190 home over WireGuard with PROXY v2 — with a fresh instance from
`edge/cloud-init.yaml`. The edge holds no mail, no TLS keys and no credentials except its own
WireGuard key (generated on first boot, never leaves the instance). It is **rebuilt, never
patched**.

## When to use

- Routine hygiene (a new base image, a nftables/cloud-init change committed to the repo).
- Suspected compromise of the current edge instance.
- The edge's WireGuard key needs rotating.
- `edge/inventory.sh` finds anything unexpected on the current instance.

## Prerequisites

- AWS credentials for the Lightsail account (default profile, `us-east-1`), with rights to create
  instances, allocate/attach a static IP, and set firewall port state.
- `wireguard-tools` locally if generating a fresh home keypair (`brew install wireguard-tools`), or
  the existing home private key if reusing it.
- `pnpm --filter @postroom/edge bundle` must succeed (the script runs it for you).
- The home side's WireGuard sidecar (`docker/wireguard`, the `wireguard` service in
  `docs/install/compose.host.yml`) — its env (`WG_PRIVATE_KEY`, `WG_EDGE_PUBLIC_KEY`,
  `WG_EDGE_ENDPOINT`, `WG_ADDRESS`) is what needs updating after the rebuild.

## Steps

1. From the repo root, build the new edge (uses the default AWS profile and `us-east-1`; a fresh
   home WireGuard keypair is generated into `edge/.secrets/` unless you pass one):

   ```sh
   edge/provision.sh
   # or, keeping the existing home keypair:
   HOME_WG_PUBLIC_KEY=<existing pubkey> edge/provision.sh
   ```

   This bundles `apps/edge` into `apps/edge/dist/edge.mjs`, gzips + base64s it into the rendered
   `cloud-init.yaml` (with its own admin CIDR, home WireGuard public key, and a SHA-256 the instance
   verifies against on first boot before running it), creates a new Lightsail instance
   (`nano_3_0`, `debian_13`), moves the existing static IP onto it (the previous instance is left
   running — rebuilding never destroys the old one by itself), and opens 22 (admin CIDR only) and
   51820/udp (WireGuard, world). Mail ports (25/465/587/993/4190) stay **closed** until you open
   them explicitly (step 4) — closed until go-live is PST-REQ-086.
2. The script waits for `cloud-init` to finish and prints:
   - the new edge's WireGuard public key,
   - the exact `.env` lines to set on the Zima's `wireguard` sidecar (`WG_PRIVATE_KEY`,
     `WG_EDGE_PUBLIC_KEY`, `WG_EDGE_ENDPOINT`, `WG_ADDRESS`, `EDGE_PEER_ADDRESS`),
   - the previous instance's name, to delete once confirmed.
3. Set those `.env` lines on the Zima (`/DATA/postroom/postroom.env`) and redeploy the `wireguard`
   service **through Shipyard** (see [`deploy.md`](deploy.md)), never by SSH-editing the compose
   file. The sidecar's `entrypoint.sh` brings up `wg0` against the new endpoint on next start;
   `health.sh` reports healthy once a handshake lands within the last 3 minutes.
4. Open the mail ports on the new instance once the WireGuard tunnel is confirmed:

   ```sh
   edge/ports.sh open all
   edge/ports.sh show
   ```

5. Delete the previous Lightsail instance once the new one is carrying live traffic (the script
   prints its name; it is not deleted automatically).

## Verification

- `edge/inventory.sh <new-ip>` exits 0 and prints only the WireGuard key and the SSH host keys —
  anything else (another private key, a mail spool, `.aws`/`.netrc` credentials) fails it.
- On the Zima: `docker compose exec wireguard wg show wg0 latest-handshakes` shows a recent
  handshake, and `docker/wireguard/health.sh`'s own check (the container's `HEALTHCHECK`) reports
  healthy.
- `edge/ports.sh show` lists all five mail ports open.
- `mail.d3cloud.io`'s `/health` (via the tunnel, unaffected by the edge) still answers `ok`, and an
  actual SMTP connection to the new edge IP on 25/465/587/993/4190 reaches home (a test message
  submitted and delivered end to end is the strongest check).

## Rollback / abort

- The previous instance is left running by design: if the new one fails cloud-init or the
  WireGuard handshake never comes up, reattach the static IP to the previous instance:

  ```sh
  aws lightsail --region us-east-1 detach-static-ip --static-ip-name postroom-edge-ip
  aws lightsail --region us-east-1 attach-static-ip --static-ip-name postroom-edge-ip \
    --instance-name <previous-instance-name>
  ```

- Revert the Zima's `wireguard` sidecar `.env` to the previous edge's public key/endpoint and
  redeploy through Shipyard.
- Only delete the previous instance after the new one is confirmed serving live mail.

## Execution record

| Field | Value |
|---|---|
| Last executed | not yet executed |
| By | — |
| Result | — |
| Precondition needed | operator AWS Lightsail access (`us-east-1`) and the current home WireGuard keypair or willingness to rotate it |

## Relates to

PST-REQ-163 · PST-REQ-013 · PST-REQ-017 · PST-REQ-086 · PST-ADR-002 · PST-T-13.2

See also: [`docs/runbooks/README.md`](README.md) · [`docs/runbooks/deploy.md`](deploy.md) (redeploying the `wireguard` sidecar's env) · [`docs/runbooks/aws-port25.md`](aws-port25.md) (this same edge is where AWS's port-25 block applies).
