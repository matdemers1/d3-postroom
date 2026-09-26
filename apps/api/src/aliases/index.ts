// Masked aliases over HTTP (PST-T-5.7, PST-REQ-112). Mounted by app.ts at /api/aliases behind a
// session. Everyone manages their own; a masked alias is never shared or transferred. Every
// mutation is audited (PST-REQ-009); killing one takes effect at the RCPT that follows (smtp-in
// reads killedAt straight from the address, so no cache to invalidate).
import { audited, getAuditContext } from '@postroom/audit';
import { Router } from 'express';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { AliasError, createAlias, killAlias, listAliases, reviveAlias, type AliasRow } from './store.js';
import { AliasIdParam, CreateAliasBody, type AliasViewJson } from './schemas.js';

function toJson(row: AliasRow): AliasViewJson {
  return {
    id: row.id,
    address: row.address,
    site: row.site,
    createdAt: row.createdAt.toISOString(),
    killedAt: row.killedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    receivedCount: row.receivedCount,
  };
}

export function aliasRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  router.get(
    '/',
    handle(async (req, res) => {
      const me = currentSession(req);
      const rows = await listAliases(db, me.accountId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ aliases: rows.map(toJson) });
    }),
  );

  router.post(
    '/',
    handle(async (req, res) => {
      const parsed = CreateAliasBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', message: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const me = currentSession(req);
      try {
        const alias = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'alias.create', entityType: 'address', context: getAuditContext(req) },
          async (tx) => {
            const row = await createAlias(tx, me.accountId, parsed.data.site);
            return { entityId: row.id, after: { address: row.address, site: row.site }, result: row };
          },
        );
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({ alias: toJson(alias) });
      } catch (error) {
        if (error instanceof AliasError) {
          res.status(error.code === 'no_primary_domain' ? 503 : 500).json({ error: error.code });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    '/:id/kill',
    handle(async (req, res) => {
      const params = AliasIdParam.safeParse(req.params);
      if (!params.success) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const me = currentSession(req);
      try {
        const alias = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'alias.kill', entityType: 'address', context: getAuditContext(req) },
          async (tx) => {
            const row = await killAlias(tx, me.accountId, params.data.id, rt.now());
            return { entityId: row.id, after: { killedAt: row.killedAt }, result: row };
          },
        );
        res.json({ alias: toJson(alias) });
      } catch (error) {
        if (error instanceof AliasError && error.code === 'not_found') {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        throw error;
      }
    }),
  );

  router.post(
    '/:id/revive',
    handle(async (req, res) => {
      const params = AliasIdParam.safeParse(req.params);
      if (!params.success) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const me = currentSession(req);
      try {
        const alias = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'alias.revive', entityType: 'address', context: getAuditContext(req) },
          async (tx) => {
            const row = await reviveAlias(tx, me.accountId, params.data.id);
            return { entityId: row.id, after: { killedAt: row.killedAt }, result: row };
          },
        );
        res.json({ alias: toJson(alias) });
      } catch (error) {
        if (error instanceof AliasError && error.code === 'not_found') {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
