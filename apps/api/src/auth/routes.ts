// /api/auth — setup, both sign-in paths side by side, sign-out, step-up, and the caller's sessions.
// The password path never imports or awaits anything OIDC: it has to keep working with D3 Auth
// unreachable (PST-REQ-005).
import { randomBytes } from 'node:crypto';
import { inMemorySeen, LogoutTokenError, verifyLogoutToken, type VerifiedLogout } from '@d3cloudio/auth-client';
import { audited, getAuditContext, recordAudit, type Actor } from '@postroom/audit';
import { AddressKind, normalizeLocalPart, parseAddress, type Account, type Db, type Prisma } from '@postroom/db';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import { currentSession, handle, requireSession, requireStepUp, sessionOf } from './middleware.js';
import {
  IdentityCollision,
  openTransaction,
  resolveIdentity,
  sealTransaction,
  TX_TTL_MS,
  txCookieName,
  type OidcTransaction,
} from './oidc.js';
import { decoyHash, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from './passwords.js';
import { checkPassword, MAX_PASSWORD_LENGTH, type PasswordProblem } from './password-policy.js';
import {
  CHALLENGE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  runtimeFor,
  SETUP_TTL_MS,
  STEP_UP_MS,
  type AuthRuntime,
} from './runtime.js';
import {
  clearSessionCookie,
  deleteSession,
  hashToken,
  issueSession,
  readCookie,
  sessionCookieName,
  setSessionCookie,
} from './sessions.js';
import { completeSetup, isSetupRequired, SetupConflict } from './setup.js';
import { checkSetupGate } from './setup-gate.js';
import { burnStep, generateTotpSecret, matchStep, openTotpSecret, provisioningUri } from './totp.js';

const Login = z.string().trim().min(1).max(320);
const Password = z.string().min(1).max(1024);
const Code = z.string().trim().min(6).max(10);

const SetupBegin = z.object({
  displayName: z.string().trim().min(1).max(200),
  login: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/, 'letters, digits, dot, dash or underscore'),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});
