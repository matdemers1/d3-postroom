// D3 Auth access tokens as Bearer credentials (PST-T-19.3, the D3 App contract).
//
// D3 Constellation signs a person in to D3 Auth once and asks it for an access token whose audience
// is this Postroom (RFC 8707). That token is a JWT signed by the provider: it is checked against the
// provider's published keys, for the configured issuer, for this origin as audience and for time
// (a minute of leeway, as the contract allows) — then mapped to an account by the (iss, sub) link
// and nothing else, never by email (PST-REQ-005). An unlinked identity is refused; the app runs
// POST /api/auth/native/link once, which proves the local account with its own credentials.
//
// A verified token becomes a session row keyed by the token's hash, expiring with the token, so
// every route, the event stream and step-up treat it exactly as any other session. Those rows are
// governed by D3 Auth — revoking the device there is what ends them — so the sessions screens list
// only the native sessions this server issued itself.
import { ALLOWED_ALGORITHMS } from '@d3cloudio/auth-client';
import { recordAudit, type getAuditContext } from '@postroom/audit';
import type { Db } from '@postroom/db';
import type { Request } from 'express';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthRuntime } from './runtime.js';
import { hashToken } from './sessions.js';

/** The contract's ceiling on clock leeway: more would widen every replay window. */
export const LEEWAY_SECONDS = 60;

export interface VerifiedToken {
  issuer: string;
  subject: string;
  roles: string[];
  email: string | null;
  expiresAt: Date;
}

type KeysFor = (issuer: string) => JWTVerifyGetKey;
const resolvers = new Map<string, JWTVerifyGetKey>();
// jose's remote key set caches the keys and refetches, rate-limited, on a key id it has not seen.
const remoteKeys: KeysFor = (issuer) => {
  const known = resolvers.get(issuer);
  if (known !== undefined) return known;
  // Where D3 Auth publishes its keys — the same path the SDK reads for logout tokens.
  const made = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/oidc/jwks`));
  resolvers.set(issuer, made);
  return made;
};
let keysFor: KeysFor = remoteKeys;

/** Tests answer with a local key set; null restores the provider's. */
export function setKeysForTesting(fn: KeysFor | null): void {
  keysFor = fn ?? remoteKeys;
}

/** A JWT with one of the provider's algorithms. Postroom's own tokens are opaque and never are. */
export function looksLikeProviderToken(token: string): boolean {
  if (token.split('.').length !== 3) return false;
  try {
    const { alg } = decodeProtectedHeader(token);
    return (ALLOWED_ALGORITHMS as readonly string[]).includes(alg ?? '');
  } catch {
    return false;
  }
}

/** The audience this Postroom answers to: its own origin, as the manifest names it. */
export const resourceOf = (webOrigin: string): string => new URL(webOrigin).origin;

/** A D3 Auth token for this Postroom, checked completely; null for anything else. */
export async function verifyD3AuthToken(rt: AuthRuntime, token: string, resource: string): Promise<VerifiedToken | null> {
  if (!looksLikeProviderToken(token)) return null;
  await rt.oidc.ready();
  const issuer = rt.oidc.settings?.issuer;
  if (issuer === undefined) return null;
  try {
    const { payload } = await jwtVerify(token, keysFor(issuer), {
      issuer,
      audience: resource,
      algorithms: [...ALLOWED_ALGORITHMS],
      clockTolerance: LEEWAY_SECONDS,
      currentDate: rt.now(),
      requiredClaims: ['exp', 'iss', 'aud', 'sub'],
    });
    const roles = Array.isArray(payload['roles']) ? payload['roles'].filter((r): r is string => typeof r === 'string') : [];
    const email = typeof payload['email'] === 'string' ? payload['email'] : null;
    return { issuer, subject: String(payload.sub), roles, email, expiresAt: new Date((payload.exp ?? 0) * 1000) };
  } catch {
    return null;
  }
}

export type Materialized = 'session' | 'unlinked' | 'invalid';

/**
 * Turn a verified, linked D3 Auth token into a session row (hash of the token, expiring with it),
 * once. A second request with the same token finds the row and never verifies again.
 */
export async function materializeD3AuthSession(
  rt: AuthRuntime,
  token: string,
  resource: string,
  req: Request,
  context: ReturnType<typeof getAuditContext>,
): Promise<Materialized> {
  const verified = await verifyD3AuthToken(rt, token, resource);
  if (verified === null) return 'invalid';
  const db: Db = rt.db;
  const link = await db.identityLink.findUnique({
    where: { issuer_subject: { issuer: verified.issuer, subject: verified.subject } },
    include: { account: { select: { disabledAt: true } } },
  });
  if (link === null) return 'unlinked';
  if (link.account.disabledAt !== null) return 'invalid';
  const now = rt.now();
  try {
    await db.$transaction(async (tx) => {
      // Last token's row, long expired: tidied here rather than by a sweeper (they have no refresh).
      await tx.session.deleteMany({ where: { accountId: link.accountId, native: true, method: 'oidc', expiresAt: { lt: now }, refreshes: { none: {} } } });
      const row = await tx.session.create({
        data: {
          idHash: hashToken(token),
          accountId: link.accountId,
          createdAt: now,
          expiresAt: verified.expiresAt,
          ip: req.ip ?? null,
          userAgent: (req.get('user-agent') ?? '').slice(0, 512) || null,
          method: 'oidc',
          roles: verified.roles,
          oidcIssuer: verified.issuer,
          oidcSubject: verified.subject,
          secondFactor: null,
          native: true,
        },
      });
      await tx.identityLink.update({ where: { id: link.id }, data: { lastUsedAt: now } });
      await recordAudit(tx, {
        actor: { kind: 'account', accountId: link.accountId },
        action: 'auth.signin',
        entityType: 'session',
        entityId: row.id,
        after: { method: 'oidc', via: 'd3auth-bearer', issuer: verified.issuer, subject: verified.subject, roles: verified.roles },
        context,
      });
    });
  } catch (error) {
    // Two requests carrying a new token at once: one row wins, and both are served by it.
    if ((error as { code?: string }).code !== 'P2002') throw error;
  }
  return 'session';
}
