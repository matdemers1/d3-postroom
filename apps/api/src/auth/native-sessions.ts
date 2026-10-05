// Native sessions (PST-T-19.2, the D3 App contract): D3 Constellation signs in without a browser.
// A native session is an ordinary `session` row — the sessions screen lists it, signing it out
// deletes it, every route resolves it — marked `native`, named by its device, and reached with a
// Bearer access token instead of the cookie. The access token is the row's `idHash`, short-lived and
// replaced on every refresh; the refresh tokens rotate through `native_refresh`, and a replaced
// refresh token presented again is reuse: the session ends.
import { randomBytes } from 'node:crypto';
import type { Db, Prisma } from '@postroom/db';
import type { Request } from 'express';
import { hashToken, type SessionMeta } from './sessions.js';

/** The contract's ceiling for an access token: a phone is lost more often than a desk. */
export const NATIVE_ACCESS_MS = 15 * 60 * 1000;
/** A refresh token's window, renewed by every use (the contract's sliding thirty days). */
export const NATIVE_REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

export interface Device {
  name: string;
  platform: string;
}

export interface NativeTokens {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  /** Seconds, as the contract carries it. */
  expiresIn: number;
}

const token = (): string => randomBytes(32).toString('base64url');

export async function issueNativeSession(
  tx: Prisma.TransactionClient,
  accountId: string,
  meta: SessionMeta,
  device: Device | null,
  req: Request,
  now: Date,
): Promise<NativeTokens> {
  const accessToken = token();
  const refreshToken = token();
  const row = await tx.session.create({
    data: {
      idHash: hashToken(accessToken),
      accountId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + NATIVE_ACCESS_MS),
      ip: req.ip ?? null,
      userAgent: (req.get('user-agent') ?? '').slice(0, 512) || null,
      method: meta.method,
      roles: meta.roles,
      oidcIssuer: meta.iss ?? null,
      oidcSubject: meta.sub ?? null,
      secondFactor: meta.secondFactor ?? null,
      native: true,
      deviceName: device?.name.slice(0, 120) ?? null,
      devicePlatform: device?.platform.slice(0, 40) ?? null,
    },
  });
  await tx.nativeRefresh.create({
    data: { sessionId: row.id, tokenHash: hashToken(refreshToken), createdAt: now, expiresAt: new Date(now.getTime() + NATIVE_REFRESH_MS) },
  });
  return { sessionId: row.id, accessToken, refreshToken, expiresIn: NATIVE_ACCESS_MS / 1000 };
}

export type Rotation =
  | { kind: 'rotated'; tokens: NativeTokens; accountId: string }
  | { kind: 'reused'; sessionId: string; accountId: string }
  | { kind: 'ended' };

/**
 * Exchange a refresh token for a new pair. The presented row is claimed with a conditional update,
 * so two refreshes racing with one token cannot both succeed: the loser sees it replaced, which is
 * reuse, and the session ends — exactly what a stolen token racing its owner should cause.
 */
export async function rotateNativeSession(db: Db, refreshToken: string, now: Date): Promise<Rotation> {
  const presented = await db.nativeRefresh.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { session: { select: { id: true, accountId: true, account: { select: { disabledAt: true } } } } },
  });
  if (presented === null || presented.expiresAt.getTime() <= now.getTime() || presented.session.account.disabledAt !== null) {
    return { kind: 'ended' };
  }
  const { id: sessionId, accountId } = presented.session;
  if (presented.replacedAt !== null) return { kind: 'reused', sessionId, accountId };
  return db.$transaction(async (tx) => {
    const { count } = await tx.nativeRefresh.updateMany({ where: { id: presented.id, replacedAt: null }, data: { replacedAt: now } });
    if (count !== 1) return { kind: 'reused', sessionId, accountId } as const;
    const accessToken = token();
    const next = token();
    await tx.session.update({
      where: { id: sessionId },
      data: { idHash: hashToken(accessToken), expiresAt: new Date(now.getTime() + NATIVE_ACCESS_MS) },
    });
    await tx.nativeRefresh.create({
      data: { sessionId, tokenHash: hashToken(next), createdAt: now, expiresAt: new Date(now.getTime() + NATIVE_REFRESH_MS) },
    });
    return {
      kind: 'rotated',
      accountId,
      tokens: { sessionId, accessToken, refreshToken: next, expiresIn: NATIVE_ACCESS_MS / 1000 },
    } as const;
  });
}

/**
 * The sessions still signed in at `now`, for the sessions screens (PST-T-19.4). A native session's
 * row expires with its fifteen-minute access token, and the device is still signed in for as long as
 * its refresh token is live — listing by the row alone would hide every idle phone, and a session
 * nobody can see is one nobody can revoke.
 */
export function liveSessionWhere(now: Date): Prisma.SessionWhereInput {
  // A D3 Auth token's row (native, no refresh) is governed by D3 Auth and never listed here.
  return { OR: [{ native: false, expiresAt: { gt: now } }, { native: true, refreshes: { some: { replacedAt: null, expiresAt: { gt: now } } } }] };
}

/** The Bearer token in a request, if it carries one. */
export function bearerOf(req: Request): string | null {
  const header = req.get('authorization') ?? '';
  const [scheme, value] = header.split(' ', 2);
  return scheme?.toLowerCase() === 'bearer' && value !== undefined && value.length > 0 ? value : null;
}
