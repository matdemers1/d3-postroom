// Web sessions. The cookie holds a random 32-byte token; the database holds only its SHA-256, so a
// leaked row is not a usable cookie. Sessions live in a table rather than a sealed cookie because
// revoking one has to take effect now.
import { createHash, randomBytes } from 'node:crypto';
import type { Db, Prisma } from '@postroom/db';
import type { Request, Response } from 'express';

export const SESSION_COOKIE = 'postroom_session';
/** Idle: a session unused for this long ends. */
export const IDLE_MS = 12 * 60 * 60 * 1000;
/** Absolute: however busy, a session ends this long after sign-in. */
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
/** Slide the idle expiry at most this often, so an active tab does not write on every request. */
const SLIDE_EVERY_MS = 60 * 1000;

export type SignInMethod = 'password' | 'oidc' | 'setup';

/**
 * What a session knows beyond the row: how it signed in and, for D3 Auth, the (iss, sub) and the
 * roles claim at sign-in. Kept in `setting` under a per-session key until the session table grows
 * a column for it; written in the same transaction as the session and deleted with it.
 */
export interface SessionMeta {
  method: SignInMethod;
  roles: string[];
  iss?: string;
  sub?: string;
}

export const metaKey = (sessionId: string): string => `auth.session.${sessionId}`;

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
    },
  });
  await tx.setting.create({ data: { key: metaKey(row.id), value: { ...meta } } });
  return { id: row.id, token, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  accountId: string;
  displayName: string;
  /** Native flag OR the D3 Auth roles claim held 'admin' at sign-in (PST-REQ-007). */
  isAdmin: boolean;
  totpEnabled: boolean;
  stepUpAt: Date | null;
  meta: SessionMeta;
}

function parseMeta(value: unknown): SessionMeta {
  const obj = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const method = obj['method'] === 'oidc' || obj['method'] === 'setup' ? obj['method'] : 'password';
  const roles = Array.isArray(obj['roles']) ? obj['roles'].filter((r): r is string => typeof r === 'string') : [];
  return {
    method,
    roles,
    ...(typeof obj['iss'] === 'string' ? { iss: obj['iss'] } : {}),
    ...(typeof obj['sub'] === 'string' ? { sub: obj['sub'] } : {}),
  };
}

/** A live session for this cookie value, or null. Expired, absolute-aged and disabled all mean null. */
export async function resolveSession(db: Db, token: string, now: Date): Promise<ResolvedSession | null> {
  const row = await db.session.findUnique({
    where: { idHash: hashToken(token) },
    include: { account: { select: { displayName: true, isAdmin: true, totpEnabled: true, disabledAt: true } } },
  });
  if (row === null) return null;
  const absoluteEnd = row.createdAt.getTime() + ABSOLUTE_MS;
  if (row.expiresAt.getTime() <= now.getTime() || absoluteEnd <= now.getTime() || row.account.disabledAt !== null) {
    return null;
  }
  const slid = Math.min(now.getTime() + IDLE_MS, absoluteEnd);
  if (slid - row.expiresAt.getTime() > SLIDE_EVERY_MS) {
    await db.session.update({ where: { id: row.id }, data: { expiresAt: new Date(slid) } });
  }
  const metaRow = await db.setting.findUnique({ where: { key: metaKey(row.id) } });
  const meta = parseMeta(metaRow?.value);
  return {
    sessionId: row.id,
    accountId: row.accountId,
    displayName: row.account.displayName,
    isAdmin: row.account.isAdmin || meta.roles.includes('admin'),
    totpEnabled: row.account.totpEnabled,
    stepUpAt: row.stepUpAt,
    meta,
  };
}

export async function readMeta(tx: Prisma.TransactionClient | Db, sessionId: string): Promise<SessionMeta> {
  const row = await tx.setting.findUnique({ where: { key: metaKey(sessionId) } });
  return parseMeta(row?.value);
}

/** Ends a session and its meta. Returns what was deleted, for the audit row. */
export async function deleteSession(
  tx: Prisma.TransactionClient,
  sessionId: string,
): Promise<{ id: string; accountId: string; createdAt: Date; ip: string | null } | null> {
  const row = await tx.session.findUnique({ where: { id: sessionId } });
  if (row === null) return null;
  await tx.session.delete({ where: { id: sessionId } });
  await tx.setting.deleteMany({ where: { key: metaKey(sessionId) } });
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
  res.cookie(SESSION_COOKIE, token, {
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
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}
