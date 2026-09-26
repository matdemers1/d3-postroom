// POST /api/messages/:id/unsubscribe (PST-T-5.6, PST-REQ-110): the reading pane and Feed view's
// one-click unsubscribe button. Mounted by app.ts at /api/messages, alongside — not instead of —
// delivery's routes at the same prefix; the paths are disjoint (.../unsubscribe never collides with
// .../outbound or .../delivery).
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { audited, getAuditContext } from '@postroom/audit';
import { Router, type Response } from 'express';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { findOwnMessage } from '../mail/store.js';
import { DEFAULT_BLOB_ROOT } from '../mail/index.js';
import { MessageIdParams, type UnsubscribeResultJson } from '../senders/schemas.js';
import { attemptUnsubscribe, parseUnsubscribeOffer, recordUnsubscribeResult, unsubscribeHeadersOf, unsubscribePolicy } from '../senders/unsubscribe.js';

export function unsubscribeRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  let blobs: BlobStore | null = null;
  const blobStore = (res: Response): BlobStore | null => {
    if (blobs !== null) return blobs;
    if (rt.kek === null) {
      res.status(503).json({ error: 'blobstore_not_configured', message: 'POSTROOM_KEK is not set' });
      return null;
    }
    const root = deps.env['BLOB_ROOT']?.trim() ?? '';
    blobs = createBlobStore({ root: root === '' ? DEFAULT_BLOB_ROOT : root, db, kek: rt.kek });
    return blobs;
  };

  router.post(
    '/:id/unsubscribe',
    handle(async (req, res) => {
      const params = MessageIdParams.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({ error: 'invalid_request', message: 'id must be a message id' });
        return;
      }
      const me = currentSession(req);
      const message = await findOwnMessage(db, me.accountId, params.data.id);
      if (message === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const store = blobStore(res);
      if (store === null) return;

      const policy = unsubscribePolicy(deps.env);
      const headers = await unsubscribeHeadersOf(store, message.blobSha256);

      // Every attempt is audited (PST-REQ-009), whether or not the message offered One-Click: a
      // reader pressed the button, and what happened (or why nothing could) is worth a row.
      const result = await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'sender.unsubscribe', entityType: 'sender_pin', context: getAuditContext(req) },
        async (tx) => {
          const offer = parseUnsubscribeOffer(headers, policy.allowPrivate);
          if (!offer.available) {
            const out: UnsubscribeResultJson = { ok: false, detail: offer.reason, offered: false, mailto: offer.mailto };
            return { entityId: message.fromAddress ?? params.data.id, after: out, result: out };
          }
          const attempt = await attemptUnsubscribe(message, message.verdict, headers, policy);
          const ok = attempt.outcome?.ok ?? false;
          const detail = attempt.outcome === null ? 'not attempted' : attempt.outcome.detail;
          if (message.fromAddress !== null) {
            await recordUnsubscribeResult(tx, me.accountId, message.fromAddress, { method: 'one-click', ok, detail, at: new Date() });
          }
          const out: UnsubscribeResultJson = { ok, detail, offered: true, mailto: attempt.offer.mailto };
          return { entityId: message.fromAddress ?? params.data.id, after: out, result: out };
        },
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(result satisfies UnsubscribeResultJson);
    }),
  );

  return router;
}
