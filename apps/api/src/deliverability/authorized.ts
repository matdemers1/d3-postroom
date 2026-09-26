// "Authorized source" for DMARC progression proposals (PST-T-7.2, PST-REQ-123): the one place that
// says which sending IPs are ours, so a clean-streak check and anything that reads it later agree.
//
// Ours is exactly:
//   - our edge, `EDGE_PUBLIC_IP` (PST-ADR-002) — the single public IP Postroom's outbound SMTP and
//     the WireGuard edge egress from; and
//   - the SES fallback transport's ranges, `SES_IP_RANGES` (CIDRs, comma-separated), but only when
//     SES is configured (`SES_SMTP_USER` set) — an unconfigured SES has no source to authorize, so
//     its ranges (if left in the env from a prior setup) are ignored.
//
// This does not read SPF or DNS: `EDGE_PUBLIC_IP` and `SES_IP_RANGES` are expected to already match
// what the domain's SPF record authorizes (PST-REQ-123 evidence says so), because Postroom does not
// publish DNS on the operator's behalf (Postroom-CLAUDE.md: nothing here edits DNS).
import { isIP } from 'node:net';

export interface AuthorizedSources {
  readonly edge: string | null;
  readonly sesConfigured: boolean;
  readonly sesRanges: readonly string[];
}

function parseCidrList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Reads the env once into the three inputs `isAuthorizedSource` needs. */
export function authorizedSources(env: NodeJS.ProcessEnv): AuthorizedSources {
  const edgeRaw = env['EDGE_PUBLIC_IP']?.trim() ?? '';
  const edge = edgeRaw !== '' && isIP(edgeRaw) !== 0 ? edgeRaw.toLowerCase() : null;
  const sesConfigured = (env['SES_SMTP_USER'] ?? '').trim() !== '';
  const sesRanges = sesConfigured ? parseCidrList(env['SES_IP_RANGES']) : [];
  return { edge, sesConfigured, sesRanges };
}

function ipToBits(ip: string): { bits: bigint; bitLength: 32 | 128 } | null {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
    return { bits: parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n), bitLength: 32 };
  }
  if (family === 6) {
    // node:net accepted it, so this expansion (via URL's normalizer) is safe.
    let full: string;
    try {
      full = new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, '');
    } catch {
      return null;
    }
    // Expand :: and map IPv4-in-IPv6 tails; simplest correct approach: use Node's normalized form
    // by round-tripping through a 128-bit accumulation of the 8 hextets `net` itself produced.
    const groups = expandIpv6(full);
    if (groups === null) return null;
    return { bits: groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n), bitLength: 128 };
  }
  return null;
}

/** Expands a valid IPv6 literal (already confirmed by `isIP`) to its 8 16-bit groups. */
function expandIpv6(addr: string): number[] | null {
  const [head, tail] = addr.split('::');
  const parseGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const parts = s.split(':');
    const out: number[] = [];
    for (const p of parts) {
      if (p.includes('.')) {
        // A trailing IPv4-mapped tail, e.g. "::ffff:192.0.2.1".
        const octets = p.split('.').map(Number);
        if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return null;
        const [o0, o1, o2, o3] = octets as [number, number, number, number];
        out.push((o0 << 8) | o1, (o2 << 8) | o3);
        continue;
      }
      const n = parseInt(p, 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
      out.push(n);
    }
    return out;
  };
  const headGroups = parseGroups(head ?? '');
  if (headGroups === null) return null;
  if (tail === undefined) return headGroups.length === 8 ? headGroups : null;
  const tailGroups = parseGroups(tail);
  if (tailGroups === null) return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  return [...headGroups, ...new Array<number>(missing).fill(0), ...tailGroups];
}

function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.lastIndexOf('/');
  const addr = slash === -1 ? cidr : cidr.slice(0, slash);
  const prefix = slash === -1 ? (isIP(addr) === 4 ? 32 : 128) : Number(cidr.slice(slash + 1));
  const target = ipToBits(ip);
  const base = ipToBits(addr);
  if (target === null || base === null || target.bitLength !== base.bitLength) return false;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > target.bitLength) return false;
  if (prefix === 0) return true;
  const shift = BigInt(target.bitLength - prefix);
  return (target.bits >> shift) === (base.bits >> shift);
}

/** Is `sourceIp` one of ours, per `authorizedSources(env)`? */
export function isAuthorizedSource(sourceIp: string, env: NodeJS.ProcessEnv): boolean {
  const { edge, sesRanges } = authorizedSources(env);
  const ip = sourceIp.trim().toLowerCase();
  if (edge !== null && ip === edge) return true;
  return sesRanges.some((cidr) => ipInCidr(ip, cidr));
}
