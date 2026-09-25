// Who may run first-run setup. Until an operator exists, /setup would otherwise be claimable by
// anyone who reaches the public hostname first (the exposure Shipyard had).
//
//   SETUP_TOKEN set   → the request body's `setupToken` must match it (constant-time).
//   SETUP_TOKEN unset → only loopback and private client addresses may set up, so a dev or CI stack
//                       works without a token and a public deploy that forgot one fails closed.
//
// req.ip honours `trust proxy` (one hop: cloudflared), so behind the tunnel it is the real client.
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { timingSafeEqualStr } from '@postroom/crypto';

const PRIVATE = new BlockList();
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

/** True for loopback or private (RFC 1918, ULA) addresses, including IPv4-mapped IPv6. */
export function isPrivateAddress(ip: string | undefined): boolean {
  if (ip === undefined || ip === '') return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  const addr = mapped?.[1] ?? ip;
  if (isIPv4(addr)) return PRIVATE.check(addr, 'ipv4');
  if (isIPv6(addr)) return PRIVATE.check(addr, 'ipv6');
  return false;
}

export type SetupGateResult = { ok: true } | { ok: false; reason: 'token_missing' | 'token_mismatch' | 'address_not_private' };

export function checkSetupGate(setupToken: string | null, presented: unknown, ip: string | undefined): SetupGateResult {
  if (setupToken !== null) {
    if (typeof presented !== 'string' || presented === '') return { ok: false, reason: 'token_missing' };
    return timingSafeEqualStr(presented, setupToken) ? { ok: true } : { ok: false, reason: 'token_mismatch' };
  }
  return isPrivateAddress(ip) ? { ok: true } : { ok: false, reason: 'address_not_private' };
}
