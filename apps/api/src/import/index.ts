// IMAP import over HTTP (PST-T-10.2, PST-REQ-152): folders from another IMAP server into the
// caller's account, run by the worker's 'import' queue (apps/worker/src/import/**). Mounted by
// app.ts at /api/import behind a session; CSRF is the /api-wide guard.
//
//   POST /api/import             start one (step-up + audited). 409 while another is active.
//   GET  /api/import             the caller's latest import, or null
//   GET  /api/import/:id         one import's status and per-folder progress
//   POST /api/import/:id/cancel  stop it (audited); what was filed stays
//
// The password is sealed under the KEK into its own `setting` row in the same transaction that
// enqueues the job, and the worker deletes that row when the import ends — done, failed or
// cancelled (a cancel deletes it here and now). It is never in the job payload, a response, a log
// line or the audit record: the audit keeps the host, port, whether a fingerprint was pinned, and
// how many folders were asked for.
import { getAuditContext, recordAudit } from '@postroom/audit';
import { JobStatus, type Job } from '@postroom/db';
import { enqueue } from '@postroom/queue';
import { Router, type Request, type Response } from 'express';
import { currentSession, handle, requireStepUp } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { IdParams, StartImportBody, type ImportStatusJson } from './schemas.js';
import {
  cancelRequested,
  IMPORT_QUEUE,
  importCancelKey,
  importSecretKey,
  readImportState,
  writeImportSecret,
  writeImportState,
  type ImportState,
} from './store.js';

const ACTIVE: readonly JobStatus[] = [JobStatus.pending, JobStatus.running];
/** Transient failures (the source down, a dropped connection) are retried this many times, resuming each time. */
const MAX_ATTEMPTS = 8;

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

function isTerminal(state: ImportState): boolean {
  return state.status === 'done' || state.status === 'failed' || state.status === 'cancelled';
}

