// The HTTP API and the web app's host. Everything under /api is JSON; everything else is the SPA.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { auditContext, mutationAuditGuard } from '@postroom/audit';
import { schemaRevision } from '@postroom/db';
import { adminDevEnabled, adminDevRoutes } from './admin-dev/index.js';
import { adminHealthRoutes } from './admin-health/index.js';
import { adminJobRoutes } from './admin-jobs/index.js';
import { adminQueueRoutes } from './admin-queue/index.js';
import { serviceAccountRoutes } from './admin-service/index.js';
import { appPasswordRoutes } from './app-passwords/index.js';
import { autoconfigRoutes } from './autoconfig/index.js';
import { mailRoutes } from './mail/index.js';
import { usercontentConfig, usercontentDispatch } from './usercontent/index.js';
import { deliveryRoutes } from './delivery/index.js';
import { exportRoutes } from './export/index.js';
import { adminRoutes, authRoutes, csrfGuard, requireAdmin, requireSession, setupPageGuard } from './auth/index.js';
import { isSecureOrigin } from './auth/sessions.js';
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

/**
 * HSTS for two years, subdomains included (ASVS 5.0 3.4.1). Only on a secure origin: a plain-http
 * loopback dev or e2e stack would otherwise teach the browser to refuse it.
 */
export const HSTS = 'max-age=63072000; includeSubDomains';

export function createApp(deps: ApiDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // One hop: the Cloudflare Tunnel's cloudflared, so req.ip is the client it reports.
  app.set('trust proxy', 1);
  // The usercontent origin (PST-T-3.12): chosen by Host, answered by its own app, never falls through.
  const usercontent = usercontentDispatch(deps);
  if (usercontent !== null) app.use(usercontent);
  const frameSrc = usercontentConfig(deps)?.origin;
  app.use(securityHeaders);
  if (isSecureOrigin(deps.config.webOrigin)) {
    app.use((_req, res, next) => {
      res.setHeader('Strict-Transport-Security', HSTS);
      next();
    });
  }
  // The mail origin may frame exactly one other origin: the one rendered mail comes from.
  if (frameSrc !== undefined) {
    app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', `${CSP}; frame-src ${frameSrc}`);
      next();
    });
  }

  app.get('/health', async (_req, res) => {
    try {
      res.json({ status: 'ok', daemon: 'api', revision: deps.config.revision, schemaRevision: await schemaRevision(deps.db) });
    } catch (error) {
      res.status(503).json({ status: 'down', daemon: 'api', revision: deps.config.revision, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // Public client autoconfiguration (PST-T-3.6): no session, no CSRF, GET/POST XML only.
  app.use(autoconfigRoutes(deps));

  // Nothing under /api is cacheable unless a route says otherwise (ASVS 5.0 14.3.2, 14.2.2).
  const noStore = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };
  app.use('/api', noStore, auditContext(), express.json({ limit: '1mb' }), mutationAuditGuard(deps.db), csrfGuard(deps));
  app.use('/api/auth', authRoutes(deps));
  if (adminDevEnabled(deps.env)) app.use('/api/admin/dev', requireAdmin(deps), adminDevRoutes(deps));
  app.use('/api/admin/health', requireAdmin(deps), adminHealthRoutes(deps));
  app.use('/api/admin/jobs', requireAdmin(deps), adminJobRoutes(deps));
  app.use('/api/admin/queue', requireAdmin(deps), adminQueueRoutes(deps));
  app.use('/api/admin/service-accounts', requireAdmin(deps), serviceAccountRoutes(deps));
  app.use('/api/admin', requireAdmin(deps), adminRoutes(deps));
  app.use('/api/app-passwords', requireSession(deps), appPasswordRoutes(deps));
  app.use('/api/messages', requireSession(deps), deliveryRoutes(deps));
  app.use('/api/export', requireSession(deps), exportRoutes(deps));
  app.use('/api', requireSession(deps), mailRoutes(deps));
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
  app.use(errorHandler);
  return app;
}

interface HttpError {
  status?: unknown;
  type?: unknown;
  message?: unknown;
  stack?: unknown;
}

/**
 * The last word on a failed request (ASVS 5.0 16.3.4, 16.5.1): the client gets a generic JSON
 * error and the request id to quote; stderr gets what happened. A body-parser refusal keeps its own
 * 4xx. Never a stack trace, query or secret in a response.
 */
export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const e = (typeof error === 'object' && error !== null ? error : {}) as HttpError;
  const status = typeof e.status === 'number' && e.status >= 400 && e.status < 500 ? e.status : 500;
  const code =
    e.type === 'entity.parse.failed' ? 'invalid_json' : e.type === 'entity.too.large' ? 'body_too_large' : status === 500 ? 'internal' : 'invalid_request';
  const requestId = res.getHeader('x-request-id') ?? null;
  if (status === 500) {
    process.stderr.write(
      `${JSON.stringify({ event: 'unhandled-error', requestId, method: req.method, path: req.path, message: typeof e.message === 'string' ? e.message : String(error), stack: typeof e.stack === 'string' ? e.stack : null })}\n`,
    );
  }
  res.status(status).json({ error: code, requestId });
}
