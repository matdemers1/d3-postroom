// Dual login (PST-T-0.8): app-native Argon2id + pepper + TOTP beside Sign in with D3 Auth, the
// one-time setup screen, the admin gate and step-up. app.ts mounts these.
import type { RequestHandler } from 'express';
import type { ApiDeps } from '../deps.js';
import { handle } from './middleware.js';
import { runtimeFor } from './runtime.js';
import { isSetupRequired } from './setup.js';

export { authRoutes } from './routes.js';
export { adminRoutes } from './admin.js';
export { csrfGuard, requireAdmin, requireSession, requireStepUp, currentSession } from './middleware.js';
export { runtimeFor, STEP_UP_MS } from './runtime.js';
export { isSetupRequired } from './setup.js';
export { OidcProvider, resolveIdentity, IdentityCollision } from './oidc.js';
export { hashPassword, verifyPassword } from './passwords.js';
export { sealTotpSecret, generateTotpSecret } from './totp.js';
export { SESSION_COOKIE, SECURE_SESSION_COOKIE, sessionCookieName, IDLE_MS, ABSOLUTE_MS } from './sessions.js';

/** GET /setup once an operator exists: straight to /signin (PST-REQ-171). */
export function setupPageGuard(deps: ApiDeps): RequestHandler {
  const rt = runtimeFor(deps);
  return handle(async (_req, res, next) => {
    if (await isSetupRequired(rt.db)) {
      next();
      return;
    }
    res.redirect(302, '/signin');
  });
}
