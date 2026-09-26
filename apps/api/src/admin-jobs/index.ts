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
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { InboundState, JobStatus, type Job } from '@postroom/db';
import { enqueue } from '@postroom/queue';
import { Router } from 'express';
import { z } from 'zod';
import { currentSession, handle } from '../auth/middleware.js';
import { runtimeFor } from '../auth/runtime.js';
import type { ApiDeps } from '../deps.js';
import { DEFAULT_BLOB_ROOT } from '../mail/index.js';

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
  let devSeedBlobs: BlobStore | null = null;

  // A minimal, valid RFC 5322 message — just enough for verify/parse/classify to have something
  // real to read. Bodies are plain ASCII, so no base64 wrapping is needed (unlike admin-dev's
  // seed route, which also handles HTML and attachments).
  const buildSimpleMessage = (opts: { from: string; to: string; subject: string; messageId: string; date: Date }): Buffer =>
    Buffer.from(
      `From: ${opts.from}\r\n` +
        `To: ${opts.to}\r\n` +
        `Subject: ${opts.subject}\r\n` +
        `Date: ${opts.date.toUTCString().replace('GMT', '+0000')}\r\n` +
        `Message-ID: ${opts.messageId}\r\n` +
        'MIME-Version: 1.0\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        '\r\n' +
        'This message was seeded to demonstrate a stalled inbound job and its replay.\r\n',
      'utf8',
    );

  // POST /api/admin/jobs/dev-seed-failure — e2e only (POSTROOM_E2E_SEED=1, same gate as
  // admin-dev/index.ts's seed route): a REAL spooled message — a real encrypted blob (through the
  // same blobstore + KEK the pipeline reads), addressed to the caller's own account — marked
  // `failed` with no pipeline stage ever having run, plus a matching dead 'inbound' job. Nothing
  // about the message itself is broken: the "failure" is exactly what a worker crash before the
  // first stage looks like, so replaying it from the Jobs screen runs the real pipeline end to end
  // and actually files a copy — this is what e2e/tests/admin-health.spec.ts and
  // apps/worker/test/integration/admin-replay-refiles.test.ts both rely on.
  router.post(
    '/dev-seed-failure',
    handle(async (req, res) => {
      if (deps.env['POSTROOM_E2E_SEED'] !== '1') {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (rt.kek === null) {
        res.status(503).json({ error: 'blobstore_not_configured', message: 'POSTROOM_KEK is not set' });
        return;
      }
      const me = currentSession(req);
      const address = await db.address.findFirst({ where: { accountId: me.accountId }, include: { domain: true }, orderBy: { createdAt: 'asc' } });
      const to = address === null ? 'me@localhost' : `${address.localPart}@${address.domain.name}`;
      const root = deps.env['BLOB_ROOT']?.trim() ?? '';
      devSeedBlobs ??= createBlobStore({ root: root === '' ? DEFAULT_BLOB_ROOT : root, db, kek: rt.kek });
      const store = devSeedBlobs;
      const now = rt.now();
      const messageId = `<${randomUUID()}@e2e.postroom.invalid>`;
      const raw = buildSimpleMessage({ from: 'Sender <sender@example.org>', to, subject: 'Seeded failure (dev-seed-failure)', messageId, date: now });

      const seeded = await audited(
        db,
        { kind: 'account', accountId: me.accountId },
        { action: 'admin.dev.seed-failure', entityType: 'inbound_message', context: getAuditContext(req) },
        async (tx) => {
          const put = await store.put(raw, { tx });
          const inbound = await tx.inboundMessage.create({
            data: {
              envelopeFrom: 'sender@example.org',
              // The same shape smtp-in resolves at RCPT time (apps/worker/src/stages/file.ts's
              // parseRecipients): one real recipient, the caller's own account.
              recipients: [{ rcpt: to, address: to, accountIds: [me.accountId], kind: 'mailbox' }],
              blobSha256: put.sha256,
              size: put.size,
              state: InboundState.failed,
              disposition: 'accept',
              dispositionReason: 'DMARC pass',
              verdicts: {
                spf: { result: 'pass', domain: 'example.org', scope: 'mfrom', reasons: ['spf pass'] },
                dkim: [{ result: 'pass', domain: 'example.org', selector: 's1', testing: false, reasons: ['body hash ok'] }],
                dmarc: { result: 'pass', disposition: 'none', fromDomain: 'example.org', sampled: true, reasons: ['aligned dkim pass'] },
                arc: { result: 'none', instances: 0, sealerDomains: [], temporary: false, reasons: [] },
                dnsbl: null,
                decision: { action: 'accept', rule: 'dmarc-pass', disposition: 'accept', reasons: ['DMARC pass'] },
              },
              // Not a real crash — no pipeline stage has a marker yet, so a replay from any stage
              // just runs the whole pipeline in order, same as a fresh spool row would.
              lastError: 'Error: simulated worker crash before any pipeline stage ran (dev-seed-failure)',
            },
          });
          const job = await tx.job.create({
            data: {
              queue: INBOUND_QUEUE,
              payload: { inboundMessageId: inbound.id },
              status: JobStatus.dead,
              attempts: 5,
              maxAttempts: 5,
              lastError: 'Error: simulated worker crash before any pipeline stage ran (dev-seed-failure)',
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
