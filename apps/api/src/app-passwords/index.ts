// App passwords over HTTP (PST-T-1.3). Mounted by app.ts at /api/app-passwords behind a session.
import { Router } from 'express';
import type { ApiDeps } from '../deps.js';

export function appPasswordRoutes(_deps: ApiDeps): Router {
  return Router();
}
