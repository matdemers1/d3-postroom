import { getAuditContext, recordAudit } from '@postroom/audit';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApiDeps } from '../deps.js';
import { runtimeFor, STEP_UP_MS, type AuthRuntime } from './runtime.js';
import { looksLikeProviderToken, materializeD3AuthSession, resourceOf } from './d3auth-bearer.js';
import { bearerOf } from './native-sessions.js';
import { readCookie, resolveSession, sessionCookieName, type ResolvedSession } from './sessions.js';

// The session a request carries, resolved at most once per request.
const loaded = new WeakMap<Request, ResolvedSession | null>();

export async function sessionOf(rt: AuthRuntime, req: Request): Promise<ResolvedSession | null> {
  if (loaded.has(req)) return loaded.get(req) ?? null;
  // The browser's cookie, or a native client's Bearer access token (PST-T-19.3) — each resolving only
  // its own kind of session.
  const cookie = readCookie(req, sessionCookieName(rt.secure));
  const bearer = cookie === null ? bearerOf(req) : null;
  let session =
    cookie !== null
      ? await resolveSession(rt.db, cookie, rt.now(), 'cookie')
      : bearer !== null
        ? await resolveSession(rt.db, bearer, rt.now(), 'bearer')
        : null;
  // A D3 Auth access token seen for the first time becomes a session row of its own (PST-T-19.3).
  if (session === null && bearer !== null && looksLikeProviderToken(bearer)) {
    const outcome = await materializeD3AuthSession(rt, bearer, resourceOf(rt.webOrigin), req, getAuditContext(req));
    if (outcome === 'session') session = await resolveSession(rt.db, bearer, rt.now(), 'bearer');
  }
  loaded.set(req, session);
  return session;
}

/** The session a guard already resolved. Only valid behind requireSession/requireAdmin. */
export function currentSession(req: Request): ResolvedSession {
  const session = loaded.get(req);
  if (session === undefined || session === null) throw new Error('no session: mount requireSession first');
  return session;
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * A refused authorization is audited (ASVS 5.0 16.3.2): who, which route, why. Best effort — a
 * failed write is reported on stderr and never turns a 403 into a 500.
 */
export async function recordDenied(rt: AuthRuntime, req: Request, accountId: string, reason: string): Promise<void> {
  try {
    await recordAudit(rt.db, {
      actor: { kind: 'account', accountId },
      action: 'authz.denied',
      entityType: 'route',
      entityId: null,
      after: { method: req.method, path: req.baseUrl + req.path, reason },
      context: getAuditContext(req),
    });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'authz-denied-unrecorded', reason, error: error instanceof Error ? error.message : String(error) })}\n`);
  }
}

/** Express 5 forwards a rejected promise to the error handler; this makes that explicit and typed. */
export function handle(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function requireSession(deps: ApiDeps): RequestHandler {
  const rt = runtimeFor(deps);
  return handle(async (req, res, next) => {
    if ((await sessionOf(rt, req)) === null) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    next();
  });
}

/**
 * Admin screens and every /api/admin route (PST-REQ-007): the native `is_admin` flag, or the D3 Auth
 * roles claim for this client holding 'admin' at sign-in. 401 with no session, 403 without the role.
 */
export function requireAdmin(deps: ApiDeps): RequestHandler {
  const rt = runtimeFor(deps);
  return handle(async (req, res, next) => {
    const session = await sessionOf(rt, req);
    if (session === null) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (!session.isAdmin) {
      await recordDenied(rt, req, session.accountId, 'not_admin');
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  });
}

/**
 * A session that signed in with a recovery code has no authenticator to step up with until it
 * enrols a new one (PST-REQ-200). Answers 403 totp_reenrol_required, audited, and returns true
 * when it did.
 */
export async function refuseUntilReenrolled(rt: AuthRuntime, req: Request, res: Response, session: ResolvedSession): Promise<boolean> {
  if (!session.reenrolRequired) return false;
  await recordDenied(rt, req, session.accountId, 'totp_reenrol_required');
  res.status(403).json({ error: 'totp_reenrol_required' });
  return true;
}

/**
 * Destructive admin actions need a second factor within the last five minutes (PST-REQ-008) — and
 * a recovery-code session must re-enrol its authenticator first (PST-REQ-200).
 */
export function requireStepUp(deps: ApiDeps): RequestHandler {
  const rt = runtimeFor(deps);
  return handle(async (req, res, next) => {
    const session = await sessionOf(rt, req);
    if (session === null) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    if (await refuseUntilReenrolled(rt, req, res, session)) return;
    const at = session.stepUpAt;
    const age = at === null ? Infinity : rt.now().getTime() - at.getTime();
    if (!(age >= 0 && age <= STEP_UP_MS)) {
      await recordDenied(rt, req, session.accountId, 'step_up_required');
      res.status(403).json({ error: 'step_up_required' });
      return;
    }
    next();
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Server-to-server from D3 Auth: no browser, no cookie, authenticated by its signed logout token. */
const CSRF_EXEMPT = new Set(['/auth/oidc/backchannel-logout']);

/**
 * CSRF, for everything under /api: a state-changing request must carry `x-postroom-csrf: 1` (a
 * header no cross-site form can set, and a cross-site fetch cannot send without a preflight this
 * server never answers) or an Origin equal to our own. SameSite=Lax is the second layer.
 */
export function csrfGuard(deps: ApiDeps): RequestHandler {
  const origin = new URL(deps.config.webOrigin).origin;
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || CSRF_EXEMPT.has(req.path)) {
      next();
      return;
    }
    // The native routes (PST-P-19) never read a cookie and never set one: tokens go out in the
    // body and come back as a Bearer header. A forged request there has no ambient credential to
    // spend, and a forged sign-in hands its tokens to the forger's own page, never to a victim.
    if (req.path.startsWith('/auth/native/')) {
      next();
      return;
    }
    // A native client (PST-T-19.3): a Bearer token and no cookie. CSRF is a browser riding its own
    // ambient cookie; a request that carries no cookie has nothing ambient to ride, and a page on
    // another site cannot attach somebody's Bearer token.
    if (bearerOf(req) !== null && req.headers.cookie === undefined) {
      next();
      return;
    }
    if (req.get('x-postroom-csrf') === '1' || req.get('origin') === origin) {
      next();
      return;
    }
    // A cross-site state change is an attempt to get past a control (ASVS 5.0 16.3.3). Logged, not
    // audited: anyone on the internet can send one, and the audit table is not theirs to fill.
    process.stderr.write(
      `${JSON.stringify({ event: 'csrf-refused', method: req.method, path: req.originalUrl.split('?')[0], origin: req.get('origin') ?? null, ip: req.ip ?? null })}\n`,
    );
    res.status(403).json({ error: 'csrf' });
  };
}
