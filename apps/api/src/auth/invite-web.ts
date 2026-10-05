// POST /api/auth/invite — the web page at /invite/<token> (PST-T-20.2): the same two steps D3
// Constellation takes natively (invite-accept.ts), ending in the session cookie. No session is
// needed to call it; the CSRF header is, as for every cookie-setting route.
import { Router } from 'express';
import type { ApiDeps } from '../deps.js';
import { InviteStep, inviteStep } from './invite-accept.js';
import { handle } from './middleware.js';
import { runtimeFor } from './runtime.js';

export function inviteWebRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const router = Router();
  router.post(
    '/',
    handle(async (req, res) => {
      const parsed = InviteStep.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', message: 'Fill in every field.' });
        return;
      }
      await inviteStep(rt, req, res, parsed.data, 'web');
    }),
  );
  return router;
}
