// Accepting an invite (PST-T-20.2, `spec/account-lifecycle.md`): the same two steps for the web page
// at /invite/<token> and for D3 Constellation through `endpoints.inviteAccept`.
//
//   1. {token, displayName, password, device?} → the account, then {challenge, enrolment}
//   2. {challenge, enrolTotp}                  → the authenticator, ten recovery codes and a session
//
// Only the envelope differs. Native answers are problem+json with the contract's registered types and
// end in native tokens; web answers are the console's {error} JSON and end in the session cookie. A
// used, revoked, expired or unknown token is one answer — `invite_invalid` — so a guess learns
// nothing, and never `invalid_credentials`, which would hint that an account exists.
import { randomBytes } from 'node:crypto';
import { getAuditContext, recordAudit } from '@postroom/audit';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { acceptInvite, hashInviteToken, INVITE_ENROL_TTL_MS, InviteUnusable, resumableInvite, weakPasswordDetail } from './account-lifecycle.js';
import { issueNativeSession, type Device } from './native-sessions.js';
import { checkPassword, MAX_PASSWORD_LENGTH } from './password-policy.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { formatRecoveryCode, generateRecoveryCodes, hashRecoveryCodes, RECOVERY_CODE_COUNT, replaceRecoveryCodes } from './recovery.js';
import { ANY_LOGIN, logThrottled } from './routes.js';
import type { AuthRuntime } from './runtime.js';
import { deleteSession, hashToken, issueSession, readCookie, sessionCookieName, setSessionCookie } from './sessions.js';
import { generateTotpSecret, matchStep, provisioningUri, sealTotpSecret } from './totp.js';

export type Surface = 'native' | 'web';

const DeviceShape = z.object({ name: z.string().trim().min(1).max(120), platform: z.string().trim().min(1).max(40) });
export const InviteStep = z.union([
  z.object({
    token: z.string().min(1).max(200),
    displayName: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(MAX_PASSWORD_LENGTH + 1),
    device: DeviceShape.optional(),
  }),
  z.object({ challenge: z.string().min(1).max(200), enrolTotp: z.string().min(1).max(64) }),
]);

const PROBLEMS = 'https://d3cloud.io/problems/';

/** A refusal in the surface's own envelope. */
function refuse(surface: Surface, res: Response, status: number, name: string | null, title: string, extra: Record<string, unknown> = {}): void {
  if (surface === 'native') {
    res.status(status).type('application/problem+json').send(JSON.stringify({ type: name === null ? 'about:blank' : `${PROBLEMS}${name}`, title, status, ...extra }));
    return;
  }
  res.status(status).json({ error: name ?? 'invalid_request', message: typeof extra['detail'] === 'string' ? extra['detail'] : title, ...extra });
}

function throttled(surface: Surface, req: Request, res: Response, waitMs: number): void {
  logThrottled(req);
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  res.setHeader('Retry-After', String(seconds));
  if (surface === 'native') refuse(surface, res, 429, 'throttled', 'Too many attempts', { detail: `Try again in ${String(seconds)} seconds.`, retryAfter: seconds });
  else res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: seconds });
}

const invalid = (surface: Surface, res: Response): void => {
  refuse(surface, res, 410, 'invite_invalid', 'This invite can’t be used', { detail: 'It has been used, withdrawn or has expired. Ask for a new one.' });
};

/** Both steps, for either surface. The body is already parsed. */
export async function inviteStep(rt: AuthRuntime, req: Request, res: Response, body: z.infer<typeof InviteStep>, surface: Surface): Promise<void> {
  if (rt.pepper === null || rt.kek === null) {
    refuse(surface, res, 503, null, 'Sign-in is not configured on this server');
    return;
  }
  if ('token' in body) await accountStep(rt, req, res, body, surface);
  else await enrolStep(rt, req, res, body.challenge, body.enrolTotp, surface);
}

