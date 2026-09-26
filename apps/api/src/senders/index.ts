// Sender pins and the new-sender screen over HTTP (PST-T-5.4). Mounted by app.ts at /api/senders
// behind a session. GET/PUT/DELETE .../pin manage the bucket override (PST-REQ-105, listed on the
// sender profile by PST-T-5.6); POST .../screen answers the new-sender badge's Allow/Block
// (PST-REQ-106). Every mutation is audited (PST-REQ-009).
import { audited, getAuditContext } from '@postroom/audit';
import { Router, type Response } from 'express';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { AddressParam, SenderPinBody, SenderScreenBody, type SenderPinViewJson, type SenderProfileJsonSchema, type SenderScreenResultJson } from './schemas.js';
import { clearNewSenderBadge, clearSenderPin, getSenderPin, getSenderProfile, setSenderPin, setSenderScreen } from './store.js';

function badAddress(res: Response): void {
  res.status(400).json({ error: 'invalid_request', message: 'address must look like an email address' });
}

export function senderRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  router.get(
    '/:address/pin',
    handle(async (req, res) => {
      const params = AddressParam.safeParse(req.params);
      if (!params.success) {
        badAddress(res);
        return;
      }
      const me = currentSession(req);
      const view: SenderPinViewJson = await getSenderPin(db, me.accountId, params.data.address);
      res.setHeader('Cache-Control', 'no-store');
      res.json(view);
    }),
  );

  router.put(
    '/:address/pin',
    handle(async (req, res) => {
      const params = AddressParam.safeParse(req.params);
      const body = SenderPinBody.safeParse(req.body);
      if (!params.success) {
        badAddress(res);
        return;
      }
      if (!body.success) {
        res.status(400).json({ error: 'invalid_request', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const me = currentSession(req);
      const view = await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'sender.pin.set', entityType: 'sender_pin', context: getAuditContext(req) },
        async (tx) => {
          const pin = await setSenderPin(tx, me.accountId, params.data.address, body.data.bucket);
          return { entityId: pin.address, after: pin, result: pin };
        },
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(view satisfies SenderPinViewJson);
    }),
  );

  router.delete(
    '/:address/pin',
    handle(async (req, res) => {
      const params = AddressParam.safeParse(req.params);
      if (!params.success) {
        badAddress(res);
        return;
      }
      const me = currentSession(req);
      await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'sender.pin.clear', entityType: 'sender_pin', context: getAuditContext(req) },
        async (tx) => {
          const cleared = await clearSenderPin(tx, me.accountId, params.data.address);
          return { entityId: params.data.address, after: { cleared }, result: cleared };
        },
      );
      res.json({ ok: true });
    }),
  );

  // The sender profile (PST-T-5.6, PST-REQ-113): message history, bucket distribution, pin/screen
  // state, unsubscribe status and an authentication summary, for the reading pane's From-line link.
  router.get(
    '/:address/profile',
    handle(async (req, res) => {
      const params = AddressParam.safeParse(req.params);
      if (!params.success) {
        badAddress(res);
        return;
      }
      const me = currentSession(req);
      const profile: SenderProfileJsonSchema = await getSenderProfile(db, me.accountId, params.data.address);
      res.setHeader('Cache-Control', 'no-store');
      res.json(profile);
    }),
  );

  router.post(
    '/:address/screen',
    handle(async (req, res) => {
      const params = AddressParam.safeParse(req.params);
      const body = SenderScreenBody.safeParse(req.body);
      if (!params.success) {
        badAddress(res);
        return;
      }
      if (!body.success) {
        res.status(400).json({ error: 'invalid_request', message: body.error.issues.map((i) => i.message).join('; ') });
        return;
      }
      const me = currentSession(req);
      const result = await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'sender.screen.set', entityType: 'sender_pin', context: getAuditContext(req) },
        async (tx) => {
          await setSenderScreen(tx, me.accountId, params.data.address, body.data.decision);
          const clearedNewSender = await clearNewSenderBadge(tx, me.accountId, params.data.address);
          const out: SenderScreenResultJson = { ok: true, address: params.data.address, decision: body.data.decision, clearedNewSender };
          return { entityId: params.data.address, after: out, result: out };
        },
      );
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    }),
  );

  return router;
}
