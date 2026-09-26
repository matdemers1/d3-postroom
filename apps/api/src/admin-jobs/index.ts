// /api/admin/jobs — the operator's view of the job queue and the replay buttons (PST-T-2.7,
// PST-REQ-061). Mounted by app.ts behind requireAdmin. Replays are audited but need no step-up:
// they are not destructive — every stage is idempotent, so a replay files nothing twice.
//
//   GET  /api/admin/jobs?status=dead|failed|pending|running|done&queue=inbound
//   POST /api/admin/jobs/:id/replay                  a dead/failed/done job back in line
//   POST /api/admin/jobs/inbound/:id/replay          { fromStage } — re-run one message's stages
//
// The inbound replay enqueues the worker's payload contract (apps/worker/src/stages/types.ts):
// `{ inboundMessageId, replayFrom }`. The worker clears the stage markers from `replayFrom` onward
// when it picks the job up, once per job id. STAGES below must match the worker's list.
import { randomUUID } from 'node:crypto';
import { audited, getAuditContext } from '@postroom/audit';
import { InboundState, JobStatus, type Job } from '@postroom/db';
import { enqueue } from '@postroom/queue';
import { Router } from 'express';
import { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';

export const INBOUND_QUEUE = 'inbound';
export const STAGES = ['verify', 'parse', 'classify', 'sieve', 'file', 'notify'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A job in one of these may be put back in line; pending and running ones are already in it. */
const REPLAYABLE: readonly JobStatus[] = [JobStatus.dead, JobStatus.failed, JobStatus.done];

const ListQuery = z.object({
  status: z.enum(JobStatus).optional(),
  queue: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Thrown inside the replay transaction to roll it back (and its audit row) when the job got claimed. */
class JobActive extends Error {}

const InboundReplayBody = z.object({ fromStage: z.enum(STAGES) });

function toJson(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    queue: job.queue,
    status: job.status,
    payload: job.payload,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    runAt: job.runAt.toISOString(),
    lastError: job.lastError,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export function adminJobRoutes(deps: ApiDeps): Router {
  const rt = runtimeFor(deps);
  const { db } = rt;
  const router = Router();

  // POST /api/admin/jobs/dev-seed-failure — e2e only (POSTROOM_E2E_SEED=1, same gate as
  // admin-dev/index.ts's seed route): spools a message whose file stage never ran and a matching
  // dead 'inbound' job, so e2e/tests/admin-health.spec.ts has something real to replay from the
  // Jobs screen without a live SMTP path or worker in the loop.
  router.post(
    '/dev-seed-failure',
    handle(async (req, res) => {
      if (deps.env['POSTROOM_E2E_SEED'] !== '1') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const me = currentSession(req);
      const seeded = await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'admin.dev.seed-failure', entityType: 'inbound_message', context: getAuditContext(req) },
        async (tx) => {
          const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');
          await tx.blob.upsert({
            where: { sha256 },
            create: { sha256, size: 1, wrappedDek: new Uint8Array(1), kekId: 'k', aead: 'x', nonce: new Uint8Array(1) },
            update: {},
          });
          const inbound = await tx.inboundMessage.create({
            data: {
              envelopeFrom: 'sender@example.org',
              recipients: [],
              blobSha256: sha256,
              size: 1,
              state: InboundState.failed,
              lastError: 'Error: simulated file-stage failure (dev-seed-failure)',
            },
          });
          const job = await tx.job.create({
            data: {
              queue: INBOUND_QUEUE,
              payload: { inboundMessageId: inbound.id },
              status: JobStatus.dead,
              attempts: 5,
              maxAttempts: 5,
              lastError: 'Error: simulated file-stage failure (dev-seed-failure)',
            },
          });
          return { entityId: inbound.id, before: null, after: { jobId: job.id }, result: { inboundMessageId: inbound.id, jobId: job.id } };
        },
      );
      res.status(201).json(seeded);
    }),
  );

  router.get(
    '/',
    handle(async (req, res) => {
      const parsed = ListQuery.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const { status, queue, limit } = parsed.data;
      const jobs = await db.job.findMany({
        where: { ...(status === undefined ? {} : { status }), ...(queue === undefined ? {} : { queue }) },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: limit ?? 200,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ jobs: jobs.map(toJson) });
    }),
  );

  router.post(
    '/:id/replay',
    handle(async (req, res) => {
      const id = String(req.params['id']);
      const job = UUID.test(id) ? await db.job.findUnique({ where: { id } }) : null;
      if (job === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (!REPLAYABLE.includes(job.status)) {
        res.status(409).json({ error: 'job_active' });
        return;
      }
      const me = currentSession(req);
      try {
        await audited(
          db,
          { kind: 'account', accountId: me.accountId },
          { action: 'admin.job.replay', entityType: 'job', context: getAuditContext(req) },
          async (tx) => {
            // Guarded on status, so a job a worker claimed meanwhile is never yanked back to pending.
            const updated = await tx.job.updateMany({
              where: { id, status: { in: [...REPLAYABLE] } },
              data: { status: JobStatus.pending, attempts: 0, runAt: rt.now(), lastError: null, finishedAt: null, lockedAt: null, lockedBy: null },
            });
            if (updated.count === 0) throw new JobActive();
            return {
              entityId: id,
              before: { status: job.status, attempts: job.attempts, lastError: job.lastError },
              after: { status: JobStatus.pending, queue: job.queue },
              result: null,
            };
          },
        );
      } catch (error) {
        if (error instanceof JobActive) {
          res.status(409).json({ error: 'job_active' });
          return;
        }
        throw error;
      }
      res.status(202).json({ ok: true });
    }),
  );

  router.post(
    '/inbound/:id/replay',
    handle(async (req, res) => {
      const id = String(req.params['id']);
      const row = UUID.test(id) ? await db.inboundMessage.findUnique({ where: { id }, select: { state: true } }) : null;
      if (row === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const parsed = InboundReplayBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      if (row.state === InboundState.rejected) {
        // Refused at DATA: its Rejects copies were filed by smtp-in; there is no pipeline to replay.
        res.status(409).json({ error: 'rejected_at_data' });
        return;
      }
      const { fromStage } = parsed.data;
      const me = currentSession(req);
      const jobId = await audited<string>(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'admin.inbound.replay', entityType: 'inbound_message', context: getAuditContext(req) },
        async (tx) => {
          const job = await enqueue(tx, INBOUND_QUEUE, { inboundMessageId: id, replayFrom: fromStage }, {
            idempotencyKey: `inbound:${id}:replay:${fromStage}:${randomUUID()}`,
          });
          if (job === null) throw new Error('replay job was not enqueued');
          return { entityId: id, before: { state: row.state }, after: { fromStage, jobId: job.id }, result: job.id };
        },
      );
      res.status(202).json({ ok: true, jobId, fromStage });
    }),
  );

  return router;
}
