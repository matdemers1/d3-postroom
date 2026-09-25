// Greylisting (PST-REQ-062): a first-contact triplet (client /24 or /64, envelope sender, recipient)
// that has no SPF pass and whose client IP lacks FCrDNS (or is soft-listed) is deferred with 451 for
// five minutes. A legitimate sender's queue retries; a triplet that comes back after the delay, inside
// the retry window, passes and stays known for a long time. One that never retries expires.
//
// Only SPF is known at RCPT time — DKIM is verified from the DATA stream, which has not arrived yet.
// That is acceptable here: a real MTA that legitimately authenticates only via DKIM still retries a
// 451 exactly like one that authenticates via SPF, so the triplet passes on the retry either way. The
// alternative (deferring the RCPT decision until after DATA) would mean accepting the whole message
// before greylisting it, which defeats the point of a cheap early SMTP-level control.
//
// `spfResult` and `fcrdns` are optional so that server.ts's current call (which does not compute
// either yet) keeps passing every message through unchanged: when both are omitted, evaluate() treats
// the caller as not having determined them and skips greylisting rather than deferring blind. See the
// task's needsOutside for the one-line change to server.ts that supplies real values.
import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { Db } from '@postroom/db';
import { canonicalIp } from './rdns.js';

export interface GreylistInput {
  /** The real client IP (after PROXY v2). */
  readonly clientIp: string;
  /** MAIL FROM, or null for `<>`. */
  readonly mailFrom: string | null;
  /** The normalised recipient address that was accepted. */
  readonly recipient: string;
  /** SPF result at MAIL FROM/RCPT time. DKIM is not available yet — see the file header. */
  readonly spfResult?: string;
  /** Forward-confirmed reverse DNS for the client IP (see rdns.ts): PTR confirmed by a forward lookup. */
  readonly fcrdns?: boolean;
  /** The client IP (or its network) is on the soft list (GREYLIST_SOFT_LIST) and never skips on FCrDNS alone. */
  readonly softListed?: boolean;
}

/** 'defer' makes smtp-in answer the RCPT with 451 4.7.1. */
export type GreylistVerdict = 'pass' | 'defer';

export interface GreylistOutcome {
  readonly verdict: GreylistVerdict;
  /** Decisions store their reasons. */
  readonly reason: string;
}

export interface GreylistPolicyOptions {
  /** How long a first-contact triplet must wait before a retry is accepted. Default 5 minutes. */
  readonly delayMs?: number;
  /** How long a triplet may take to retry before it is treated as a fresh first contact. Default 24 hours. */
  readonly retryWindowMs?: number;
  /** How long a triplet that has passed stays known, extended on every further pass. Default 36 days. */
  readonly passTtlMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_DELAY_MS = 5 * 60_000;
const DEFAULT_RETRY_WINDOW_MS = 24 * 60 * 60_000;
const DEFAULT_PASS_TTL_MS = 36 * 24 * 60 * 60_000;

function resolvedPolicy(policy: GreylistPolicyOptions): { delayMs: number; retryWindowMs: number; passTtlMs: number; now: Date } {
  return {
    delayMs: policy.delayMs ?? DEFAULT_DELAY_MS,
    retryWindowMs: policy.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS,
    passTtlMs: policy.passTtlMs ?? DEFAULT_PASS_TTL_MS,
    now: (policy.now ?? (() => new Date()))(),
  };
}

function ipv4Bytes(ip: string): Buffer {
  const parts = ip.split('.');
  return Buffer.from([Number(parts[0] ?? 0), Number(parts[1] ?? 0), Number(parts[2] ?? 0), Number(parts[3] ?? 0)]);
}

/** Full 16-byte form of an IPv6 address, expanding `::` as needed. */
function ipv6Bytes(ip: string): Buffer {
  const bare = ip.split('%')[0] ?? ip;
  const sides = bare.split('::');
  const head = sides[0] === undefined || sides[0] === '' ? [] : sides[0].split(':');
  const tail = sides[1] === undefined || sides[1] === '' ? [] : sides[1].split(':');
  const missing = Math.max(8 - head.length - tail.length, 0);
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(parseInt(groups[i] ?? '0', 16) || 0, i * 2);
  }
  return buf;
}

function ipBytes(ip: string): Buffer | null {
  if (isIPv4(ip)) return ipv4Bytes(ip);
  if (isIPv6(ip)) return ipv6Bytes(ip);
  return null;
}

/** The client IP's network for the triplet key: IPv4 /24, IPv6 /64. */
function networkOf(ip: string): string {
  const addr = canonicalIp(ip);
  if (isIPv4(addr)) {
    const bytes = ipv4Bytes(addr);
    return `${String(bytes[0])}.${String(bytes[1])}.${String(bytes[2])}.0/24`;
  }
  if (isIPv6(addr)) {
    const bytes = ipv6Bytes(addr);
    const network = Buffer.concat([bytes.subarray(0, 8), Buffer.alloc(8)]);
    const groups: string[] = [];
    for (let i = 0; i < 8; i++) groups.push(network.readUInt16BE(i * 2).toString(16));
    return `${groups.join(':')}/64`;
  }
  return addr;
}

