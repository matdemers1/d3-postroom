// The D3 App contract for native clients (PST-P-19): the manifest, and native sessions in JSON.
//
// D3 Constellation signs in here without a browser. The steps and the protections are the web
// sign-in's — the same throttles, attempt caps, one-check-in-flight rule, decoy hashing and audit
// actions — and what differs is the envelope: tokens come back in JSON rather than a cookie, a
// recovery code is followed by a new authenticator inside the sign-in itself (CON-ADR-014), and
// every refusal is problem+json with the contract's registered type.
import { randomBytes } from 'node:crypto';
import { getAuditContext, recordAudit } from '@postroom/audit';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ApiDeps } from '../deps.js';
import { handle } from './middleware.js';
import { looksLikeProviderToken, materializeD3AuthSession, resourceOf, verifyD3AuthToken } from './d3auth-bearer.js';
import { bearerOf, issueNativeSession, rotateNativeSession, type Device } from './native-sessions.js';
import { LinkedElsewhere, resolveIdentity } from './oidc.js';
import { decoyHash, verifyPassword } from './passwords.js';
import { formatRecoveryCode, generateRecoveryCodes, hashRecoveryCodes, matchRecoveryCode, normalizeRecoveryCode, spendRecoveryCode } from './recovery.js';
import { ANY_LOGIN, anonymous, asAccount, endOtherSessions, findByLogin, logThrottled, primaryAddress, replaceAuthenticator } from './routes.js';
import { CHALLENGE_TTL_MS, MAX_CODE_ATTEMPTS, REENROL_TTL_MS, runtimeFor, type AuthRuntime } from './runtime.js';
import { deleteSession, resolveSession } from './sessions.js';
import { burnStep, generateTotpSecret, matchStep, openTotpSecret, provisioningUri, sealTotpSecret } from './totp.js';

/** What D3 Constellation may show for this server; a client shows a feature only when it is listed. */
export const CAPABILITIES = ['postroom.mail', 'postroom.compose', 'postroom.search', 'postroom.events', 'postroom.admin'];

const PROBLEMS = 'https://d3cloud.io/problems/';

/** RFC 9457: the contract's registered `name`, or about:blank when none fits. */
function problem(res: Response, status: number, name: string | null, title: string, extra: Record<string, unknown> = {}): void {
  res.status(status).type('application/problem+json').send(JSON.stringify({ type: name === null ? 'about:blank' : `${PROBLEMS}${name}`, title, status, ...extra }));
}

function throttled(res: Response, waitMs: number): void {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  res.setHeader('Retry-After', String(seconds));
  problem(res, 429, 'throttled', 'Too many attempts', { detail: `Try again in ${seconds} seconds.`, retryAfter: seconds });
}

const DeviceShape = z.object({ name: z.string().trim().min(1).max(120), platform: z.string().trim().min(1).max(40) });
const SignIn = z.union([
  z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024), device: DeviceShape.optional() }),
  z.object({ challenge: z.string().min(1).max(200), totp: z.string().min(1).max(64) }),
  z.object({ challenge: z.string().min(1).max(200), recoveryCode: z.string().min(1).max(64) }),
  z.object({ challenge: z.string().min(1).max(200), enrolTotp: z.string().min(1).max(64) }),
]);
const Refresh = z.object({ refreshToken: z.string().min(1).max(200) });
const Link = z.union([
  z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024), totp: z.string().min(1).max(64), recoveryCode: z.undefined().optional() }),
  z.object({ email: z.string().min(1).max(320), password: z.string().min(1).max(1024), recoveryCode: z.string().min(1).max(64), totp: z.undefined().optional() }),
]);

function tokensBody(tokens: { sessionId: string; accessToken: string; refreshToken: string; expiresIn: number }): Record<string, unknown> {
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresIn: tokens.expiresIn, session: { id: tokens.sessionId } };
}

