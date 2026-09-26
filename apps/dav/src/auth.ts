// HTTP Basic authentication for DAV (PST-REQ-027, PST-REQ-075).
//
//   - App passwords only, scope `dav`: verifyProtocolLogin never looks at the account password, so
//     there is no path by which it could be accepted.
//   - Every credential check goes through the shared, audit-backed throttle; the tarpit runs before
//     the credentials are looked at, and every failure is an audit row.
//   - HTTP sends the credentials with every request, and iOS makes dozens per sync. Verifying each
//     with Argon2id would be a denial of service against ourselves, so a *successful* verification
//     is remembered for a few minutes under an HMAC of (username, password) with a per-process key.
//     A remembered login is still re-checked against the database on every request (one indexed
//     read: not revoked, still scoped to dav, account not disabled), so a revocation applies to the
//     very next request exactly as it does for IMAP. Failures are never remembered. A remembered
//     login skips the tarpit: the throttle exists to slow guessing, and only the exact, already
//     verified password can hit the cache — a refused source still cannot verify anything new.
import { createHmac, randomBytes } from 'node:crypto';
import type { AuthThrottle } from '@postroom/auth-throttle';
import { verifyProtocolLogin } from '@postroom/credentials';
import type { Db } from '@postroom/db';

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/**
 * The credentials of an `Authorization: Basic` header (RFC 7617), or null when there is no Basic
 * header. `malformed` when there is one but it does not decode to `user:password` in UTF-8.
 */
export function parseBasicAuth(header: string | undefined): Credentials | 'malformed' | null {
  if (header === undefined) return null;
  const m = /^Basic[ \t]+([A-Za-z0-9+/]+={0,2})[ \t]*$/i.exec(header);
  if (m?.[1] === undefined) return /^Basic\b/i.test(header) ? 'malformed' : null;
  const raw = Buffer.from(m[1], 'base64');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return 'malformed';
  }
  const colon = text.indexOf(':');
  if (colon < 0) return 'malformed';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'malformed';
  return { username: text.slice(0, colon), password: text.slice(colon + 1) };
}

export type AuthOutcome =
  | { readonly ok: true; readonly accountId: string; readonly appPasswordId: string }
  | { readonly ok: false; readonly kind: 'failed' | 'locked' | 'unavailable' | 'aborted' };

export interface DavAuthenticatorOptions {
  readonly db: Db;
  /** PASSWORD_PEPPER; without it every login is refused as unavailable. */
  readonly pepper: string | undefined;
  readonly throttle: AuthThrottle;
  readonly cacheMs: number;
  readonly maxCached?: number;
  readonly now?: () => number;
}

export type DavAuthenticator = (credentials: Credentials | 'malformed', ip: string, signal?: AbortSignal) => Promise<AuthOutcome>;

interface Remembered {
  readonly accountId: string;
  readonly appPasswordId: string;
  readonly until: number;
}

export function createDavAuthenticator(o: DavAuthenticatorOptions): DavAuthenticator & { forget(): void } {
  const key = randomBytes(32);
  const now = o.now ?? Date.now;
  const maxCached = o.maxCached ?? 1000;
  const cache = new Map<string, Remembered>();
  const cacheKey = (c: Credentials): string => createHmac('sha256', key).update(c.username.toLowerCase()).update('\u0000').update(c.password).digest('base64');

  const stillLive = async (r: Remembered): Promise<boolean> => {
    const row = await o.db.appPassword.findFirst({
      where: { id: r.appPasswordId, accountId: r.accountId, revokedAt: null, scopes: { has: 'dav' }, account: { disabledAt: null } },
      select: { id: true },
    });
    return row !== null;
  };

  const authenticate = async (credentials: Credentials | 'malformed', ip: string, signal?: AbortSignal): Promise<AuthOutcome> => {
    if (credentials !== 'malformed' && o.cacheMs > 0) {
      const k = cacheKey(credentials);
      const hit = cache.get(k);
      if (hit !== undefined) {
        if (hit.until > now() && (await stillLive(hit))) return { ok: true, accountId: hit.accountId, appPasswordId: hit.appPasswordId };
        cache.delete(k);
      }
    }
    const attempt = { protocol: 'dav', username: credentials === 'malformed' ? '' : credentials.username, ip };
    // The tarpit runs before the credentials are looked at (PST-REQ-075).
    const gate = await o.throttle.before(attempt, signal);
    if (gate.outcome === 'aborted') return { ok: false, kind: 'aborted' };
    if (gate.outcome === 'refuse') return { ok: false, kind: 'locked' };
    if (credentials === 'malformed' || credentials.username === '' || credentials.password === '') {
      await o.throttle.failure(attempt, 'malformed');
      return { ok: false, kind: 'failed' };
    }
    if (o.pepper === undefined) return { ok: false, kind: 'unavailable' };
    const result = await verifyProtocolLogin(o.db, { username: credentials.username, password: credentials.password, scope: 'dav', ip }, { pepper: o.pepper });
    if (!result.ok) {
      await o.throttle.failure(attempt, result.reason);
      return { ok: false, kind: 'failed' };
    }
    await o.throttle.success(attempt);
    if (o.cacheMs > 0) {
      if (cache.size >= maxCached) {
        const oldest = cache.keys().next();
        if (oldest.done !== true) cache.delete(oldest.value);
      }
      cache.set(cacheKey(credentials), { accountId: result.accountId, appPasswordId: result.appPasswordId, until: now() + o.cacheMs });
    }
    return { ok: true, accountId: result.accountId, appPasswordId: result.appPasswordId };
  };
  return Object.assign(authenticate, {
    forget: () => {
      cache.clear();
    },
  });
}