/** sha256 of the network, lowercased sender (`<>` for null) and lowercased recipient. */
export function greylistKey(clientIp: string, mailFrom: string | null, recipient: string): string {
  const network = networkOf(clientIp);
  const sender = (mailFrom ?? '<>').toLowerCase();
  const rcpt = recipient.toLowerCase();
  return createHash('sha256').update(`${network}|${sender}|${rcpt}`).digest('hex');
}

function parseCidr(cidr: string): { bytes: Buffer; prefix: number } | null {
  const [addr, prefixText] = cidr.split('/');
  if (addr === undefined || addr === '') return null;
  const bytes = ipBytes(addr);
  if (bytes === null) return null;
  const prefix = prefixText === undefined ? bytes.length * 8 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bytes.length * 8) return null;
  return { bytes, prefix };
}

function matchesCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  if (parsed === null) return false;
  const target = ipBytes(canonicalIp(ip));
  if (target === null || target.length !== parsed.bytes.length) return false;
  const fullBytes = Math.floor(parsed.prefix / 8);
  const remainderBits = parsed.prefix % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (target[i] !== parsed.bytes[i]) return false;
  }
  if (remainderBits > 0) {
    const mask = (0xff << (8 - remainderBits)) & 0xff;
    if (((target[fullBytes] ?? 0) & mask) !== ((parsed.bytes[fullBytes] ?? 0) & mask)) return false;
  }
  return true;
}

/** Soft list from `GREYLIST_SOFT_LIST` (comma-separated CIDRs): never skip greylisting on FCrDNS alone. */
export function isSoftListed(ip: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['GREYLIST_SOFT_LIST'] ?? '';
  const cidrs = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return cidrs.some((cidr) => matchesCidr(ip, cidr));
}

async function evaluate(db: Db | null, input: GreylistInput, policyOptions: GreylistPolicyOptions): Promise<GreylistOutcome> {
  if (input.spfResult === 'pass') return { verdict: 'pass', reason: 'spf-pass' };
  // Neither signal was determined by the caller (the smtp-in call site does not compute them yet —
  // see the greylist.ts header / needsOutside): pass rather than greylist blind. Once server.ts is
  // wired to pass a real SPF result and FCrDNS boolean, this branch never triggers in production.
  if (input.spfResult === undefined && input.fcrdns === undefined) return { verdict: 'pass', reason: 'unwired' };
  if (input.fcrdns === true && input.softListed !== true) return { verdict: 'pass', reason: 'fcrdns' };
  if (db === null) return { verdict: 'pass', reason: 'no-db' };

  const policy = resolvedPolicy(policyOptions);
  const key = greylistKey(input.clientIp, input.mailFrom, input.recipient);
  const existing = await db.greylistEntry.findUnique({ where: { key } });

  if (existing === null) {
    await db.greylistEntry.create({
      data: { key, firstSeen: policy.now, expiresAt: new Date(policy.now.getTime() + policy.retryWindowMs) },
    });
    return { verdict: 'defer', reason: 'first-contact' };
  }

  if (existing.passedAt !== null) {
    if (policy.now < existing.expiresAt) {
      await db.greylistEntry.update({
        where: { key },
        data: { expiresAt: new Date(policy.now.getTime() + policy.passTtlMs) },
      });
      return { verdict: 'pass', reason: 'known-pass' };
    }
    // The known-good period lapsed with no traffic: treat as a fresh first contact.
    await db.greylistEntry.update({
      where: { key },
      data: { firstSeen: policy.now, passedAt: null, expiresAt: new Date(policy.now.getTime() + policy.retryWindowMs) },
    });
    return { verdict: 'defer', reason: 'pass-expired' };
  }

  const readyAt = new Date(existing.firstSeen.getTime() + policy.delayMs);
  if (policy.now < readyAt) return { verdict: 'defer', reason: 'too-soon' };

  if (policy.now <= existing.expiresAt) {
    await db.greylistEntry.update({
      where: { key },
      data: { passedAt: policy.now, expiresAt: new Date(policy.now.getTime() + policy.passTtlMs) },
    });
    return { verdict: 'pass', reason: 'retry-ok' };
  }

  // The retry window expired before a retry ever came: start over.
  await db.greylistEntry.update({
    where: { key },
    data: { firstSeen: policy.now, expiresAt: new Date(policy.now.getTime() + policy.retryWindowMs) },
  });
  return { verdict: 'defer', reason: 'retry-expired' };
}

/** The verdict and the reason it was reached, for logs (decisions store their reasons). */
export function checkGreylistDetailed(
  db: Db | null,
  input: GreylistInput,
  policy: GreylistPolicyOptions = {},
): Promise<GreylistOutcome> {
  return evaluate(db, input, policy);
}

export async function checkGreylist(db: Db | null, input: GreylistInput, policy: GreylistPolicyOptions = {}): Promise<GreylistVerdict> {
  return (await evaluate(db, input, policy)).verdict;
}

/** Delete expired entries. Called by the periodic worker, not by the SMTP path. */
export async function pruneGreylist(db: Db, now: Date = new Date()): Promise<number> {
  const result = await db.greylistEntry.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}
