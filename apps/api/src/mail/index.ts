// Mailboxes, messages and the SSE event stream over HTTP (PST-T-3.9). Mounted by app.ts at /api
// behind a session.
import { Router } from 'express';
import type { ApiDeps } from '../deps.js';

export function mailRoutes(_deps: ApiDeps): Router {
  return Router();
}