export function importRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  const toJson = async (job: Job, state: ImportState): Promise<ImportStatusJson> => {
    // A job the queue gave up on while the worker could not record it (it died on its last try).
    const status = !isTerminal(state) && job.status === JobStatus.dead ? 'failed' : state.status;
    const totals = { folders: state.progress.length, foldersDone: 0, total: 0, imported: 0, duplicates: 0 };
    for (const f of state.progress) {
      totals.total += f.total;
      totals.imported += f.imported;
      totals.duplicates += f.duplicates;
      if (f.done) totals.foldersDone++;
    }
    return {
      id: job.id,
      status,
      host: state.host,
      port: state.port,
      username: state.username,
      pinned: state.trustFingerprint !== null,
      requestedAt: state.createdAt,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      error: state.error ?? (status === 'failed' ? job.lastError : null),
      cancelRequested: isTerminal(state) ? false : await cancelRequested(db, job.id),
      folders: state.progress.map((f) => ({ name: f.display, target: f.target, total: f.total, imported: f.imported, duplicates: f.duplicates, done: f.done })),
      totals,
    };
  };

  /** The caller's import job and its state, or null after answering 404. */
  const ownImport = async (req: Request, res: Response): Promise<{ job: Job; state: ImportState } | null> => {
    const parsed = IdParams.safeParse(req.params);
    if (!parsed.success) {
      notFound(res);
      return null;
    }
    const job = await db.job.findUnique({ where: { id: parsed.data.id } });
    const me = currentSession(req);
    const payload = job?.payload as { accountId?: unknown } | null;
    const state = job === null ? null : await readImportState(db, job.id);
    if (job === null || job.queue !== IMPORT_QUEUE || payload?.accountId !== me.accountId || state === null || state.accountId !== me.accountId) {
      notFound(res);
      return null;
    }
    return { job, state };
  };

  router.post(
    '/',
    requireStepUp(deps),
    handle(async (req, res) => {
      const parsed = StartImportBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request', fields: parsed.error.issues.map((i) => i.path.join('.')).filter((p) => p !== 'password') });
        return;
      }
      if (rt.kek === null) {
        res.status(503).json({ error: 'kek_not_configured', message: 'POSTROOM_KEK is not set' });
        return;
      }
      const kek = rt.kek;
      const me = currentSession(req);
      const body = parsed.data;
      const active = await db.job.findFirst({
        where: { queue: IMPORT_QUEUE, status: { in: [...ACTIVE] }, payload: { path: ['accountId'], equals: me.accountId } },
        select: { id: true },
      });
      if (active !== null) {
        res.status(409).json({ error: 'import_active', id: active.id });
        return;
      }
      const now = rt.now().toISOString();
      const created = await db.$transaction(async (tx) => {
        const job = await enqueue(tx, IMPORT_QUEUE, { accountId: me.accountId }, { maxAttempts: MAX_ATTEMPTS });
        if (job === null) throw new Error('import job was not enqueued');
        const state: ImportState = {
          accountId: me.accountId,
          host: body.host,
          port: body.port,
          username: body.username,
          trustFingerprint: body.trustFingerprint ?? null,
          folders: body.folders ?? null,
          status: 'pending',
          error: null,
          createdAt: now,
          startedAt: null,
          updatedAt: now,
          finishedAt: null,
          progress: [],
        };
        await writeImportState(tx, job.id, state);
        await writeImportSecret(tx, kek, job.id, body.password);
        await recordAudit(tx, {
          actor: { kind: 'account', accountId: me.accountId },
          action: 'import.start',
          entityType: 'job',
          entityId: job.id,
          after: { host: body.host, port: body.port, pinned: body.trustFingerprint !== undefined, folders: body.folders?.length ?? null },
          context: getAuditContext(req),
        });
        return { job, state };
      });
      res.status(202).json(await toJson(created.job, created.state));
    }),
  );

  router.get(
    '/',
    handle(async (req, res) => {
      const me = currentSession(req);
      const job = await db.job.findFirst({
        where: { queue: IMPORT_QUEUE, payload: { path: ['accountId'], equals: me.accountId } },
        orderBy: { createdAt: 'desc' },
      });
      const state = job === null ? null : await readImportState(db, job.id);
      res.json({ import: job === null || state === null ? null : await toJson(job, state) });
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res) => {
      const found = await ownImport(req, res);
      if (found === null) return;
      res.json(await toJson(found.job, found.state));
    }),
  );

  router.post(
    '/:id/cancel',
    handle(async (req, res) => {
      const found = await ownImport(req, res);
      if (found === null) return;
      if (isTerminal(found.state)) {
        res.status(409).json({ error: 'import_finished' });
        return;
      }
      const me = currentSession(req);
      const id = found.job.id;
      const now = rt.now().toISOString();
      const after = await db.$transaction(async (tx) => {
        // The password goes now, whatever state the job is in; a running worker already holds its
        // connection and stops at its next message, a resumed one finds the cancel and no secret.
        await tx.setting.deleteMany({ where: { key: importSecretKey(id) } });
        await tx.setting.upsert({ where: { key: importCancelKey(id) }, create: { key: importCancelKey(id), value: { at: now } }, update: {} });
        // Not claimed yet (or waiting to retry): no worker will run it, so it ends here.
        const unclaimed = await tx.job.updateMany({ where: { id, status: JobStatus.pending }, data: { status: JobStatus.done, finishedAt: rt.now() } });
        let state = found.state;
        if (unclaimed.count === 1) {
          state = { ...state, status: 'cancelled', finishedAt: now, updatedAt: now };
          await writeImportState(tx, id, state);
          await tx.setting.deleteMany({ where: { key: importCancelKey(id) } });
        }
        await recordAudit(tx, {
          actor: { kind: 'account', accountId: me.accountId },
          action: 'import.cancel',
          entityType: 'job',
          entityId: id,
          after: { stoppedBeforeStart: unclaimed.count === 1 },
          context: getAuditContext(req),
        });
        return state;
      });
      const job = await db.job.findUniqueOrThrow({ where: { id } });
      res.status(202).json(await toJson(job, after));
    }),
  );

  return router;
}
