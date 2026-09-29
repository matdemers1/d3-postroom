// Sorting corrections over HTTP (PST-T-14.9, PST-ADR-011). Mounted by app.ts at /api/sorting behind
// a session. POST /corrections is the chip popover's "Always put … in …" and "Move this message to
// …": a move plus a recorded sender preference. GET /corrections is Settings → Rules' "Sorting
// corrections"; POST /corrections/:id/undo is its Undo, and the Toast's. Every mutation is audited
// (PST-REQ-009); nothing is deleted — an undone correction is marked, not removed.
import { audited, getAuditContext } from '@postroom/audit';
import { Router, type Response } from 'express';
import type { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { CorrectionBody, CorrectionIdParams, type CorrectionResultJson, type UndoResultJson } from './schemas.js';
import { CorrectionRefused, correctionJson, createCorrection, listCorrections, undoCorrection } from './store.js';

function parse<S extends z.ZodType>(schema: S, value: unknown, res: Response): z.output<S> | null {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  res.status(400).json({ error: 'invalid_request', message: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  return null;
}

function refused(res: Response, error: unknown): boolean {
  if (!(error instanceof CorrectionRefused)) return false;
  res.status(error.status).json({ error: error.code, message: error.message });
  return true;
}

export function sortingRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  router.get(
    '/corrections',
    handle(async (req, res) => {
      const me = currentSession(req);
      const rows = await listCorrections(db, me.accountId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ corrections: rows.map(correctionJson) });
    }),
  );

  router.post(
    '/corrections',
    handle(async (req, res) => {
      const body = parse(CorrectionBody, req.body, res);
      if (body === null) return;
      const me = currentSession(req);
      let out: CorrectionResultJson;
      try {
        out = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'sorting.correction.create', entityType: 'sorting_correction', context: getAuditContext(req) },
          async (tx) => {
            const made = await createCorrection(tx, { accountId: me.accountId, messageId: body.messageId, bucket: body.bucket, scope: body.scope, source: body.source });
            const correction = correctionJson(made.row);
            return {
              entityId: made.row.id,
              before: { messageId: body.messageId, ...made.before },
              after: { ...correction, pin: { address: made.row.target, bucket: made.row.toBucket }, mailboxId: made.message.mailboxId, flags: made.message.flags },
              result: { correction, message: made.message },
            };
          },
        );
      } catch (error) {
        if (refused(res, error)) return;
        throw error;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(out);
    }),
  );

  router.post(
    '/corrections/:id/undo',
    handle(async (req, res) => {
      const params = parse(CorrectionIdParams, req.params, res);
      if (params === null) return;
      const me = currentSession(req);
      let out: UndoResultJson;
      try {
        out = await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'sorting.correction.undo', entityType: 'sorting_correction', context: getAuditContext(req) },
          async (tx) => {
            const undone = await undoCorrection(tx, me.accountId, params.id, rt.now());
            const correction = correctionJson(undone.row);
            const result: UndoResultJson = { correction, movedBack: undone.movedBack, message: undone.message, preferenceRestored: undone.preferenceRestored };
            return { entityId: undone.row.id, after: result, result };
          },
        );
      } catch (error) {
        if (refused(res, error)) return;
        throw error;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    }),
  );

  return router;
}
