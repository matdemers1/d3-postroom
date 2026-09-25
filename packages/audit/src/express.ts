import { randomUUID } from 'node:crypto';
import type { Db } from '@postroom/db';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { RequestContext } from './types.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface AuditedRequest extends Request {
  audit?: RequestContext;
}

/** Reads the {@link RequestContext} attached by {@link auditContext}, throwing if it is missing. */
export function getAuditContext(req: Request): RequestContext {
  const ctx = (req as AuditedRequest).audit;
  if (!ctx) {
    throw new Error('auditContext() middleware did not run for this request');
  }
  return ctx;
}

/** Attaches `req.audit` (requestId, ip, userAgent) so every audit row can be traced to a request. */
export function auditContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const headerId = req.get('x-request-id');
    const requestId = headerId && headerId.length > 0 ? headerId : randomUUID();
    (req as AuditedRequest).audit = {
      requestId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    };
    res.setHeader('x-request-id', requestId);
    next();
  };
}

/** Counts requests that mutated (status < 400) but left no matching audit_event row. Tests and a
 * health check read this to prove the safety net works. */
export const missingAuditCount = { value: 0 };

function logAuditMissing(fields: { method: string; path: string; requestId: string }): void {
  process.stderr.write(`${JSON.stringify({ event: 'audit-missing', ...fields })}\n`);
}

// Outstanding guard checks, so tests can await `waitForAuditGuard()` instead of racing the
// fire-and-forget check the `finish` event kicks off.
const pending = new Set<Promise<void>>();

/** Resolves once every guard check started so far has finished. For tests only. */
export async function waitForAuditGuard(): Promise<void> {
  await Promise.all(pending);
}

/**
 * Safety net, not the mechanism: after a mutating request (POST/PUT/PATCH/DELETE) finishes with a
 * non-error status, asserts at least one audit_event row was written with this request's id. A
 * miss logs a structured line to stderr and increments {@link missingAuditCount}.
 */
export function mutationAuditGuard(db: Db): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const ctx = (req as AuditedRequest).audit;
      const requestId = ctx?.requestId;
      if (!requestId) return;
      const check = db.auditEvent
        .count({ where: { requestId } })
        .then((count) => {
          if (count === 0) {
            missingAuditCount.value += 1;
            logAuditMissing({ method: req.method, path: req.path, requestId });
          }
        })
        .catch((err: unknown) => {
          missingAuditCount.value += 1;
          logAuditMissing({ method: req.method, path: req.path, requestId });
          process.stderr.write(`${JSON.stringify({ event: 'audit-guard-error', message: String(err) })}\n`);
        });
      pending.add(check);
      void check.finally(() => pending.delete(check));
    });
    next();
  };
}
