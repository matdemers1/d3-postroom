// Mail client autoconfiguration (PST-T-3.6): Thunderbird autoconfig and Outlook/Apple autodiscover.
// Public (no session), mounted by app.ts at the site root before the SPA fallback.
import { Router } from 'express';
import type { ApiDeps } from '../deps.js';

export function autoconfigRoutes(_deps: ApiDeps): Router {
  return Router();
}
