// App passwords over HTTP (PST-T-1.3). Mounted by app.ts at /api/app-passwords behind a session.
//
// Everyone manages their own. An admin may also manage a *service* account's (PST-REQ-046) by
// adding `?accountId=` — the ecosystem apps that submit mail through Postroom authenticate with
// those. Another person's passwords are never reachable, admin or not.
import { getAuditContext } from '@postroom/audit';
import {
  APP_PASSWORD_SCOPES,
  CredentialError,
  createAppPassword,
  listAppPasswords,
  revokeAppPassword,
  MAX_LABEL_LENGTH,
  type AppPasswordView,
} from '@postroom/credentials';
import { AccountKind, AppPasswordScope } from '@postroom/db';
import { thawCredential } from '@postroom/delivery';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CreateBody = z.object({
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  scopes: z.array(z.enum(AppPasswordScope)).min(1).max(APP_PASSWORD_SCOPES.length),
  dailyRecipientCap: z.number().int().positive().max(1_000_000).nullable().optional(),
});

interface Target {
  accountId: string;
  /** True when an admin is acting on a service account rather than their own. */
  managed: boolean;
}

function toJson(view: AppPasswordView): Record<string, unknown> {
  return {
    id: view.id,
    accountId: view.accountId,
    label: view.label,
    prefix: view.prefix,
    scopes: view.scopes,
    createdAt: view.createdAt.toISOString(),
    lastUsedAt: view.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: view.lastUsedIp,
    revokedAt: view.revokedAt?.toISOString() ?? null,
    dailyRecipientCap: view.dailyRecipientCap,
    frozenAt: view.frozenAt?.toISOString() ?? null,
  };
}

export function appPasswordRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  /** Whose passwords this request is about, or null after answering 403/404. */
  const targetOf = async (req: Request, res: Response): Promise<Target | null> => {
    const me = currentSession(req);
    const asked = req.query['accountId'];
    if (asked === undefined || asked === me.accountId) return { accountId: me.accountId, managed: false };
    if (typeof asked !== 'string' || !UUID.test(asked)) {
      res.status(400).json({ error: 'invalid_request' });
      return null;
    }
    if (!me.isAdmin) {
      res.status(403).json({ error: 'forbidden' });
      return null;
    }
    const account = await db.account.findUnique({ where: { id: asked }, select: { kind: true } });
    if (account?.kind !== AccountKind.service) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    return { accountId: asked, managed: true };
  };

  router.get(
    '/',
    handle(async (req, res) => {
      const target = await targetOf(req, res);
      if (target === null) return;
      const rows = await listAppPasswords(db, target.accountId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ appPasswords: rows.map(toJson) });
    }),
  );

  router.post(
    '/',
    handle(async (req, res) => {
      const target = await targetOf(req, res);
      if (target === null) return;
      if (rt.pepper === null) {
        res.status(503).json({ error: 'auth_not_configured' });
        return;
      }
      const parsed = CreateBody.safeParse(req.body);
      // A recipient cap is an operator's control over a service mailbox (PST-T-1.10), not self-serve.
      if (!parsed.success || (parsed.data.dailyRecipientCap !== undefined && parsed.data.dailyRecipientCap !== null && !target.managed)) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const me = currentSession(req);
      try {
        const created = await createAppPassword(
          db,
          { kind: 'account', accountId: me.accountId },
          {
            accountId: target.accountId,
            label: parsed.data.label,
            scopes: parsed.data.scopes,
            dailyRecipientCap: parsed.data.dailyRecipientCap ?? null,
          },
          { pepper: rt.pepper, context: getAuditContext(req) },
        );
        // The only response that ever carries the plaintext.
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({ ...toJson(created.appPassword), password: created.password });
      } catch (error) {
        if (error instanceof CredentialError) {
          res.status(400).json({ error: error.code });
          return;
        }
        throw error;
      }
    }),
  );

  // PST-T-1.10 / PST-REQ-044: an admin thaws a credential the automatic cap froze — destructive
  // enough (it resumes held outbound mail) to sit behind the same step-up as other admin mutations.
  router.post(
    '/:id/thaw',
    requireStepUp(deps),
    handle(async (req, res) => {
      const me = currentSession(req);
      if (!me.isAdmin) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      const id = String(req.params['id']);
      if (!UUID.test(id)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const result = await thawCredential(db, id, { kind: 'account', accountId: me.accountId }, rt.now());
      if (!result.thawed) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true, rescheduled: result.rescheduled });
    }),
  );

  router.delete(
    '/:id',
    handle(async (req, res) => {
      const target = await targetOf(req, res);
      if (target === null) return;
      const id = String(req.params['id']);
      if (!UUID.test(id)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const me = currentSession(req);
      const revoked = await revokeAppPassword(
        db,
        { kind: 'account', accountId: me.accountId },
        { id, accountId: target.accountId },
        { now: rt.now(), context: getAuditContext(req) },
      );
      if (revoked === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
