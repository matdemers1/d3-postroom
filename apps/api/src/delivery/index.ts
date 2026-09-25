// Delivery attempts over HTTP (PST-T-1.13). Mounted by app.ts at /api/messages behind a session.
import { Router } from 'express';
import type { ApiDeps } from '../deps.js';

export function deliveryRoutes(_deps: ApiDeps): Router {
  return Router();
}
