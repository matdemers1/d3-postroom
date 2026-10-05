// Web sessions. The cookie holds a random 32-byte token; the database holds only its SHA-256, so a
// leaked row is not a usable cookie. Sessions live in a table rather than a sealed cookie because
// revoking one has to take effect now.
import { createHash, randomBytes } from 'node:crypto';
import type { Db, Prisma } from '@postroom/db';
import type { Request, Response } from 'express';

export const SESSION_COOKIE = 'postroom_session';
/**
 * The name on a secure origin. `__Host-` makes the browser insist on Secure, Path=/ and no Domain,
 * so no sibling subdomain can set or shadow it (ASVS 5.0 3.3.1, 3.3.3). A plain-http loopback
 * origin cannot use the prefix at all — the browser would drop the cookie — so dev and e2e keep
 * the bare name.
 */
export const SECURE_SESSION_COOKIE = '__Host-postroom_session';

export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}
/** Idle: a session unused for this long ends. */
export const IDLE_MS = 12 * 60 * 60 * 1000;
/** Absolute: however busy, a session ends this long after sign-in. */
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** Slide the idle expiry at most this often, so an active tab does not write on every request. */
const SLIDE_EVERY_MS = 60 * 1000;

export type SignInMethod = 'password' | 'oidc';

/**
 * How a password session's second factor was satisfied (PST-REQ-200). A recovery code stands in for
 * a lost authenticator, so a session it signed in has to enrol a new TOTP secret before anything
 * that needs a fresh second factor; completing that re-enrolment marks it 'totp'.
 */
export type SecondFactor = 'totp' | 'recovery_code';

/**
 * What a session knows beyond who it belongs to: how it signed in and, for D3 Auth, the (iss, sub)
 * it signed in as and the roles claim at sign-in. Stored on the session row itself.
 */
export interface SessionMeta {
  method: SignInMethod;
  roles: string[];
  iss?: string;
  sub?: string;
  /** Password sessions only: TOTP or a recovery code. Absent for D3 Auth. */
  secondFactor?: SecondFactor;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Secure everywhere except a plain-http loopback origin, where a browser would refuse it. */
export function isSecureOrigin(webOrigin: string): boolean {
  const url = new URL(webOrigin);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return !(url.protocol === 'http:' && loopback);
}

export interface IssuedSession {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function issueSession(
  tx: Prisma.TransactionClient,
  accountId: string,
  meta: SessionMeta,
  req: Request,
  now: Date,
): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + IDLE_MS);
  const row = await tx.session.create({
    data: {
      idHash: hashToken(token),
      accountId,
      createdAt: now,
      expiresAt,
      ip: req.ip ?? null,
      userAgent: (req.get('user-agent') ?? '').slice(0, 512) || null,
      method: meta.method,
      roles: meta.roles,
      oidcIssuer: meta.iss ?? null,
      oidcSubject: meta.sub ?? null,
      secondFactor: meta.secondFactor ?? null,
    },
  });
  return { id: row.id, token, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  accountId: string;
  displayName: string;
  /** When this session was issued — a sign-in that recent counts as fresh authentication. */
  createdAt: Date;
  /** Native flag OR the D3 Auth roles claim held 'admin' at sign-in (PST-REQ-007). */
  isAdmin: boolean;
  totpEnabled: boolean;
  stepUpAt: Date | null;
  meta: SessionMeta;
  /**
   * Signed in with a recovery code and not yet re-enrolled (PST-REQ-200): every step-up-gated
   * action answers 403 totp_reenrol_required until a new authenticator is set up.
   */
  reenrolRequired: boolean;
}

/**
 * The session row's sign-in metadata. `method` is CHECK-constrained to password|oidc, and
 * `second_factor` to totp|recovery_code (or null).
 */
export function metaOf(row: {
  method: string;
  roles: string[];
  oidcIssuer: string | null;
  oidcSubject: string | null;
  secondFactor?: string | null;
}): SessionMeta {
  const secondFactor: SecondFactor | null =
    row.secondFactor === 'recovery_code' ? 'recovery_code' : row.secondFactor === 'totp' ? 'totp' : null;
  return {
    method: row.method === 'oidc' ? 'oidc' : 'password',
    roles: row.roles,
    ...(row.oidcIssuer === null ? {} : { iss: row.oidcIssuer }),
    ...(row.oidcSubject === null ? {} : { sub: row.oidcSubject }),
    ...(secondFactor === null ? {} : { secondFactor }),
  };
}

/**
 * A live session for this token, or null. Expired, absolute-aged and disabled all mean null.
 *
 * `via` keeps the two kinds apart: a cookie only ever resolves a browser session, and a Bearer token
 * only a native one (PST-T-19.2) — so a web cookie lifted into an Authorization header is nothing,
 * and a native access token pasted into a cookie is nothing either.
 */
export async function resolveSession(
  db: Db,
  token: string,
  now: Date,
  via: 'cookie' | 'bearer' = 'cookie',
): Promise<ResolvedSession | null> {
  const row = await db.session.findUnique({
    where: { idHash: hashToken(token) },
    include: { account: { select: { displayName: true, isAdmin: true, totpEnabled: true, disabledAt: true } } },
  });
  if (row === null || row.native !== (via === 'bearer')) return null;
  if (row.native) {
    // A native access token lives NATIVE_ACCESS_MS and never slides: renewing is the refresh
    // token's job, and the refresh token's window is what bounds the session.
    if (row.expiresAt.getTime() <= now.getTime() || row.account.disabledAt !== null) return null;
  } else {
    const absoluteEnd = row.createdAt.getTime() + ABSOLUTE_MS;
    if (row.expiresAt.getTime() <= now.getTime() || absoluteEnd <= now.getTime() || row.account.disabledAt !== null) {
      return null;
    }
    const slid = Math.min(now.getTime() + IDLE_MS, absoluteEnd);
    if (slid - row.expiresAt.getTime() > SLIDE_EVERY_MS) {
      await db.session.update({ where: { id: row.id }, data: { expiresAt: new Date(slid) } });
    }
  }
  const meta = metaOf(row);
  return {
    sessionId: row.id,
    accountId: row.accountId,
    displayName: row.account.displayName,
    createdAt: row.createdAt,
    isAdmin: row.account.isAdmin || meta.roles.includes('admin'),
    totpEnabled: row.account.totpEnabled,
    stepUpAt: row.stepUpAt,
    meta,
    reenrolRequired: meta.secondFactor === 'recovery_code',
  };
}

/** Ends a session. Returns what was deleted, for the audit row. */
export async function deleteSession(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<{ id: string; accountId: string; createdAt: Date; ip: string | null } | null> {
  const row = await tx.session.findUnique({ where: { id: sessionId } });
  if (row === null) return null;
  await tx.session.delete({ where: { id: sessionId } });
  return { id: row.id, accountId: row.accountId, createdAt: row.createdAt, ip: row.ip };
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      const value = decodeURIComponent(raw);
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function setSessionCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(sessionCookieName(secure), token, {
    httpOnly: true,
    secure,
    // Lax, not Strict: the D3 Auth callback is a cross-site top-level GET, and Strict would drop
    // the cookie on the way back. Lax still withholds it from cross-site POSTs.
    sameSite: 'lax',
    path: '/',
    maxAge: ABSOLUTE_MS,
  });
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  res.clearCookie(sessionCookieName(secure), { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}
