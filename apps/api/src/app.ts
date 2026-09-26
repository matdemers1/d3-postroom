// The HTTP API and the web app's host. Everything under /api is JSON; everything else is the SPA.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { auditContext, mutationAuditGuard } from '@postroom/audit';
import { schemaRevision } from '@postroom/db';
import { adminJobRoutes } from './admin-jobs/index.js';
import { appPasswordRoutes } from './app-passwords/index.js';
import { deliveryRoutes } from './delivery/index.js';
import { adminRoutes, authRoutes, csrfGuard, requireAdmin, requireSession, setupPageGuard } from './auth/index.js';
import type { ApiDeps } from './deps.js';

// No third-party script, frame or connection, ever (PST-REQ-159, PST-REQ-175). HTML mail renders on
// the separate usercontent origin (PST-T-3.12), never here.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  next();
}

export function createApp(deps: ApiDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // One hop: the Cloudflare Tunnel's cloudflared, so req.ip is the client it reports.
  app.set('trust proxy', 1);
  app.use(securityHeaders);

  app.get('/health', async (_req, res) => {
    try {
      res.json({ status: 'ok', daemon: 'api', revision: deps.config.revision, schemaRevision: await schemaRevision(deps.db) });
    } catch (error) {
      res.status(503).json({ status: 'down', daemon: 'api', revision: deps.config.revision, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use('/api', express.json({ limit: '1mb' }), auditContext(), mutationAuditGuard(deps.db), csrfGuard(deps));
  app.use('/api/auth', authRoutes(deps));
  app.use('/api/admin/jobs', requireAdmin(deps), adminJobRoutes(deps));
  app.use('/api/admin', requireAdmin(deps), adminRoutes(deps));
  app.use('/api/app-passwords', requireSession(deps), appPasswordRoutes(deps));
  app.use('/api/messages', requireSession(deps), deliveryRoutes(deps));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Once an operator exists, the setup screen is gone for good (PST-REQ-171).
  app.get('/setup', setupPageGuard(deps));

  const dist = deps.config.webDist;
  if (dist !== undefined && existsSync(join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h', immutable: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      // Relative to `root`: send refuses an absolute path containing a dot-directory.
      res.sendFile('index.html', { root: dist });
    });
  }
  return app;
}