async function accountStep(
  rt: AuthRuntime,
  req: Request,
  res: Response,
  body: { token: string; displayName: string; password: string; device?: Device | undefined },
  surface: Surface,
): Promise<void> {
  const pepper = rt.pepper ?? '';
  const nowMs = rt.now().getTime();
  const ip = req.ip ?? 'unknown';
  // Keyed by the token's hash, so each guess is its own key and only the address adds up.
  const key = `invite:${hashInviteToken(body.token).slice(0, 24)}`;
  const wait = Math.max(rt.throttle.retryAfter(key, ip, nowMs), rt.ipThrottle.retryAfter(ANY_LOGIN, ip, nowMs));
  if (wait > 0) {
    throttled(surface, req, res, wait);
    return;
  }
  const context = getAuditContext(req);
  const refused = async (reason: string): Promise<void> => {
    rt.throttle.recordFailure(key, ip, nowMs);
    rt.ipThrottle.recordFailure(ANY_LOGIN, ip, nowMs);
    await recordAudit(rt.db, { actor: { kind: 'anonymous' }, action: 'account.invite.rejected', entityType: 'account_invite', entityId: null, after: { reason, via: surface }, context });
    invalid(surface, res);
  };

  const invite = await rt.db.accountInvite.findUnique({ where: { tokenHash: hashInviteToken(body.token) }, select: { id: true, acceptedAt: true, revokedAt: true, expiresAt: true } });
  if (invite === null) {
    await refused('unknown');
    return;
  }

  let accountId: string;
  let address: string;
  if (invite.acceptedAt !== null) {
    // The invite's own account, still without a second factor: only its own password reopens it.
    const resumable = await resumableInvite(rt.db, body.token);
    if (resumable === null || !(await verifyPassword(resumable.passwordHash, body.password, pepper))) {
      await refused('accepted');
      return;
    }
    accountId = resumable.accountId;
    address = resumable.address;
    await recordAudit(rt.db, {
      actor: { kind: 'account', accountId },
      action: 'account.invite.resume',
      entityType: 'account',
      entityId: accountId,
      after: { inviteId: invite.id, via: surface },
      context,
    });
  } else {
    if (invite.revokedAt !== null || invite.expiresAt.getTime() <= nowMs) {
      await refused(invite.revokedAt !== null ? 'revoked' : 'expired');
      return;
    }
    const problems = checkPassword(body.password, { domain: rt.domain });
    if (problems.length > 0) {
      if (surface === 'native') refuse(surface, res, 422, 'weak_password', 'Choose a stronger password', { detail: weakPasswordDetail(problems) });
      else res.status(400).json({ error: 'weak_password', problems, message: weakPasswordDetail(problems) });
      return;
    }
    const passwordHash = await hashPassword(body.password, pepper);
    try {
      const accepted = await acceptInvite(rt.db, { token: body.token, displayName: body.displayName, passwordHash }, rt.now(), context);
      accountId = accepted.accountId;
      address = accepted.address;
    } catch (error) {
      if (error instanceof InviteUnusable) {
        await refused(error.reason);
        return;
      }
      throw error;
    }
  }

  rt.throttle.clear(key, ip);
  const secret = generateTotpSecret();
  const challenge = randomBytes(32).toString('base64url');
  rt.inviteEnrols.set(challenge, {
    accountId,
    address,
    secret,
    exp: rt.now().getTime() + INVITE_ENROL_TTL_MS,
    attempts: 0,
    checking: false,
    surface,
    ...(body.device === undefined ? {} : { device: body.device }),
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ challenge, address, enrolment: { secret, otpauthUri: provisioningUri(secret, address), digits: 6, period: 30 } });
}

