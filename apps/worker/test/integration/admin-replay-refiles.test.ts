// PST-T-7.6, PST-REQ-128: proves "replay re-files" against the real pipeline, not just the enqueue.
//
// apps/api/src/admin-jobs/index.ts's POST /api/admin/jobs/dev-seed-failure builds a REAL spooled
// message — a real encrypted blob through the blobstore, a real recipient (an actual account) — and
// marks it `failed` with a dead 'inbound' job, but with no pipeline stage marker ever recorded. This
// test reproduces that exact fixture (so a regression in either place breaks it) and then does what
// the admin Jobs screen's Replay action does — apps/api/src/admin-jobs/index.ts's
// `POST /api/admin/jobs/inbound/:id/replay` enqueues `{ inboundMessageId, replayFrom }` on the same
// 'inbound' queue with the same idempotency-key shape — and runs the real worker pipeline handler on
// it, asserting a Message copy now exists in the operator's mailbox with its verdict.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { InboundState, JobStatus, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { enqueue, startWorker, type RunningWorker } from '@postroom/queue';
import { createInboundPipeline, INBOUND_QUEUE } from '../../src/pipeline.js';
import { STAGES } from '../../src/stages/types.js';
import { Clock } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

/** Mirrors apps/api/src/admin-jobs/index.ts's buildSimpleMessage exactly. */
function buildSimpleMessage(opts: { from: string; to: string; subject: string; messageId: string; date: Date }): Buffer {
  return Buffer.from(
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
}

const PASS_VERDICTS = {
  spf: { result: 'pass', domain: 'example.org', scope: 'mfrom', reasons: ['spf pass'] },
  dkim: [{ result: 'pass', domain: 'example.org', selector: 's1', testing: false, reasons: ['body hash ok'] }],
  dmarc: { result: 'pass', disposition: 'none', fromDomain: 'example.org', sampled: true, reasons: ['aligned dkim pass'] },
  arc: { result: 'none', instances: 0, sealerDomains: [], temporary: false, reasons: [] },
  dnsbl: null,
  decision: { action: 'accept', rule: 'dmarc-pass', disposition: 'accept', reasons: ['DMARC pass'] },
};

describe.skipIf(baseUrl === undefined)('admin replay re-files a dev-seed-failure fixture (PST-T-7.6, PST-REQ-128)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  const clock = new Clock();
  let operatorId = '';
  let to = '';
  let worker: RunningWorker;

  /** Exactly what POST /api/admin/jobs/dev-seed-failure creates. */
  const seedFailure = async (): Promise<{ inboundMessageId: string; jobId: string }> => {
    const messageId = `<${randomUUID()}@e2e.postroom.invalid>`;
    const raw = buildSimpleMessage({ from: 'Sender <sender@example.org>', to, subject: 'Seeded failure (dev-seed-failure)', messageId, date: clock.now() });
    return db.$transaction(async (tx) => {
      const put = await blobs.put(raw, { tx });
      const inbound = await tx.inboundMessage.create({
        data: {
          envelopeFrom: 'sender@example.org',
          recipients: [{ rcpt: to, address: to, accountIds: [operatorId], kind: 'mailbox' }],
          blobSha256: put.sha256,
          size: put.size,
          state: InboundState.failed,
          disposition: 'accept',
          dispositionReason: 'DMARC pass',
          verdicts: PASS_VERDICTS,
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
      return { inboundMessageId: inbound.id, jobId: job.id };
    });
  };

  /** What POST /api/admin/jobs/inbound/:id/replay does. */
  const replayFromStage = (inboundMessageId: string, fromStage: (typeof STAGES)[number]) =>
    db.$transaction((tx) =>
      enqueue(tx, INBOUND_QUEUE, { inboundMessageId, replayFrom: fromStage }, { idempotencyKey: `inbound:${inboundMessageId}:replay:${fromStage}:${randomUUID()}` }),
    );

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t76_replay');
    db = t.db;
    const seeded = await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    operatorId = seeded.operatorId;
    // Not looked up from an Address row: the file stage addresses by accountId, the same way
    // pipeline.test.ts's `to.matt()` names 'matt@d3cloud.io' without one existing as a row either.
    to = 'operator@d3cloud.io';
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t76-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    worker = await startWorker({
      db,
      databaseUrl: t.url,
      queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs, now: clock.now }).handle },
      manual: true,
      now: clock.now,
    });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('a fixture built the way dev-seed-failure builds it has no pipeline stage recorded yet', async () => {
    const { inboundMessageId, jobId } = await seedFailure();
    const inbound = await db.inboundMessage.findUniqueOrThrow({ where: { id: inboundMessageId } });
    expect(inbound.state).toBe(InboundState.failed);
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe('dead');
    // Nothing to clear: this is what a worker crash before the first stage looks like, not a
    // permanently-broken message. No pipeline key means every stage still has to run.
    expect((inbound.verdicts as Record<string, unknown>)['pipeline']).toBeUndefined();
  });

  it('Replay from "file" runs the whole pipeline (nothing was marked done yet) and files a real copy', async () => {
    const { inboundMessageId, jobId } = await seedFailure();
    const enqueued = await replayFromStage(inboundMessageId, 'file');
    expect(enqueued).not.toBeNull();

    expect(await worker.drain()).toBe(1);

    const copies = await db.message.findMany({
      where: { inboundMessageId },
      include: { mailbox: { select: { accountId: true, name: true, specialUse: true } }, verdict: true },
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]?.mailbox).toMatchObject({ accountId: operatorId, name: 'INBOX', specialUse: 'inbox' });
    expect(copies[0]?.subject).toBe('Seeded failure (dev-seed-failure)');
    expect(copies[0]?.verdict).not.toBeNull();
    expect(copies[0]?.verdict?.reasons).toEqual(expect.arrayContaining([`delivered to ${to}`]));

    const inbound = await db.inboundMessage.findUniqueOrThrow({ where: { id: inboundMessageId } });
    expect(inbound.state).toBe(InboundState.filed);
    expect(inbound.lastError).toBeNull();

    const replayedJob = await db.job.findFirstOrThrow({
      where: { queue: INBOUND_QUEUE, payload: { path: ['inboundMessageId'], equals: inboundMessageId }, status: 'done' },
    });
    expect(replayedJob.payload).toMatchObject({ inboundMessageId, replayFrom: 'file' });

    // The original dead job is untouched: replaying from the message enqueues a fresh job rather
    // than resurrecting the one that never ran (apps/api/src/admin-jobs/index.ts's two replay
    // routes are deliberately different for exactly this reason).
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('dead');
  });

  it('replaying a second time (idempotent stages) still finds exactly one copy', async () => {
    const { inboundMessageId } = await seedFailure();
    await replayFromStage(inboundMessageId, 'file');
    await worker.drain();
    await replayFromStage(inboundMessageId, 'file');
    await worker.drain();
    expect(await db.message.count({ where: { inboundMessageId } })).toBe(1);
  });
});
