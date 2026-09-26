// Compose templates over HTTP (PST-T-9.2, PST-REQ-144). Mounted by app.ts at /api/templates behind a
// session and the CSRF guard. Everyone manages their own; a template is never shared. Every mutation
// is audited (PST-REQ-009).
import { audited, getAuditContext } from '@postroom/audit';
import { Router } from 'express';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { CreateTemplateBody, TemplateIdParam, UpdateTemplateBody, type TemplateJson } from './schemas.js';
import { createTemplate, deleteTemplate, findOwnTemplate, listTemplates, TemplateError, updateTemplate, type TemplateRow } from './store.js';

function toJson(row: TemplateRow): TemplateJson {
  return {
    id: row.id,
    shortcut: row.shortcut,
    name: row.name,
    subject: row.subject,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function templateRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  router.get(
    '/',
    handle(async (req, res) => {
      const me = currentSession(req);
      const rows = await listTemplates(db, me.accountId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ templates: rows.map(toJson) });
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      const params = TemplateIdParam.safeParse(req.params);
      if (!params.success) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const me = currentSession(req);
      const row = await findOwnTemplate(db, me.accountId, params.data.id);
      if (row === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({ template: toJson(row) });
    }),
  );

  router.post(
    '/',
    handle(async (req, res) => {
      const parsed = CreateTemplateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', message: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const me = currentSession(req);
      try {
        const row = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'template.create', entityType: 'compose_template', context: getAuditContext(req) },
          async (tx) => {
            const created = await createTemplate(tx, me.accountId, parsed.data);
            return { entityId: created.id, after: { shortcut: created.shortcut, name: created.name }, result: created };
          },
        );
        res.status(201).json({ template: toJson(row) });
      } catch (error) {
        if (error instanceof TemplateError) {
          res.status(error.code === 'shortcut_taken' ? 409 : 404).json({ error: error.code });
          return;
        }
        throw error;
      }
    }),
  );

  router.put(
    '/:id',
    handle(async (req, res) => {
      const params = TemplateIdParam.safeParse(req.params);
      if (!params.success) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const parsed = UpdateTemplateBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', message: parsed.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const me = currentSession(req);
      try {
        const row = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'template.update', entityType: 'compose_template', context: getAuditContext(req) },
          async (tx) => {
            const before = await findOwnTemplate(tx, me.accountId, params.data.id);
            const updated = await updateTemplate(tx, me.accountId, params.data.id, parsed.data);
            return { entityId: updated.id, before: before === null ? null : { shortcut: before.shortcut, name: before.name }, after: { shortcut: updated.shortcut, name: updated.name }, result: updated };
          },
        );
        res.json({ template: toJson(row) });
      } catch (error) {
        if (error instanceof TemplateError) {
          res.status(error.code === 'shortcut_taken' ? 409 : 404).json({ error: error.code });
          return;
        }
        throw error;
      }
    }),
  );

  router.delete(
    '/:id',
    handle(async (req, res) => {
      const params = TemplateIdParam.safeParse(req.params);
      if (!params.success) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const me = currentSession(req);
      try {
        await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'template.delete', entityType: 'compose_template', context: getAuditContext(req) },
          async (tx) => {
            const deleted = await deleteTemplate(tx, me.accountId, params.data.id);
            return { entityId: deleted.id, before: { shortcut: deleted.shortcut, name: deleted.name }, after: null, result: null };
          },
        );
        res.status(204).end();
      } catch (error) {
        if (error instanceof TemplateError && error.code === 'not_found') {
          res.status(404).json({ error: 'not_found' });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
