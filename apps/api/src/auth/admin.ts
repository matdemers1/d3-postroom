// /api/admin routes that belong to auth. Mounted behind requireAdmin; the destructive one behind
// requireStepUp as well — the demonstration route for PST-REQ-008.
import { audited, getAuditContext, recordAudit } from '@postroom/audit';
import { Router } from 'express';
import type { ApiDeps } from '../deps.js';
import { currentSession, handle, requireStepUp } from './middleware.js';
import { runtimeFor } from './runtime.js';
import { deleteSession } from './sessions.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function adminRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  router.get(
    '/sessions',
    handle(async (req, res) => {
      const me = currentSession(req);
      const rows = await db.session.findMany({
        where: { expiresAt: { gt: rt.now() } },
        include: { account: { select: { displayName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const sessions = rows.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          displayName: row.account.displayName,
          method: row.method,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          ip: row.ip,
          userAgent: row.userAgent,
          current: row.id === me.sessionId,
        }));
      res.setHeader('Cache-Control', 'no-store');
      res.json({ sessions });
    }),
  );

  router.delete(
    '/sessions/:id',
    requireStepUp(deps),
    handle(async (req, res) => {
      const me = currentSession(req);
      const id = String(req.params['id']);
      if (!/^[0-9a-f-]{36}$/i.test(id)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if ((await db.session.findUnique({ where: { id }, select: { id: true } })) === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'admin.session.revoke', entityType: 'session', context: getAuditContext(req) },
        async (tx) => {
          const before = await deleteSession(tx, id);
          return { entityId: id, before, after: null, result: null };
        },
      );
      res.json({ ok: true });
    }),
  );

  // Every session of one account (?accountId=), or of everybody but the caller (?all=1) — ASVS 5.0
  // 7.4.5. The caller's own session survives either way, so the admin is not locked out mid-action.
  router.delete(
    '/sessions',
    requireStepUp(deps),
    handle(async (req, res) => {
      const me = currentSession(req);
      const accountId = req.query['accountId'];
      const all = req.query['all'] === '1';
      if (all === (accountId !== undefined) || (accountId !== undefined && (typeof accountId !== 'string' || !UUID.test(accountId)))) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const ended = await db.$transaction(async (tx) => {
        const rows = await tx.session.findMany({
          where: { id: { not: me.sessionId }, ...(all ? {} : { accountId: accountId as string }) },
          select: { id: true },
        });
        await tx.session.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
        await recordAudit(tx, {
          actor: { kind: 'account', accountId: me.accountId },
          action: all ? 'admin.session.revoke-all' : 'admin.session.revoke-account',
          entityType: all ? 'session' : 'account',
          entityId: all ? null : (accountId as string),
          after: { ended: rows.map((r) => r.id) },
          context: getAuditContext(req),
        });
        return rows.length;
      });
      res.json({ ok: true, ended });
    }),
  );

  return router;
}
