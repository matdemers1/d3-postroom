// Push registration (PST-T-20.4, the D3 App contract's push): D3 Constellation registers this
// connection at the relay, then tells Postroom where to send and the key to seal to. Answered 204,
// then one postroom.registered notification — "Notifications are on" — so the person knows push works.
import { randomUUID } from 'node:crypto';
import { getAuditContext, recordAudit } from '@postroom/audit';
import { sealWithKek } from '@postroom/crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import { bearerOf } from '../auth/native-sessions.js';
import { handle, sessionOf } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { isDevicePublicKey, push, sendKeyAad } from '@postroom/push';

const Register = z.object({
  devicePublicKey: z.string().min(1).max(200),
  relay: z.object({ url: z.string().min(1).max(500), registration: z.string().min(1).max(200), sendKey: z.string().min(16).max(200) }),
  categories: z.array(z.string().regex(/^[a-z][a-z0-9]*\.[a-z_]+$/)).max(20),
});

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function problem(res: Response, status: number, name: string | null, title: string): void {
  res.status(status).type('application/problem+json').send(JSON.stringify({ type: name === null ? 'about:blank' : `https://d3cloud.io/problems/${name}`, title, status }));
}

export function pushRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  /** https, or a loopback http relay where the test configuration allows one — never in production. */
  const relayUrlOk = (raw: string): boolean => {
    try {
      const url = new URL(raw);
      if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return false;
      if (url.protocol === 'https:') return true;
      return url.protocol === 'http:' && deps.config.relayAllowLoopbackHttp === true && LOOPBACK.has(url.hostname);
    } catch {
      return false;
    }
  };

  router.post(
    '/native/register',
    handle(async (req, res) => {
      const kek = rt.kek;
      if (kek === null) {
        problem(res, 503, null, 'Push is not configured on this server');
        return;
      }
      // A native client's own credential, never the browser's cookie.
      const session = bearerOf(req) === null ? null : await sessionOf(rt, req);
      if (session === null) {
        problem(res, 401, 'session_revoked', 'Sign in again');
        return;
      }
      const parsed = Register.safeParse(req.body);
      const devicePublicKey = parsed.success ? Buffer.from(parsed.data.devicePublicKey, 'base64') : null;
      if (!parsed.success || devicePublicKey === null || !isDevicePublicKey(devicePublicKey) || !relayUrlOk(parsed.data.relay.url)) {
        problem(res, 400, null, 'That is not a relay registration');
        return;
      }
      const { relay, categories } = parsed.data;

      // Whose it is: a session Postroom issued keeps it until it ends; a D3 Auth token's row is
      // short-lived and governed by D3 Auth, so its registration belongs to the identity link.
      const row = await db.session.findUniqueOrThrow({
        where: { id: session.sessionId },
        select: { native: true, oidcIssuer: true, oidcSubject: true, _count: { select: { refreshes: true } } },
      });
      let owner: { sessionId: string } | { identityLinkId: string };
      if (row.native && row._count.refreshes > 0) {
        owner = { sessionId: session.sessionId };
      } else if (row.native && row.oidcIssuer !== null && row.oidcSubject !== null) {
        const link = await db.identityLink.findUnique({ where: { issuer_subject: { issuer: row.oidcIssuer, subject: row.oidcSubject } }, select: { id: true } });
        if (link === null) {
          problem(res, 401, 'identity_not_linked', 'Link this D3 Auth account first');
          return;
        }
        owner = { identityLinkId: link.id };
      } else {
        problem(res, 401, 'session_revoked', 'Sign in again');
        return;
      }

      const id = randomUUID();
      const relayUrl = relay.url.replace(/\/$/, '');
      const created = await db.$transaction(async (tx) => {
        // Registering again replaces the earlier registration for that session (or that relay slot).
        await tx.relayRegistration.deleteMany({
          where: { OR: [...('sessionId' in owner ? [{ sessionId: owner.sessionId }] : []), { relayUrl, registration: relay.registration }] },
        });
        const saved = await tx.relayRegistration.create({
          data: {
            id,
            accountId: session.accountId,
            ...owner,
            devicePublicKey: new Uint8Array(devicePublicKey),
            relayUrl,
            registration: relay.registration,
            sendKeySealed: new Uint8Array(sealWithKek(kek, Buffer.from(relay.sendKey, 'utf8'), sendKeyAad(id))),
            categories,
          },
        });
        await recordAudit(tx, {
          actor: { kind: 'account', accountId: session.accountId },
          action: 'push.registered',
          entityType: 'relay_registration',
          entityId: saved.id,
          after: { relay: relayUrl, categories, owner: 'sessionId' in owner ? 'session' : 'identity' },
          context: getAuditContext(req),
        });
        return saved;
      });
      res.status(204).end();

      // After the answer, never instead of it: a relay that is down must not fail the registration.
      void push(
        db,
        kek,
        created,
        { v: 1, category: 'postroom.registered', title: 'Notifications are on', body: 'Postroom will tell this device when Priority mail arrives.', sentAt: rt.now().toISOString() },
        { ...(deps.config.relayFetch === undefined ? {} : { fetch: deps.config.relayFetch }), now: rt.now },
      );
    }),
  );

  return router;
}