/** The manifest (PST-T-19.1), served unauthenticated at /.well-known/d3-app.json. */
export function manifestRoute(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const router = Router();
  router.get(
    '/.well-known/d3-app.json',
    handle(async (_req, res) => {
      const base = resourceOf(deps.config.webOrigin);
      await rt.oidc.ready();
      // D3 Auth is offered only while it is configured here (PST-T-19.3); its tokens name this
      // origin as their resource.
      const issuer = rt.oidc.settings?.issuer ?? null;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        product: 'postroom',
        name: 'Postroom',
        version: process.env['POSTROOM_VERSION'] ?? '0.0.0',
        revision: process.env['POSTROOM_COMMIT'] ?? null,
        contract: 1,
        capabilities: CAPABILITIES,
        signIn: {
          methods: issuer === null ? ['password', 'totp', 'recovery_code'] : ['password', 'totp', 'recovery_code', 'd3auth'],
          ...(issuer === null ? {} : { d3auth: { issuer, resource: base } }),
        },
        endpoints: {
          nativeSignIn: `${base}/api/auth/native/signin`,
          nativeRefresh: `${base}/api/auth/native/refresh`,
          nativeRevoke: `${base}/api/auth/native/revoke`,
          me: `${base}/api/auth/native/me`,
          link: issuer === null ? null : `${base}/api/auth/native/link`,
          inviteAccept: null,
          deleteAccount: null,
          relayRegister: `${base}/api/push/native/register`,
        },
      });
    }),
  );
  return router;
}