async function enrolStep(rt: AuthRuntime, req: Request, res: Response, challengeId: string, code: string, surface: Surface): Promise<void> {
  const kek = rt.kek;
  const pepper = rt.pepper;
  if (kek === null || pepper === null) return;
  const pending = rt.inviteEnrols.get(challengeId, rt.now().getTime());
  if (pending?.surface !== surface) {
    refuse(surface, res, 401, 'invalid_code', 'This setup has expired', { detail: 'Open your invite link again and use the same password to finish.' });
    return;
  }
  const ip = req.ip ?? 'unknown';
  const key = `invite-enrol:${pending.accountId}`;
  const wait = rt.throttle.retryAfter(key, ip, rt.now().getTime());
  if (wait > 0 || pending.checking) {
    throttled(surface, req, res, Math.max(wait, 1000));
    return;
  }
  pending.checking = true;
  pending.attempts += 1;
  try {
    const context = getAuditContext(req);
    const step = matchStep(pending.secret, code, rt.now());
    if (step === null) {
      // The challenge stays valid until it expires, as the contract has it; the throttle on the
      // account is what stops it being a way to guess.
      rt.throttle.recordFailure(key, ip, rt.now().getTime());
      await recordAudit(rt.db, {
        actor: { kind: 'account', accountId: pending.accountId },
        action: 'auth.totp.enrol.rejected',
        entityType: 'account',
        entityId: pending.accountId,
        after: { attempts: pending.attempts, reason: 'invite', via: surface },
        context,
      });
      refuse(surface, res, 401, 'invalid_code', 'That code didn’t work', { detail: 'Check the time on your device, then try the current code.' });
      return;
    }
    const codes = generateRecoveryCodes();
    const hashes = await hashRecoveryCodes(codes, pepper);
    const at = rt.now();
    const sealed = sealTotpSecret(kek, pending.secret, pending.accountId);
    type Issued = { kind: 'native'; tokens: Awaited<ReturnType<typeof issueNativeSession>> } | { kind: 'web'; token: string };
    const issued = await rt.db.$transaction(async (tx): Promise<Issued | null> => {
      // Enrolled only once: a second challenge for the same account, finished first, wins.
      const { count } = await tx.account.updateMany({
        where: { id: pending.accountId, totpEnabled: false, disabledAt: null },
        data: { totpSecret: sealed, totpEnabled: true, totpLastStep: BigInt(step) },
      });
      if (count !== 1) return null;
      await recordAudit(tx, {
        actor: { kind: 'account', accountId: pending.accountId },
        action: 'auth.totp.enrol',
        entityType: 'account',
        entityId: pending.accountId,
        after: { authenticator: 'enrolled', reason: 'invite', via: surface },
        context,
      });
      await replaceRecoveryCodes(tx, pending.accountId, hashes, at);
      await recordAudit(tx, {
        actor: { kind: 'account', accountId: pending.accountId },
        action: 'auth.recovery-codes.issue',
        entityType: 'account',
        entityId: pending.accountId,
        after: { count: RECOVERY_CODE_COUNT, reason: 'enrolment' },
        context,
      });
      const meta = { method: 'password' as const, roles: [], secondFactor: 'totp' as const };
      if (surface === 'native') {
        const tokens = await issueNativeSession(tx, pending.accountId, meta, pending.device ?? null, req, at);
        await recordAudit(tx, {
          actor: { kind: 'account', accountId: pending.accountId },
          action: 'auth.signin',
          entityType: 'session',
          entityId: tokens.sessionId,
          after: { method: 'password', factor: 'totp', via: 'native-invite', device: pending.device?.name ?? null },
          context,
        });
        return { kind: 'native', tokens };
      }
      // A browser that was signed in as someone else is signed out of that session first.
      const presented = readCookie(req, sessionCookieName(rt.secure));
      if (presented !== null) {
        const row = await tx.session.findUnique({ where: { idHash: hashToken(presented) }, select: { id: true } });
        if (row !== null) await deleteSession(tx, row.id);
      }
      const session = await issueSession(tx, pending.accountId, meta, req, at);
      await recordAudit(tx, {
        actor: { kind: 'account', accountId: pending.accountId },
        action: 'auth.signin',
        entityType: 'session',
        entityId: session.id,
        after: { method: 'password', factor: 'totp', via: 'invite' },
        context,
      });
      return { kind: 'web', token: session.token };
    });
    rt.inviteEnrols.delete(challengeId);
    if (issued === null) {
      refuse(surface, res, 401, 'invalid_code', 'This setup has already finished', { detail: 'Sign in with your email and password.' });
      return;
    }
    rt.throttle.clear(key, ip);
    res.setHeader('Cache-Control', 'no-store');
    const recoveryCodes = codes.map(formatRecoveryCode);
    if (issued.kind === 'native') {
      const t = issued.tokens;
      res.json({ accessToken: t.accessToken, refreshToken: t.refreshToken, expiresIn: t.expiresIn, session: { id: t.sessionId }, recoveryCodes });
      return;
    }
    setSessionCookie(res, issued.token, rt.secure);
    res.json({ ok: true, address: pending.address, recoveryCodes });
  } finally {
    pending.checking = false;
  }
}
