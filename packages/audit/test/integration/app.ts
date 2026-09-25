// A small Express app exercising every shape of mutating route the property test drives: a
// successful audited upsert/delete, a route that throws after writing (rolls back, no audit row),
// a 400 validation failure (never touches the database), a GET (never mutates), and a route that
// mutates the database without going through `audited()` (proves the guard net catches it).
import express, { type ErrorRequestHandler, type Express } from 'express';
import type { Db, Prisma } from '@postroom/db';
import { audited, auditContext, getAuditContext, mutationAuditGuard, type Actor } from '../../src/index.js';

const actor: Actor = { kind: 'system', label: 'audit-test' };

interface ValueBody {
  value?: Prisma.InputJsonValue;
}

export function buildApp(db: Db): Express {
  const app = express();
  app.use(express.json());
  app.use(auditContext());
  app.use(mutationAuditGuard(db));

  app.put('/settings/:key', (req, res, next) => {
    const key = req.params['key'];
    const body = req.body as ValueBody;
    const value: Prisma.InputJsonValue = body.value ?? '';
    const ctx = getAuditContext(req);
    const state = { wasCreate: false };
    audited(db, actor, { action: 'settings.upsert', entityType: 'setting', context: ctx }, async (tx) => {
      const existing = await tx.setting.findUnique({ where: { key } });
      state.wasCreate = !existing;
      const row = await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
      return { entityId: key, before: existing?.value ?? null, after: value, result: row };
    })
      .then((row) => {
        res.status(state.wasCreate ? 201 : 200).json(row);
      })
      .catch(next);
  });

  app.delete('/settings/:key', (req, res, next) => {
    const key = req.params['key'];
    const ctx = getAuditContext(req);
    db.setting
      .findUnique({ where: { key } })
      .then(async (existing) => {
        if (!existing) {
          res.status(404).end();
          return;
        }
        await audited(db, actor, { action: 'settings.delete', entityType: 'setting', context: ctx }, async (tx) => {
          await tx.setting.delete({ where: { key } });
          return { entityId: key, before: existing.value, after: null, result: null };
        });
        res.status(204).end();
      })
      .catch(next);
  });

  app.post('/settings/:key/boom', (req, res) => {
    const key = req.params['key'];
    const body = req.body as ValueBody;
    const value: Prisma.InputJsonValue = body.value ?? '';
    const ctx = getAuditContext(req);
    audited(db, actor, { action: 'settings.upsert', entityType: 'setting', context: ctx }, async (tx) => {
      await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
      throw new Error('boom: intentional failure after the write, to prove the transaction rolled back');
    })
      .then(() => {
        res.status(200).end();
      })
      .catch(() => {
        res.status(500).end();
      });
  });

  app.post('/settings-validate', (req, res) => {
    const body = req.body as { key?: unknown };
    if (typeof body.key !== 'string' || body.key.length === 0) {
      res.status(400).json({ error: 'invalid' });
      return;
    }
    res.status(202).end();
  });

  app.get('/settings/:key', (req, res, next) => {
    const key = req.params['key'];
    db.setting
      .findUnique({ where: { key } })
      .then((row) => {
        res.status(row ? 200 : 404).json(row ?? null);
      })
      .catch(next);
  });

  app.post('/settings/:key/unsafe', (req, res, next) => {
    const key = req.params['key'];
    const body = req.body as ValueBody;
    const value: Prisma.InputJsonValue = body.value ?? '';
    // Deliberately bypasses audited(): proves mutationAuditGuard() trips the safety net.
    db.setting
      .upsert({ where: { key }, create: { key, value }, update: { value } })
      .then(() => {
        res.status(200).end();
      })
      .catch(next);
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'error' });
  };
  app.use(errorHandler);

  return app;
}
