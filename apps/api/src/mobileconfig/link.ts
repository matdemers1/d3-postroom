// The one-time profile link (PST-T-16.16, PST-DA-039): the URL an iPhone's camera opens to install
// the .mobileconfig, without a session — Safari on the phone has none.
//
// Why a signed token and not a table: no schema change was allowed for this task, and the token has
// to be checkable by a request that carries nothing else. So it is stateless to validate —
//
//   token = base64url( version ‖ accountId (16) ‖ expiresAt ms (8) ‖ nonce (16) ‖ HMAC-SHA256 (32) )
//
// — with the MAC keyed by a key derived from SESSION_SECRET (domain-separated, so a session
// signature can never be passed off as a link or the reverse). The 128-bit random nonce is what
// makes the link unguessable; the MAC is what makes it unforgeable and binds it to one account and
// one expiry. "Spent" is the only state, and it lives in audit_event (see index.ts): the redeem
// writes a `mobileconfig.link.redeem` row whose entity id is `linkId` — the SHA-256 of the nonce,
// never the nonce or the token — under an advisory lock on that id, so two racing redeems cannot
// both find "not spent yet".
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a link is good for. Long enough to find the phone, short enough to be worthless later. */
export const LINK_TTL_MS = 10 * 60 * 1000;

const VERSION = 1;
const UUID_BYTES = 16;
const EXPIRY_BYTES = 8;
const NONCE_BYTES = 16;
const MAC_BYTES = 32;
const PAYLOAD_BYTES = 1 + UUID_BYTES + EXPIRY_BYTES + NONCE_BYTES;
const TOKEN_BYTES = PAYLOAD_BYTES + MAC_BYTES;
/** base64url of TOKEN_BYTES, no padding. Anything else is refused before any crypto runs. */
const TOKEN_RE = /^[A-Za-z0-9_-]{98}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The shape of a linkId: lower-case hex SHA-256. */
export const LINK_ID_RE = /^[0-9a-f]{64}$/;

export interface MintedLink {
  /** Goes in the URL, and nowhere else: never logged, never audited, never stored. */
  token: string;
  /** SHA-256 of the nonce, hex: safe to store, audit and hand back to the browser for polling. */
  linkId: string;
  expiresAt: Date;
}

export interface ReadLink {
  accountId: string;
  linkId: string;
  expiresAt: Date;
}

/** The MAC key for links, derived from the session secret so neither key can stand in for the other. */
export function linkKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update('postroom/mobileconfig-link/v1').digest();
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function linkIdOf(nonce: Buffer): string {
  return createHash('sha256').update(nonce).digest('hex');
}

/** A fresh link for `accountId`, good until `now + ttlMs`. `nonce` is injectable for tests only. */
export function mintLinkToken(key: Buffer, accountId: string, now: Date, ttlMs: number = LINK_TTL_MS, nonce: Buffer = randomBytes(NONCE_BYTES)): MintedLink {
  if (!UUID_RE.test(accountId)) throw new Error('mintLinkToken: accountId is not a UUID');
  if (nonce.length !== NONCE_BYTES) throw new Error('mintLinkToken: nonce must be 16 bytes');
  const expiresAt = new Date(now.getTime() + ttlMs);
  const payload = Buffer.alloc(PAYLOAD_BYTES);
  payload.writeUInt8(VERSION, 0);
  uuidToBytes(accountId).copy(payload, 1);
  payload.writeBigUInt64BE(BigInt(expiresAt.getTime()), 1 + UUID_BYTES);
  nonce.copy(payload, 1 + UUID_BYTES + EXPIRY_BYTES);
  const mac = createHmac('sha256', key).update(payload).digest();
  return { token: Buffer.concat([payload, mac]).toString('base64url'), linkId: linkIdOf(nonce), expiresAt };
}

/**
 * The link a token names, or null when it is malformed, forged, for another key, or expired. One
 * answer for all of them on purpose: the caller must not be able to tell which (and must not say).
 */
export function readLinkToken(key: Buffer, token: string, now: Date): ReadLink | null {
  if (!TOKEN_RE.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== TOKEN_BYTES) return null;
  const payload = raw.subarray(0, PAYLOAD_BYTES);
  const mac = raw.subarray(PAYLOAD_BYTES);
  const expected = createHmac('sha256', key).update(payload).digest();
  if (!timingSafeEqual(mac, expected)) return null;
  if (payload.readUInt8(0) !== VERSION) return null;
  const expiresMs = Number(payload.readBigUInt64BE(1 + UUID_BYTES));
  if (!(now.getTime() < expiresMs)) return null;
  const nonce = payload.subarray(1 + UUID_BYTES + EXPIRY_BYTES);
  return {
    accountId: bytesToUuid(payload.subarray(1, 1 + UUID_BYTES)),
    linkId: linkIdOf(Buffer.from(nonce)),
    expiresAt: new Date(expiresMs),
  };
}

/**
 * A fixed-window counter per key, in memory: enough to stop one account minting links in a loop or
 * one address hammering the redeem path. Forgets its oldest key past `limit` keys.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly limit = 10_000,
  ) {}

  /** True when `key` has already used its allowance in the current window. */
  blocked(key: string, now: number): boolean {
    const entry = this.hits.get(key);
    return entry !== undefined && entry.resetAt > now && entry.count >= this.max;
  }

  hit(key: string, now: number): void {
    const entry = this.hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      if (entry === undefined && this.hits.size >= this.limit) {
        const oldest = this.hits.keys().next();
        if (oldest.done !== true) this.hits.delete(oldest.value);
      }
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }
    entry.count += 1;
  }
}
