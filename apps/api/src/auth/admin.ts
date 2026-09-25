// /api/admin routes that belong to auth. Mounted behind requireAdmin; the destructive one behind
// requireStepUp as well — the demonstration route for PST-REQ-008.
import { audited, getAuditContext } from '@postroom/audit';
import { Router } from 'express';
import type { ApiDeps } from '../deps.js';
import { currentSession, handle, requireStepUp } from './middleware.js';
import { runtimeFor } from './runtime.js';
import { deleteSession } from './sessions.js';

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

  return router;
}
