// Full-data export over HTTP (PST-T-10.1, PST-REQ-151): mailboxes as mbox, plus a manifest, in one
// ZIP the worker's 'export' queue builds (apps/worker/src/export/**). Mounted by app.ts at
// /api/export behind a session.
//
//   POST /api/export              starts one export for the caller's account (step-up + audited)
//   GET  /api/export/:id          status: pending | running | done | failed
//   GET  /api/export/:id/download the finished archive, streamed (step-up + audited)
//
// One active export per account: a second POST while one is pending/running is 409. The job queue's
// own status is the export's status; the finished archive's location is a `setting` row the worker
// writes (store.ts) and a sweep (apps/worker/src/export/sweep.ts) deletes 24 h after it finishes —
// after that, status still reads 'done' from the job row but the archive is gone, so download 404s.
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { getAuditContext, recordAudit } from '@postroom/audit';
import { JobStatus, type Job } from '@postroom/db';
import { enqueue } from '@postroom/queue';
import { Router, type Request, type Response } from 'express';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { IdParams, type ExportStatusJson } from './schemas.js';
import { readExportResult } from './store.js';

export const EXPORT_QUEUE = 'export';
/** Default; overridden by the worker's own default only in that it must match — both read env if set. */
export const DEFAULT_BLOB_ROOT = '/var/lib/postroom/blobs';
const ACTIVE_STATUSES: readonly JobStatus[] = [JobStatus.pending, JobStatus.running];

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

/** RFC 6266, ASCII-only here: the archive's name never carries user content. */
function attachmentDisposition(filename: string): string {
  return `attachment; filename="${filename}"`;
}

function statusOf(job: Pick<Job, 'status' | 'lastError'>): ExportStatusJson['status'] {
  if (job.status === JobStatus.done) return 'done';
  if (job.status === JobStatus.dead) return 'failed';
  return job.status === JobStatus.running ? 'running' : 'pending';
}

export function exportRoutes(deps: ApiDeps): Router {
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

  /** The caller's export job, or null after answering 404 (unknown, not theirs, or not the export queue). */
  const ownExport = async (req: Request, res: Response): Promise<Job | null> => {
    const parsed = IdParams.safeParse(req.params);
    if (!parsed.success) {
      notFound(res);
      return null;
    }
    const job = await db.job.findUnique({ where: { id: parsed.data.id } });
    const me = currentSession(req);
    const payload = job?.payload as { accountId?: unknown } | null;
    if (job === null || job.queue !== EXPORT_QUEUE || payload?.accountId !== me.accountId) {
      notFound(res);
      return null;
    }
    return job;
  };

  const toJson = async (job: Job): Promise<ExportStatusJson> => {
    const status = statusOf(job);
    const result = status === 'done' ? await readExportResult(db, job.id) : null;
    return {
      id: job.id,
      status: status === 'done' && result === null ? 'failed' : status,
      requestedAt: job.createdAt.toISOString(),
      error: job.lastError,
      archiveSize: result?.archiveSize ?? null,
      expiresAt: result?.expiresAt ?? null,
      manifest: result?.manifest ?? null,
    };
  };

  router.post(
    '/',
    requireStepUp(deps),
    handle(async (req, res) => {
      const me = currentSession(req);
      const recent = await db.job.findMany({ where: { queue: EXPORT_QUEUE, status: { in: [...ACTIVE_STATUSES] } }, orderBy: { createdAt: 'desc' }, take: 200 });
      const active = recent.find((j) => (j.payload as { accountId?: unknown } | null)?.accountId === me.accountId);
      if (active !== undefined) {
        res.status(409).json({ error: 'export_active', id: active.id });
        return;
      }
      const job = await db.$transaction(async (tx) => {
        const created = await enqueue(tx, EXPORT_QUEUE, { accountId: me.accountId });
        if (created === null) throw new Error('export job was not enqueued');
        await recordAudit(tx, {
          actor: { kind: 'account', accountId: me.accountId },
          action: 'export.start',
          entityType: 'job',
          entityId: created.id,
          after: { queue: EXPORT_QUEUE },
          context: getAuditContext(req),
        });
        return created;
      });
      res.status(202).json(await toJson(job));
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      const job = await ownExport(req, res);
      if (job === null) return;
      res.setHeader('Cache-Control', 'no-store');
      res.json(await toJson(job));
    }),
  );

  router.get(
    '/:id/download',
    requireStepUp(deps),
    handle(async (req, res) => {
      const job = await ownExport(req, res);
      if (job === null) return;
      if (statusOf(job) !== 'done') {
        res.status(409).json({ error: 'export_not_ready' });
        return;
      }
      const result = await readExportResult(db, job.id);
      if (result === null) {
        // Done, but the archive already expired and was swept — a clean 404, not a stale pointer.
        notFound(res);
        return;
      }
      const store = blobStore(res);
      if (store === null) return;
      const me = currentSession(req);
      await recordAudit(db, {
        actor: { kind: 'account', accountId: me.accountId },
        action: 'export.download',
        entityType: 'job',
        entityId: job.id,
        context: getAuditContext(req),
      });
      const stat = await store.stat(result.archiveSha256);
      if (stat === null) {
        notFound(res);
        return;
      }
      const stream = await store.get(result.archiveSha256);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', attachmentDisposition(`postroom-export-${job.id}.zip`));
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'private, no-store');
      stream.pipe(res);
      await new Promise<void>((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
        res.on('error', reject);
      });
    }),
  );

  return router;
}