const SetupComplete = z.object({ enrolToken: z.string().min(1).max(200), code: Code });
const SignIn = z.object({ login: Login, password: Password });
const SignInTotp = z.object({ challenge: z.string().min(1).max(200), code: Code });
const StepUp = z.object({ code: Code });
const PasswordChange = z.object({
  currentPassword: Password,
  newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  code: Code,
  /** End every other session once the password changes (ASVS 5.0 7.4.3). On unless refused. */
  endOtherSessions: z.boolean().optional(),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An attempt refused by the throttle is an attempt to get past anti-automation (ASVS 5.0 16.3.3). */
function logThrottled(req: Request): void {
  process.stderr.write(`${JSON.stringify({ event: 'auth-throttled', method: req.method, path: req.path, ip: req.ip ?? null, requestId: getAuditContext(req).requestId })}\n`);
}

function weakPassword(res: Response, problems: PasswordProblem[]): void {
  res.status(400).json({ error: 'weak_password', problems });
}

/**
 * A new sign-in ends the session the browser presented, if it had one (ASVS 5.0 7.2.4): the old
 * token must not outlive the authentication that replaced it. Runs inside the issuing transaction.
 */
async function endPresentedSession(rt: AuthRuntime, tx: Prisma.TransactionClient, req: Request): Promise<string | null> {
  const token = readCookie(req, sessionCookieName(rt.secure));
  if (token === null) return null;
  const row = await tx.session.findUnique({ where: { idHash: hashToken(token) }, select: { id: true } });
  if (row === null) return null;
  await deleteSession(tx, row.id);
  return row.id;
}

/** Signed in or stepped up within the step-up window: fresh enough to change how the account signs in. */
function freshlyAuthenticated(rt: AuthRuntime, session: { createdAt: Date; stepUpAt: Date | null }): boolean {
  const now = rt.now().getTime();
  const at = Math.max(session.createdAt.getTime(), session.stepUpAt?.getTime() ?? -Infinity);
  const age = now - at;
  return age >= 0 && age <= STEP_UP_MS;
}

function notConfigured(res: Response): void {
  res.status(503).json({ error: 'auth_not_configured' });
}

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: 'invalid_request',
    fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

const anonymous: Actor = { kind: 'anonymous' };
const asAccount = (accountId: string): Actor => ({ kind: 'account', accountId });

/** The account a login names: `local` at the primary domain, or a full primary address. */
async function findByLogin(db: Db, login: string): Promise<Account | null> {
  let localPart: string;
  let domainWhere: { name: string } | { isPrimary: true };
  try {
    if (login.includes('@')) {
      const parsed = parseAddress(login);
      localPart = parsed.localPart;
      domainWhere = { name: parsed.domain };
    } else {
      localPart = normalizeLocalPart(login);
      domainWhere = { isPrimary: true };
    }
  } catch {
    return null;
  }
  const address = await db.address.findFirst({
    where: { localPart, kind: AddressKind.primary, killedAt: null, domain: domainWhere },
    include: { account: true },
  });
  return address?.account ?? null;
}

async function primaryAddress(db: Db, accountId: string): Promise<string | null> {
  const address = await db.address.findFirst({
    where: { accountId, kind: AddressKind.primary },
    include: { domain: true },
    orderBy: { createdAt: 'asc' },
  });
  return address === null ? null : `${address.localPart}@${address.domain.name}`;
}

function signinError(message: string, linkAfter = false): string {
  const query = new URLSearchParams({ signin_error: message });
  if (linkAfter) query.set('link_after_signin', '1');
  return `/signin?${query.toString()}`;
}

function txCookie(rt: AuthRuntime, res: Response, value: string, maxAgeMs: number): void {
  res.cookie(txCookieName(rt.secure), value, {
    httpOnly: true,
    secure: rt.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  });
}

export function authRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();
  const nowMs = (): number => rt.now().getTime();

  /**
   * SETUP_TOKEN, or a private client address when it is unset. A refusal is audited without the
   * presented value, and answered 403 {error:'setup_token_required'}.
   */
  const setupAllowed = async (req: Request, res: Response): Promise<boolean> => {
    const body = req.body as Record<string, unknown> | undefined;
    const gate = checkSetupGate(rt.setupToken, body?.['setupToken'], req.ip);
    if (gate.ok) return true;
    await recordAudit(db, {
      actor: anonymous,
      action: 'auth.setup.denied',
      entityType: 'setup',
      entityId: null,
      after: { reason: gate.reason, path: req.path },
      context: getAuditContext(req),
    });
    res.status(403).json({ error: 'setup_token_required' });
    return false;
  };

  router.get(
    '/state',
    handle(async (req, res) => {
      const [setupRequired, client, session] = await Promise.all([
        isSetupRequired(db),
        rt.oidc.get(nowMs()),
        sessionOf(rt, req),
      ]);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        setupRequired,
        oidcConfigured: rt.oidc.configured,
        oidcAvailable: client !== null,
        signedIn: session !== null,
        ...(session === null
          ? {}
          : {
              account: {
                id: session.accountId,
                displayName: session.displayName,
                isAdmin: session.isAdmin,
                totpEnabled: session.totpEnabled,
                address: await primaryAddress(db, session.accountId),
              },
              method: session.meta.method,
            }),
      });
    }),
  );

  // ─── One-time setup ──────────────────────────────────────────────────────

  router.post(
    '/setup/begin',
    handle(async (req, res) => {
      if (rt.pepper === null || rt.kek === null) {
        notConfigured(res);
        return;
      }
      if (!(await isSetupRequired(db))) {
        res.status(409).json({ error: 'setup_complete' });
        return;
      }
      if (!(await setupAllowed(req, res))) return;
      const parsed = SetupBegin.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, parsed.error);
        return;
      }
      const { displayName, login, password } = parsed.data;
      const problems = checkPassword(password, { domain: rt.domain });
      if (problems.length > 0) {
        weakPassword(res, problems);
        return;
      }
      const totpSecret = generateTotpSecret();
      // The handle for this enrolment in flight — not SETUP_TOKEN, which the operator brings.
      const enrolToken = randomBytes(32).toString('base64url');
      rt.setups.set(enrolToken, {
        displayName,
        login,
        passwordHash: await hashPassword(password, rt.pepper),
        totpSecret,
        exp: nowMs() + SETUP_TTL_MS,
        attempts: 0,
      });
      // Nothing is written to the account until a code proves the authenticator works; the audit
      // row records that setup was started, and from where.
      await recordAudit(db, {
        actor: anonymous,
        action: 'auth.setup.begin',
        entityType: 'setup',
        entityId: null,
        after: { displayName, login },
        context: getAuditContext(req),
      });
      res.json({ enrolToken, secret: totpSecret, otpauthUri: provisioningUri(totpSecret, login) });
    }),
  );

  router.post(
    '/setup/complete',
    handle(async (req, res) => {
      if (rt.pepper === null || rt.kek === null) {
        notConfigured(res);
        return;
      }
      if (!(await isSetupRequired(db))) {
        res.status(409).json({ error: 'setup_complete' });
        return;
      }
      if (!(await setupAllowed(req, res))) return;
      const parsed = SetupComplete.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, parsed.error);
        return;
      }
      const pending = rt.setups.get(parsed.data.enrolToken, nowMs());
      if (pending === undefined) {
        res.status(400).json({ error: 'setup_expired' });
        return;
      }
      const step = matchStep(pending.totpSecret, parsed.data.code, rt.now());
      if (step === null) {
        pending.attempts += 1;
        if (pending.attempts >= MAX_CODE_ATTEMPTS) rt.setups.delete(parsed.data.enrolToken);
        await recordAudit(db, {
          actor: anonymous,
          action: 'auth.setup.code_rejected',
          entityType: 'setup',
          entityId: null,
          after: { login: pending.login, attempts: pending.attempts },
          context: getAuditContext(req),
        });
        res.status(400).json({ error: 'invalid_code' });
        return;
      }
      try {
        const done = await completeSetup(
          db,
          rt.kek,
          { ...pending, step, domain: rt.domain },
          req,
          getAuditContext(req),
          rt.now(),
        );
        rt.setups.delete(parsed.data.enrolToken);
        setSessionCookie(res, done.session.token, rt.secure);
        res.json({ ok: true, account: { id: done.accountId, address: done.address } });
      } catch (error) {
        if (error instanceof SetupConflict) {
          res.status(409).json({ error: error.code });
          return;
        }
        throw error;
      }
    }),
  );

  // ─── Password + TOTP ─────────────────────────────────────────────────────

  router.post(
    '/signin',
    handle(async (req, res) => {
      if (rt.pepper === null || rt.kek === null) {
        notConfigured(res);
        return;
      }
      const parsed = SignIn.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, parsed.error);
        return;
      }
      const { login, password } = parsed.data;
      const ip = req.ip ?? 'unknown';

      // Throttle before hashing: a rejected guess must not have cost 64 MiB of Argon2id first.
      const wait = rt.throttle.retryAfter(login, ip, nowMs());
      if (wait > 0) {
        logThrottled(req);
        res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
        res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: Math.ceil(wait / 1000) });
        return;
      }

      const account = await findByLogin(db, login);
      const usable = account !== null && account.passwordHash !== null && account.disabledAt === null;
      // An unknown login spends the same Argon2id time as a wrong password.
      let ok = false;
      if (usable) ok = await verifyPassword(account.passwordHash ?? '', password, rt.pepper);
      else await verifyPassword(await decoyHash(rt.pepper), password, rt.pepper);

      if (!ok || account === null) {
        rt.throttle.recordFailure(login, ip, nowMs());
        await recordAudit(db, {
          actor: anonymous,
          action: 'auth.signin.rejected',
          entityType: 'account',
          entityId: account?.id ?? null,
          after: { login, factor: 'password' },
          context: getAuditContext(req),
        });
        res.status(401).json({ error: 'invalid_credentials' });
        return;
      }

      // TOTP is part of app-native sign-in, not an option on it (PST-REQ-005).
      if (!account.totpEnabled || account.totpSecret === null) {
        await recordAudit(db, {
          actor: asAccount(account.id),
          action: 'auth.signin.rejected',
          entityType: 'account',
          entityId: account.id,
          after: { login, factor: 'totp', reason: 'not_enrolled' },
          context: getAuditContext(req),
        });
        res.status(403).json({ error: 'totp_not_enrolled' });
        return;
      }

      const challenge = randomBytes(32).toString('base64url');
      rt.challenges.set(challenge, { accountId: account.id, login, exp: nowMs() + CHALLENGE_TTL_MS, attempts: 0 });
      await recordAudit(db, {
        actor: asAccount(account.id),
        action: 'auth.signin.password_accepted',
        entityType: 'account',
        entityId: account.id,
        after: { login, next: 'totp' },
        context: getAuditContext(req),
      });
      res.json({ next: 'totp', challenge });
    }),
  );

  router.post(
    '/signin/totp',
    handle(async (req, res) => {
      const kek = rt.kek;
      if (rt.pepper === null || kek === null) {
        notConfigured(res);
        return;
      }
      const parsed = SignInTotp.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, parsed.error);
        return;
      }
      const pending = rt.challenges.get(parsed.data.challenge, nowMs());
      if (pending === undefined) {
        res.status(401).json({ error: 'challenge_expired' });
        return;
      }
      const ip = req.ip ?? 'unknown';
      const wait = rt.throttle.retryAfter(pending.login, ip, nowMs());
      if (wait > 0) {
        logThrottled(req);
        res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
        res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: Math.ceil(wait / 1000) });
        return;
      }
      const account = await db.account.findUnique({ where: { id: pending.accountId } });
      const secret =
        account?.totpSecret === null || account?.totpSecret === undefined
          ? null
          : openTotpSecret(kek, account.totpSecret, account.id);
      const step = secret === null ? null : matchStep(secret, parsed.data.code, rt.now());

      const issued =
        step === null || account === null
          ? null
          : await db.$transaction(async (tx) => {
              if (!(await burnStep(tx, account.id, step))) return null;
              const replaced = await endPresentedSession(rt, tx, req);
              const session = await issueSession(tx, account.id, { method: 'password', roles: [] }, req, rt.now());
              await recordAudit(tx, {
                actor: asAccount(account.id),
                action: 'auth.signin',
                entityType: 'session',
                entityId: session.id,
                after: { method: 'password', accountId: account.id, replacedSessionId: replaced },
                context: getAuditContext(req),
              });
              return session;
            });

      if (issued === null || account === null) {
        pending.attempts += 1;
        if (pending.attempts >= MAX_CODE_ATTEMPTS) rt.challenges.delete(parsed.data.challenge);
        rt.throttle.recordFailure(pending.login, ip, nowMs());
        await recordAudit(db, {
          actor: anonymous,
          action: 'auth.signin.rejected',
          entityType: 'account',
          entityId: pending.accountId,
          after: { login: pending.login, factor: 'totp', attempts: pending.attempts },
          context: getAuditContext(req),
        });
        res.status(401).json({ error: 'invalid_code' });
        return;
      }
      rt.challenges.delete(parsed.data.challenge);
      rt.throttle.clear(pending.login, ip);
      setSessionCookie(res, issued.token, rt.secure);
      res.json({ next: 'done', account: { id: account.id, displayName: account.displayName, isAdmin: account.isAdmin } });
    }),
  );

  router.post(
    '/signout',
    handle(async (req, res) => {
      const session = await sessionOf(rt, req);
      clearSessionCookie(res, rt.secure);
      // Whatever the signed-in app left in this browser goes with the session (ASVS 5.0 14.3.1).
      res.setHeader('Clear-Site-Data', '"cache", "storage"');
      if (session === null) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      await audited(
        db,
        asAccount(session.accountId),
        { action: 'auth.signout', entityType: 'session', context: getAuditContext(req) },
        async (tx) => {
          const before = await deleteSession(tx, session.sessionId);
          return { entityId: session.sessionId, before, after: null, result: null };
        },
      );
      res.json({ ok: true });
    }),
  );

  // ─── Step-up (PST-REQ-008) ───────────────────────────────────────────────

  router.post(
    '/step-up',
    requireSession(deps),
    handle(async (req, res) => {
      const kek = rt.kek;
      if (kek === null) {
        notConfigured(res);
        return;
      }
      const session = currentSession(req);
      const parsed = StepUp.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, parsed.error);
        return;
      }
      const account = await db.account.findUnique({ where: { id: session.accountId } });
      if (account === null || !account.totpEnabled || account.totpSecret === null) {
        res.status(403).json({ error: 'totp_not_enrolled' });
        return;
      }
      const throttleKey = `step-up:${account.id}`;
      const ip = req.ip ?? 'unknown';
      const wait = rt.throttle.retryAfter(throttleKey, ip, nowMs());
      if (wait > 0) {
        logThrottled(req);
        res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
        res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: Math.ceil(wait / 1000) });
        return;
      }
      const step = matchStep(openTotpSecret(kek, account.totpSecret, account.id), parsed.data.code, rt.now());
      const at = rt.now();
      const ok =
        step !== null &&
        (await db.$transaction(async (tx) => {
          if (!(await burnStep(tx, account.id, step))) return false;
          await tx.session.update({ where: { id: session.sessionId }, data: { stepUpAt: at } });
          await recordAudit(tx, {
            actor: asAccount(account.id),
            action: 'auth.step-up',
            entityType: 'session',
            entityId: session.sessionId,
            before: { stepUpAt: session.stepUpAt },
            after: { stepUpAt: at },
            context: getAuditContext(req),
          });
          return true;
        }));
      if (!ok) {
        rt.throttle.recordFailure(throttleKey, ip, nowMs());
        await recordAudit(db, {
          actor: asAccount(account.id),
          action: 'auth.step-up.rejected',
          entityType: 'session',
          entityId: session.sessionId,
          context: getAuditContext(req),
        });
        res.status(401).json({ error: 'invalid_code' });
        return;
      }
      rt.throttle.clear(throttleKey, ip);
      res.json({ ok: true, stepUpAt: at.toISOString() });
    }),
  );

  router.get(
    '/sessions',
    requireSession(deps),
    handle(async (req, res) => {
      const session = currentSession(req);
      const rows = await db.session.findMany({
        where: { accountId: session.accountId, expiresAt: { gt: rt.now() } },
        orderBy: { createdAt: 'desc' },
      });
      res.json({
        sessions: rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          ip: row.ip,
          userAgent: row.userAgent,
          current: row.id === session.sessionId,
        })),
      });
    }),
  );

  // Ending one of your own sessions, or all the others, needs a step-up (ASVS 5.0 7.5.2).
  router.delete(
    '/sessions/:id',
    requireSession(deps),
    requireStepUp(deps),
    handle(async (req, res) => {
      const me = currentSession(req);
      const id = String(req.params['id']);
      const target = UUID.test(id) ? await db.session.findUnique({ where: { id }, select: { accountId: true } }) : null;
      if (target === null || target.accountId !== me.accountId) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await audited(
        db,
        asAccount(me.accountId),
        { action: 'auth.session.revoke', entityType: 'session', context: getAuditContext(req) },
        async (tx) => ({ entityId: id, before: await deleteSession(tx, id), after: null, result: null }),
      );
      if (id === me.sessionId) clearSessionCookie(res, rt.secure);
      res.json({ ok: true });
    }),
  );

  router.delete(
    '/sessions',
    requireSession(deps),
    requireStepUp(deps),
    handle(async (req, res) => {
      const me = currentSession(req);
      const ended = await db.$transaction(async (tx) => {
        const others = await tx.session.findMany({ where: { accountId: me.accountId, id: { not: me.sessionId } }, select: { id: true } });
        await tx.session.deleteMany({ where: { id: { in: others.map((o) => o.id) } } });
        await recordAudit(tx, {
          actor: asAccount(me.accountId),
          action: 'auth.session.revoke-others',
          entityType: 'account',
          entityId: me.accountId,
          after: { ended: others.map((o) => o.id) },
          context: getAuditContext(req),
        });
        return others.length;
      });
      res.json({ ok: true, ended });
    }),
  );

  // ─── Password change (ASVS 5.0 6.2.2, 6.2.3, 7.5.1, 7.4.3) ──────────────
  // The current password and a TOTP code — full re-authentication — then the policy, then the new
  // hash, with every other session ended unless the caller asks to keep them.

  router.post(
    '/password',
    requireSession(deps),
    handle(async (req, res) => {
      const kek = rt.kek;
      const pepper = rt.pepper;
      if (pepper === null || kek === null) {
        notConfigured(res);
        return;
      }
      const parsed = PasswordChange.safeParse(req.body);
      if (!parsed.success) {
        badRequest(res, parsed.error);
        return;
      }
      const me = currentSession(req);
      const account = await db.account.findUnique({ where: { id: me.accountId } });
      if (account === null || account.passwordHash === null || !account.totpEnabled || account.totpSecret === null) {
        // A D3 Auth-only account has no password here to change; it is D3 Auth's to manage.
        res.status(409).json({ error: 'no_password' });
        return;
      }
      const throttleKey = `password:${account.id}`;
      const ip = req.ip ?? 'unknown';
      const wait = rt.throttle.retryAfter(throttleKey, ip, nowMs());
      if (wait > 0) {
        logThrottled(req);
        res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
        res.status(429).json({ error: 'too_many_attempts', retryAfterSeconds: Math.ceil(wait / 1000) });
        return;
      }
      const { currentPassword, newPassword, code } = parsed.data;
      const passwordOk = await verifyPassword(account.passwordHash, currentPassword, pepper);
      const step = passwordOk ? matchStep(openTotpSecret(kek, account.totpSecret, account.id), code, rt.now()) : null;
      const problems = checkPassword(newPassword, { domain: rt.domain });
      if (passwordOk && step !== null && problems.length > 0) {
        weakPassword(res, problems);
        return;
      }
      const newHash = passwordOk && step !== null ? await hashPassword(newPassword, pepper) : null;
      const endOthers = parsed.data.endOtherSessions ?? true;
      const ended =
        newHash === null || step === null
          ? null
          : await db.$transaction(async (tx) => {
              if (!(await burnStep(tx, account.id, step))) return null;
              await tx.account.update({ where: { id: account.id }, data: { passwordHash: newHash } });
              const others = endOthers
                ? await tx.session.findMany({ where: { accountId: account.id, id: { not: me.sessionId } }, select: { id: true } })
                : [];
              await tx.session.deleteMany({ where: { id: { in: others.map((o) => o.id) } } });
              await recordAudit(tx, {
                actor: asAccount(account.id),
                action: 'auth.password.change',
                entityType: 'account',
                entityId: account.id,
                after: { endedSessions: others.map((o) => o.id) },
                context: getAuditContext(req),
              });
              return others.length;
            });
      if (ended === null) {
        rt.throttle.recordFailure(throttleKey, ip, nowMs());
        await recordAudit(db, {
          actor: asAccount(account.id),
          action: 'auth.password.change.rejected',
          entityType: 'account',
          entityId: account.id,
          after: { factor: passwordOk ? 'totp' : 'password' },
          context: getAuditContext(req),
        });
        res.status(401).json({ error: passwordOk ? 'invalid_code' : 'invalid_credentials' });
        return;
      }
      rt.throttle.clear(throttleKey, ip);
      res.json({ ok: true, endedSessions: ended });
    }),
  );

  // ─── Sign in with D3 Auth ────────────────────────────────────────────────

  router.get(
    '/oidc/start',
    handle(async (req, res) => {
      const client = await rt.oidc.get(nowMs());
      if (client === null || rt.sessionSecret === null) {
        res.redirect(302, signinError('Sign in with D3 Auth is not available right now. Use your password.'));
        return;
      }
      // Linking attaches the identity to whoever is signed in here already — never to an account
      // matched by email afterwards.
      let linkTo: string | undefined;
      if (req.query['link'] === '1') {
        const session = await sessionOf(rt, req);
        // Linking adds a way to sign in to this account, so it needs proof from the last five
        // minutes — a signed-in browser left open is not enough (ASVS 5.0 7.5.1).
        if (session !== null && !freshlyAuthenticated(rt, session)) {
          res.redirect(302, signinError('Sign in again to link D3 Auth to this account.', true));
          return;
        }
        linkTo = session?.accountId;
      }
      let start;
      try {
        start = await client.beginSignIn();
      } catch {
        rt.oidc.reset(nowMs());
        res.redirect(302, signinError('D3 Auth did not answer. Use your password.'));
        return;
      }
      const tx: OidcTransaction = {
        verifier: start.verifier,
        state: start.state,
        nonce: start.nonce,
        exp: nowMs() + TX_TTL_MS,
        ...(linkTo === undefined ? {} : { linkAccountId: linkTo }),
      };
      txCookie(rt, res, sealTransaction(rt.sessionSecret, tx), TX_TTL_MS);
      res.redirect(302, start.url);
    }),
  );

  router.get(
    '/oidc/callback',
    handle(async (req, res) => {
      res.clearCookie(txCookieName(rt.secure), { httpOnly: true, secure: rt.secure, sameSite: 'lax', path: '/' });
      const client = await rt.oidc.get(nowMs());
      if (client === null || rt.sessionSecret === null) {
        res.redirect(302, signinError('Sign in with D3 Auth is not available right now. Use your password.'));
        return;
      }
      const sealed = readCookie(req, txCookieName(rt.secure));
      const tx = sealed === null ? null : openTransaction(rt.sessionSecret, sealed);
      const state = typeof req.query['state'] === 'string' ? req.query['state'] : '';
      // This browser started it, it has not expired, and it is the sign-in it started. The SDK
      // checks state, nonce, PKCE and issuer; *which browser* is only knowable here.
      if (tx === null || tx.exp <= nowMs() || tx.state !== state) {
        await recordAudit(db, {
          actor: anonymous,
          action: 'auth.oidc.rejected',
          entityType: 'session',
          entityId: null,
          after: { reason: tx === null ? 'no_transaction' : tx.exp <= nowMs() ? 'expired' : 'state_mismatch' },
          context: getAuditContext(req),
        });
        res.redirect(302, signinError('That sign-in could not be completed. Start again.'));
        return;
      }

      let signedIn;
      try {
        signedIn = await client.completeSignIn(new URL(req.originalUrl, rt.webOrigin), tx);
      } catch (error) {
        await recordAudit(db, {
          actor: anonymous,
          action: 'auth.oidc.rejected',
          entityType: 'session',
          entityId: null,
          after: { reason: error instanceof Error ? error.message.slice(0, 300) : 'exchange_failed' },
          context: getAuditContext(req),
        });
        res.redirect(302, signinError('D3 Auth did not complete the sign-in. Try again, or use your password.'));
        return;
      }

      const { identity } = signedIn;
      const email = typeof identity.claims['email'] === 'string' ? identity.claims['email'] : undefined;
      const name = typeof identity.claims['name'] === 'string' ? identity.claims['name'] : undefined;
      try {
        const session = await db.$transaction(async (dbtx) => {
          const resolved = await resolveIdentity(
            dbtx,
            {
              iss: identity.iss,
              sub: identity.sub,
              roles: identity.roles,
              ...(email === undefined ? {} : { email }),
              ...(name === undefined ? {} : { name }),
              ...(tx.linkAccountId === undefined ? {} : { linkAccountId: tx.linkAccountId }),
            },
            rt.now(),
          );
          const account = await dbtx.account.findUniqueOrThrow({ where: { id: resolved.accountId } });
          if (account.disabledAt !== null) return null;
          await endPresentedSession(rt, dbtx, req);
          const issued = await issueSession(
            dbtx,
            account.id,
            { method: 'oidc', roles: identity.roles, iss: identity.iss, sub: identity.sub },
            req,
            rt.now(),
          );
          await recordAudit(dbtx, {
            actor: asAccount(account.id),
            action: resolved.outcome === 'linked' ? 'auth.identity.link' : 'auth.signin',
            entityType: resolved.outcome === 'linked' ? 'identity_link' : 'session',
            entityId: issued.id,
            after: {
              method: 'oidc',
              issuer: identity.iss,
              subject: identity.sub,
              outcome: resolved.outcome,
              roles: identity.roles,
            },
            context: getAuditContext(req),
          });
          return issued;
        });
        if (session === null) {
          res.redirect(302, signinError('This account is disabled.'));
          return;
        }
        setSessionCookie(res, session.token, rt.secure);
        res.redirect(302, '/');
      } catch (error) {
        if (error instanceof IdentityCollision) {
          await recordAudit(db, {
            actor: anonymous,
            action: 'auth.oidc.rejected',
            entityType: 'identity_link',
            entityId: null,
            after: { reason: 'email_collision', issuer: identity.iss, subject: identity.sub, email: email ?? null },
            context: getAuditContext(req),
          });
          res.redirect(302, signinError(error.message, true));
          return;
        }
        throw error;
      }
    }),
  );

  // Back-channel logout: D3 Auth posts a signed logout token; every session this (iss, sub) signed
  // in with D3 Auth ends. Idempotent by jti, because the provider retries delivery.
  const seen = inMemorySeen();
  router.post(
    '/oidc/backchannel-logout',
    express.urlencoded({ extended: false, limit: '64kb' }),
    handle(async (req, res) => {
      const settings = rt.oidc.settings;
      if (settings === null) {
        res.status(404).json({ error: 'not_configured' });
        return;
      }
      const body = req.body as Record<string, unknown> | undefined;
      const token = typeof body?.['logout_token'] === 'string' ? body['logout_token'] : '';
      let logout: VerifiedLogout;
      try {
        logout = await verifyLogoutToken(token, { issuer: settings.issuer, clientId: settings.clientId });
      } catch (error) {
        res.status(400).json({
          error: 'invalid_logout_token',
          reason: error instanceof LogoutTokenError ? error.reason : 'invalid',
        });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      const repeated = seen.has(logout.jti);
      seen.add(logout.jti);
      const ended = await endSessionsFor(db, settings.issuer, logout, repeated, getAuditContext(req));
      res.json({ ok: true, ended, repeated });
    }),
  );

  return router;
}

async function endSessionsFor(
  db: Db,
  issuer: string,
  logout: VerifiedLogout,
  repeated: boolean,
  context: ReturnType<typeof getAuditContext>,
): Promise<number> {
  return db.$transaction(async (tx) => {
    const link = await tx.identityLink.findUnique({
      where: { issuer_subject: { issuer, subject: logout.sub } },
    });
    const ended: string[] = [];
    if (!repeated) {
      // Only the sessions this (iss, sub) signed in with D3 Auth — never a password session of the
      // same account.
      const sessions = await tx.session.findMany({
        where: { method: 'oidc', oidcIssuer: issuer, oidcSubject: logout.sub },
        select: { id: true },
      });
      for (const s of sessions) {
        await deleteSession(tx, s.id);
        ended.push(s.id);
      }
    }
    await recordAudit(tx, {
      actor: { kind: 'service', label: 'd3auth-backchannel' },
      action: 'auth.oidc.backchannel-logout',
      entityType: 'session',
      entityId: link?.accountId ?? null,
      after: { subject: logout.sub, jti: logout.jti, ended, repeated },
      context,
    });
    return ended.length;
  });
}
