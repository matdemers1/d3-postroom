// Registration point for dual login (PST-T-0.8). The auth task replaces this module; app.ts mounts
// whatever it exports at /api/auth and applies `requireSession`/`requireAdmin` to /api/admin.
import { Router, type RequestHandler } from 'express';
import type { ApiDeps } from '../deps.js';

export function authRoutes(_deps: ApiDeps): Router {
  return Router();
}

/** Until sign-in exists, nothing behind it is reachable. */
export function requireAdmin(_deps: ApiDeps): RequestHandler {
  return (_req, res) => {
    res.status(401).json({ error: 'unauthenticated' });
  };
}
