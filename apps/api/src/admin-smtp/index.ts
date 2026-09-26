// /api/admin/smtp — the operator's transcript browser and live viewer (PST-T-6.3, PST-REQ-117,
// PST-REQ-118). Mounted by app.ts behind requireAdmin.
//
//   GET /api/admin/smtp/transcripts            list, newest first
//   GET /api/admin/smtp/transcripts/:id         one transcript, decompressed line by line
//   GET /api/admin/smtp/live                    server-sent events: every redacted line, live
import { Router } from 'express';
import { handle } from '../auth/middleware.js';
import type { ApiDeps } from '../deps.js';
import { getTranscript, listTranscripts, smtpLiveHubFor, type LiveLine } from './store.js';
import { ListQuery, TranscriptIdParam } from './schemas.js';

const HEARTBEAT_MS = 25_000;

export function adminSmtpRoutes(deps: ApiDeps): Router {
  const router = Router();

  router.get(
    '/transcripts',
    handle(async (req, res) => {
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_query', message: parsed.error.message });
        return;
      }
      const q = parsed.data;
      const rows = await listTranscripts(deps.db, { daemon: q.daemon, clientIp: q.clientIp, before: q.before, limit: q.limit ?? 100 });
      res.json({ transcripts: rows });
    }),
  );

  router.get(
    '/transcripts/:id',
    handle(async (req, res) => {
      const params = TranscriptIdParam.safeParse(req.params);
      if (!params.success) {
        res.status(400).json({ error: 'invalid_id' });
        return;
      }
      const detail = await getTranscript(deps.db, params.data.id);
      if (detail === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json(detail);
    }),
  );

  router.get(
    '/live',
    handle(async (req, res) => {
      const hub = smtpLiveHubFor(deps);
      if (hub === null) {
        res.status(503).json({ error: 'live_not_configured', message: 'DATABASE_URL is not set' });
        return;
      }
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      res.write('retry: 3000\n\n');

      let seq = 0;
      const send = (line: LiveLine): void => {
        if (res.destroyed || res.writableEnded) return;
        seq += 1;
        res.write(`id: ${String(seq)}\nevent: line\ndata: ${JSON.stringify(line)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n');
      }, HEARTBEAT_MS);

      let unsubscribe: (() => void) | null = null;
      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe?.();
      });
      try {
        unsubscribe = await hub.subscribe(send);
      } catch {
        clearInterval(heartbeat);
        res.end();
        return;
      }
      if (res.destroyed || res.writableEnded) unsubscribe();
    }),
  );

  return router;
}