export function nativeRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();
  const nowMs = (): number => rt.now().getTime();

  router.post(
    '/signin',
    handle(async (req, res) => {
      if (rt.pepper === null || rt.kek === null) {
        problem(res, 503, null, 'Sign-in is not configured on this server');
        return;
      }
      const parsed = SignIn.safeParse(req.body);
      if (!parsed.success) {
        problem(res, 400, null, 'That request is not a sign-in');
        return;
      }
      const body = parsed.data;
      if ('email' in body) await passwordStep(rt, req, res, body.email, body.password, body.device ?? null);
      else if ('enrolTotp' in body) await enrolStep(rt, req, res, body.challenge, body.enrolTotp);
      else await codeStep(rt, req, res, body.challenge, 'totp' in body ? body.totp : null, 'recoveryCode' in body ? body.recoveryCode : null);
    }),
  );

  router.post(
    '/refresh',
    handle(async (req, res) => {
      const parsed = Refresh.safeParse(req.body);
      if (!parsed.success) {
        problem(res, 400, null, 'That request is not a refresh');
        return;
      }
      const rotation = await rotateNativeSession(db, parsed.data.refreshToken, rt.now());
      if (rotation.kind === 'ended') {
        problem(res, 401, 'session_revoked', 'This sign-in has ended');
        return;
      }
      if (rotation.kind === 'reused') {
        // A rotated token came back: it leaked, or a client replayed it. The session ends.
        await db.$transaction(async (tx) => {
          const ended = await deleteSession(tx, rotation.sessionId);
          await recordAudit(tx, {
            actor: asAccount(rotation.accountId),
            action: 'auth.native.refresh_reused',
            entityType: 'session',
            entityId: rotation.sessionId,
            before: ended === null ? null : { createdAt: ended.createdAt },
            after: { ended: true },
            context: getAuditContext(req),
          });
        });
        problem(res, 401, 'refresh_reused', 'This sign-in was used twice and has been ended');
        return;
      }
      await recordAudit(db, {
        actor: asAccount(rotation.accountId),
        action: 'auth.native.refresh',
        entityType: 'session',
        entityId: rotation.tokens.sessionId,
        after: { rotated: true },
        context: getAuditContext(req),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ accessToken: rotation.tokens.accessToken, refreshToken: rotation.tokens.refreshToken, expiresIn: rotation.tokens.expiresIn });
    }),
  );

  router.post(
    '/revoke',
    handle(async (req, res) => {
      const token = bearerOf(req);
      const session = token === null ? null : await resolveSession(db, token, rt.now(), 'bearer');
      if (session === null) {
        problem(res, 401, 'session_revoked', 'This sign-in has ended');
        return;
      }
      await db.$transaction(async (tx) => {
        await deleteSession(tx, session.sessionId);
        await recordAudit(tx, {
          actor: asAccount(session.accountId),
          action: 'auth.signout',
          entityType: 'session',
          entityId: session.sessionId,
          after: { via: 'native' },
          context: getAuditContext(req),
        });
      });
      res.status(204).end();
    }),
  );

  router.get(
    '/me',
    handle(async (req, res) => {
      const token = bearerOf(req);
      let session = token === null ? null : await resolveSession(db, token, rt.now(), 'bearer');
      if (session === null && token !== null && looksLikeProviderToken(token)) {
        // A D3 Auth token (PST-T-19.3): linked, it becomes a session; unlinked, the app links it once.
        const outcome = await materializeD3AuthSession(rt, token, resourceOf(deps.config.webOrigin), req, getAuditContext(req));
        if (outcome === 'unlinked') {
          problem(res, 401, 'identity_not_linked', 'Link this D3 Auth account to Postroom first');
          return;
        }
        if (outcome === 'session') session = await resolveSession(db, token, rt.now(), 'bearer');
      }
      if (session === null) {
        problem(res, 401, 'session_revoked', 'Sign in again');
        return;
      }
      res.json({
        accountId: session.accountId,
        email: (await primaryAddress(db, session.accountId)) ?? '',
        displayName: session.displayName,
        roles: session.isAdmin ? ['admin'] : ['member'],
      });
    }),
  );

  router.post(
    '/link',
    handle(async (req, res) => {
      const parsed = Link.safeParse(req.body);
      if (!parsed.success) {
        problem(res, 400, null, 'That request is not a link');
        return;
      }
      await link(rt, req, res, parsed.data);
    }),
  );

  /**
   * Link the D3 Auth identity in the Bearer token to a Postroom account, once (PST-T-19.3). The
   * account is proven with its own password and second factor, throttled exactly as a sign-in is —
   * a link is a sign-in that leaves a lasting connection behind. Never by email (PST-REQ-005).
   */
  async function link(rt: AuthRuntime, req: Request, res: Response, body: z.infer<typeof Link>): Promise<void> {
    const pepper = rt.pepper;
    const kek = rt.kek;
    if (pepper === null || kek === null) {
      problem(res, 503, null, 'Sign-in is not configured on this server');
      return;
    }
    const token = bearerOf(req);
    const verified = token === null ? null : await verifyD3AuthToken(rt, token, resourceOf(deps.config.webOrigin));
    if (verified === null) {
      problem(res, 401, 'session_revoked', "This D3 Auth sign-in isn't valid here");
      return;
    }
    const login = body.email;
    const ip = req.ip ?? 'unknown';
    const wait = Math.max(rt.throttle.retryAfter(login, ip, nowMs()), rt.ipThrottle.retryAfter(ANY_LOGIN, ip, nowMs()));
    if (wait > 0) {
      logThrottled(req);
      throttled(res, wait);
      return;
    }
    const refuse = async (name: 'invalid_credentials' | 'invalid_code', accountId: string | null): Promise<void> => {
      rt.throttle.recordFailure(login, ip, nowMs());
      rt.ipThrottle.recordFailure(ANY_LOGIN, ip, nowMs());
      await recordAudit(db, {
        actor: anonymous,
        action: 'auth.signin.rejected',
        entityType: 'account',
        entityId: accountId,
        after: { login, factor: name === 'invalid_credentials' ? 'password' : body.recoveryCode === undefined ? 'totp' : 'recovery_code', via: 'native-link' },
        context: getAuditContext(req),
      });
      problem(res, 401, name, name === 'invalid_credentials' ? 'Email or password is wrong' : "That code didn't work");
    };

    const account = await findByLogin(db, login);
    const usable = account !== null && account.passwordHash !== null && account.disabledAt === null;
    let ok = false;
    if (usable) ok = await verifyPassword(account.passwordHash ?? '', body.password, pepper);
    else await verifyPassword(await decoyHash(pepper), body.password, pepper);
    if (!ok || account === null) {
      await refuse('invalid_credentials', account?.id ?? null);
      return;
    }
    if (!account.totpEnabled || account.totpSecret === null) {
      problem(res, 403, null, 'This account has no authenticator yet', { detail: 'Finish setting it up in the web app first.' });
      return;
    }

    const at = rt.now();
    const context = getAuditContext(req);
    // The second factor, spent inside the transaction that writes the link: a code that links
    // nothing is not burned, and a link is never written on a code that was not.
    let recoveryCodeId: string | null = null;
    let step: number | null = null;
    if (body.recoveryCode !== undefined) {
      const normalized = normalizeRecoveryCode(body.recoveryCode);
      if (normalized !== null) {
        const unused = await db.recoveryCode.findMany({
          where: { accountId: account.id, usedAt: null },
          select: { id: true, codeHash: true },
          orderBy: { createdAt: 'asc' },
        });
        recoveryCodeId = await matchRecoveryCode(unused, normalized, pepper);
      }
      if (recoveryCodeId === null) {
        await refuse('invalid_code', account.id);
        return;
      }
    } else {
      step = matchStep(openTotpSecret(kek, account.totpSecret, account.id), body.totp, at);
      if (step === null) {
        await refuse('invalid_code', account.id);
        return;
      }
    }

    type Outcome = 'linked' | 'code' | 'elsewhere';
    const outcome: Outcome = await db
      .$transaction(async (tx): Promise<Outcome> => {
        if (step !== null && !(await burnStep(tx, account.id, step, account.totpSecret ?? undefined))) return 'code';
        if (recoveryCodeId !== null) {
          if (!(await spendRecoveryCode(tx, account.id, recoveryCodeId, at))) return 'code';
          await recordAudit(tx, {
            actor: asAccount(account.id),
            action: 'auth.recovery-code.use',
            entityType: 'recovery_code',
            entityId: recoveryCodeId,
            before: { usedAt: null },
            after: { usedAt: at, via: 'native-link' },
            context,
          });
        }
        const resolved = await resolveIdentity(
          tx,
          { iss: verified.issuer, sub: verified.subject, roles: verified.roles, ...(verified.email === null ? {} : { email: verified.email }), linkAccountId: account.id },
          at,
        );
        await recordAudit(tx, {
          actor: asAccount(account.id),
          action: 'auth.identity.link',
          entityType: 'identity_link',
          entityId: null,
          after: { issuer: verified.issuer, subject: verified.subject, outcome: resolved.outcome, via: 'native-link', ...(resolved.moved === undefined ? {} : { movedFrom: resolved.moved.from }) },
          context,
        });
        return 'linked';
      })
      .catch((error: unknown) => {
        if (error instanceof LinkedElsewhere) return 'elsewhere' as const;
        throw error;
      });
    if (outcome === 'code') {
      await refuse('invalid_code', account.id);
      return;
    }
    if (outcome === 'elsewhere') {
      problem(res, 409, null, 'This D3 Auth account is linked to another Postroom account', { detail: 'Unlink it there first.' });
      return;
    }
    rt.throttle.clear(login, ip);
    res.json({ linked: true, accountId: account.id });
  }

  /** Email (the account's address, or its login) and password, then a challenge for the code. */
  async function passwordStep(rt: AuthRuntime, req: Request, res: Response, login: string, password: string, device: Device | null): Promise<void> {
    const pepper = rt.pepper ?? '';
    const ip = req.ip ?? 'unknown';
    const wait = Math.max(rt.throttle.retryAfter(login, ip, nowMs()), rt.ipThrottle.retryAfter(ANY_LOGIN, ip, nowMs()));
    if (wait > 0) {
      logThrottled(req);
      throttled(res, wait);
      return;
    }
    const account = await findByLogin(db, login);
    const usable = account !== null && account.passwordHash !== null && account.disabledAt === null;
    let ok = false;
    if (usable) ok = await verifyPassword(account.passwordHash ?? '', password, pepper);
    else await verifyPassword(await decoyHash(pepper), password, pepper);
    if (!ok || account === null) {
      rt.throttle.recordFailure(login, ip, nowMs());
      rt.ipThrottle.recordFailure(ANY_LOGIN, ip, nowMs());
      await recordAudit(db, {
        actor: anonymous,
        action: 'auth.signin.rejected',
        entityType: 'account',
        entityId: account?.id ?? null,
        after: { login, factor: 'password', via: 'native' },
        context: getAuditContext(req),
      });
      problem(res, 401, 'invalid_credentials', 'Email or password is wrong');
      return;
    }
    if (!account.totpEnabled || account.totpSecret === null) {
      await recordAudit(db, {
        actor: asAccount(account.id),
        action: 'auth.signin.rejected',
        entityType: 'account',
        entityId: account.id,
        after: { login, factor: 'totp', reason: 'not_enrolled', via: 'native' },
        context: getAuditContext(req),
      });
      problem(res, 403, null, 'This account has no authenticator yet', { detail: 'Finish setting it up in the web app first.' });
      return;
    }
    const challenge = randomBytes(32).toString('base64url');
    rt.challenges.set(challenge, {
      accountId: account.id,
      login,
      exp: nowMs() + CHALLENGE_TTL_MS,
      attempts: 0,
      checking: false,
      ...(device === null ? {} : { device }),
    });
    await recordAudit(db, {
      actor: asAccount(account.id),
      action: 'auth.signin.password_accepted',
      entityType: 'account',
      entityId: account.id,
      after: { login, next: 'totp', via: 'native' },
      context: getAuditContext(req),
    });
    res.status(202).json({ next: 'totp', challenge });
  }

  /** The code: a TOTP code gives the session; a recovery code gives a new authenticator to enrol. */
  async function codeStep(rt: AuthRuntime, req: Request, res: Response, challengeId: string, totp: string | null, recovery: string | null): Promise<void> {
    const kek = rt.kek;
    const pepper = rt.pepper;
    if (kek === null || pepper === null) return;
    const pending = rt.challenges.get(challengeId, nowMs());
    if (pending === undefined) {
      problem(res, 401, 'invalid_code', 'This sign-in has expired', { detail: 'Start again with your email and password.' });
      return;
    }
    const ip = req.ip ?? 'unknown';
    const wait = rt.throttle.retryAfter(pending.login, ip, nowMs());
    if (wait > 0 || pending.checking) {
      logThrottled(req);
      throttled(res, Math.max(wait, 1000));
      return;
    }
    // Claimed before anything slow, as on the web: one check in flight, the attempt counted now.
    pending.checking = true;
    pending.attempts += 1;
    if (pending.attempts >= MAX_CODE_ATTEMPTS) rt.challenges.delete(challengeId);
    rt.throttle.recordFailure(pending.login, ip, nowMs());
    const recoveryCode = recovery === null ? null : normalizeRecoveryCode(recovery);
    try {
      const account = await db.account.findUnique({ where: { id: pending.accountId } });
      if (account !== null && recoveryCode !== null) {
        const unused = await db.recoveryCode.findMany({
          where: { accountId: account.id, usedAt: null },
          select: { id: true, codeHash: true },
          orderBy: { createdAt: 'asc' },
        });
        const codeId = await matchRecoveryCode(unused, recoveryCode, pepper);
        const spent =
          codeId !== null &&
          (await db.$transaction(async (tx) => {
            const at = rt.now();
            if (!(await spendRecoveryCode(tx, account.id, codeId, at))) return false;
            const remaining = await tx.recoveryCode.count({ where: { accountId: account.id, usedAt: null } });
            await recordAudit(tx, {
              actor: asAccount(account.id),
              action: 'auth.recovery-code.use',
              entityType: 'recovery_code',
              entityId: codeId,
              before: { usedAt: null },
              after: { usedAt: at, remaining, via: 'native' },
              context: getAuditContext(req),
            });
            return true;
          }));
        if (spent) {
          // The authenticator is lost or taken: a new one is enrolled before any session exists
          // (CON-ADR-014). A fresh challenge carries it; the old one is finished.
          rt.challenges.delete(challengeId);
          rt.throttle.clear(pending.login, ip);
          const next = randomBytes(32).toString('base64url');
          const secret = generateTotpSecret();
          rt.nativeReenrols.set(next, {
            accountId: account.id,
            login: pending.login,
            secret,
            exp: nowMs() + REENROL_TTL_MS,
            attempts: 0,
            checking: false,
            ...(pending.device === undefined ? {} : { device: pending.device }),
          });
          const address = (await primaryAddress(db, account.id)) ?? account.displayName;
          res.setHeader('Cache-Control', 'no-store');
          problem(res, 403, 'reenrol_required', 'Set up a new authenticator', {
            challenge: next,
            enrolment: { secret, otpauthUri: provisioningUri(secret, address), digits: 6, period: 30 },
          });
          return;
        }
      } else if (account !== null && totp !== null) {
        const secret = account.totpSecret === null ? null : openTotpSecret(kek, account.totpSecret, account.id);
        const step = secret === null ? null : matchStep(secret, totp, rt.now());
        const issued =
          step === null
            ? null
            : await db.$transaction(async (tx) => {
                if (!(await burnStep(tx, account.id, step, account.totpSecret ?? undefined))) return null;
                const tokens = await issueNativeSession(tx, account.id, { method: 'password', roles: [], secondFactor: 'totp' }, pending.device ?? null, req, rt.now());
                await recordAudit(tx, {
                  actor: asAccount(account.id),
                  action: 'auth.signin',
                  entityType: 'session',
                  entityId: tokens.sessionId,
                  after: { method: 'password', factor: 'totp', accountId: account.id, via: 'native', device: pending.device?.name ?? null },
                  context: getAuditContext(req),
                });
                return tokens;
              });
        if (issued !== null) {
          rt.challenges.delete(challengeId);
          rt.throttle.clear(pending.login, ip);
          rt.ipThrottle.clear(ANY_LOGIN, ip);
          res.setHeader('Cache-Control', 'no-store');
          res.json(tokensBody(issued));
          return;
        }
      }
    } finally {
      pending.checking = false;
    }
    await recordAudit(db, {
      actor: anonymous,
      action: 'auth.signin.rejected',
      entityType: 'account',
      entityId: pending.accountId,
      after: { login: pending.login, factor: recovery === null ? 'totp' : 'recovery_code', attempts: pending.attempts, via: 'native' },
      context: getAuditContext(req),
    });
    problem(res, 401, 'invalid_code', "That code didn't work");
  }

  /** The new authenticator's first code: it, the recovery codes and the session, written together. */
  async function enrolStep(rt: AuthRuntime, req: Request, res: Response, challengeId: string, code: string): Promise<void> {
    const kek = rt.kek;
    const pepper = rt.pepper;
    if (kek === null || pepper === null) return;
    const pending = rt.nativeReenrols.get(challengeId, nowMs());
    if (pending === undefined) {
      problem(res, 401, 'invalid_code', 'This sign-in has expired', { detail: 'Start again with your email and password.' });
      return;
    }
    const throttleKey = `reenrol:${pending.accountId}`;
    const ip = req.ip ?? 'unknown';
    const wait = rt.throttle.retryAfter(throttleKey, ip, nowMs());
    if (wait > 0 || pending.checking) {
      logThrottled(req);
      throttled(res, Math.max(wait, 1000));
      return;
    }
    pending.checking = true;
    pending.attempts += 1;
    try {
      const step = matchStep(pending.secret, code, rt.now());
      if (step === null) {
        if (pending.attempts >= MAX_CODE_ATTEMPTS) rt.nativeReenrols.delete(challengeId);
        rt.throttle.recordFailure(throttleKey, ip, nowMs());
        await recordAudit(db, {
          actor: asAccount(pending.accountId),
          action: 'auth.totp.reenrol.rejected',
          entityType: 'account',
          entityId: pending.accountId,
          after: { attempts: pending.attempts, via: 'native' },
          context: getAuditContext(req),
        });
        // The challenge stays valid for another try, as the contract says.
        problem(res, 401, 'invalid_code', "That code didn't work");
        return;
      }
      const codes = generateRecoveryCodes();
      const hashes = await hashRecoveryCodes(codes, pepper);
      const at = rt.now();
      const sealed = sealTotpSecret(kek, pending.secret, pending.accountId);
      const tokens = await db.$transaction(async (tx) => {
        const context = getAuditContext(req);
        await replaceAuthenticator(tx, { accountId: pending.accountId, sealed, step, hashes, at, context });
        const issued = await issueNativeSession(tx, pending.accountId, { method: 'password', roles: [], secondFactor: 'totp' }, pending.device ?? null, req, at);
        await recordAudit(tx, {
          actor: asAccount(pending.accountId),
          action: 'auth.signin',
          entityType: 'session',
          entityId: issued.sessionId,
          after: { method: 'password', factor: 'recovery_code', reenrolled: true, via: 'native', device: pending.device?.name ?? null },
          context,
        });
        // A recovery-code sign-in means the authenticator was lost or taken: every other session
        // ends, as the web re-enrolment does (PST-T-16.28).
        await endOtherSessions(tx, pending.accountId, issued.sessionId, context, 'reenrol');
        return issued;
      });
      rt.nativeReenrols.delete(challengeId);
      rt.throttle.clear(throttleKey, ip);
      rt.throttle.clear(pending.login, ip);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ ...tokensBody(tokens), recoveryCodes: codes.map(formatRecoveryCode) });
    } finally {
      pending.checking = false;
    }
  }

  return router;
}
