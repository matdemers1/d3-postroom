import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApiDeps } from '../deps.js';
import { runtimeFor, STEP_UP_MS, type AuthRuntime } from './runtime.js';
import { readCookie, resolveSession, SESSION_COOKIE, type ResolvedSession } from './sessions.js';

// The session a request carries, resolved at most once per request.
const loaded = new WeakMap<Request, ResolvedSession | null>();

export async function sessionOf(rt: AuthRuntime, req: Request): Promise<ResolvedSession | null> {
  if (loaded.has(req)) return loaded.get(req) ?? null;
  const token = readCookie(req, SESSION_COOKIE);
  const session = token === null ? null : await resolveSession(rt.db, token, rt.now());
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
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  });
}

/** Destructive admin actions need a second factor within the last five minutes (PST-REQ-008). */
export function requireStepUp(deps: ApiDeps): RequestHandler {
  const rt = runtimeFor(deps);
  return handle(async (req, res, next) => {
    const session = await sessionOf(rt, req);
    if (session === null) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const at = session.stepUpAt;
    const age = at === null ? Infinity : rt.now().getTime() - at.getTime();
    if (!(age >= 0 && age <= STEP_UP_MS)) {
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
    if (req.get('x-postroom-csrf') === '1' || req.get('origin') === origin) {
      next();
      return;
    }
    res.status(403).json({ error: 'csrf' });
  };
}
