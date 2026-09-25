// The outbound queue against a real database with an injected clock: no test here waits in real time.
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { cancelRecipient, CannotCancelError } from '../../src/cancel.js';
import { enqueueOutbound, OUTBOUND_QUEUE, outboundJobKey } from '../../src/enqueue.js';
import { deliveryHealth } from '../../src/health.js';
import { baseDelayMs, DELAY_DSN_AFTER_MS, JITTER, MAX_QUEUE_AGE_MS, type DsnIntent } from '../../src/state.js';
import { FakeTransport, reply, type FakeScript } from '../../src/transports/fake.js';
import { createDeliveryWorker, INTERRUPTED } from '../../src/worker.js';

const baseUrl = process.env['DATABASE_URL'];
const T0 = new Date('2026-09-25T12:00:00Z');
const BODY = 'Subject: hi\r\n\r\nbody\r\n';

describe.skipIf(baseUrl === undefined)('outbound queue', () => {
  let t: TestDatabase;
  let accountId: string;
  let clock: Date;
  const dsns: { kind: string; address: string; at: Date }[] = [];

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t15');
    accountId = (await t.db.account.create({ data: { displayName: 'Sender' } })).id;
  }, 120_000);
  afterAll(async () => { await t.drop(); });

  function setup(script: FakeScript, leaseMs = 300_000): { worker: Promise<RunningWorker>; fake: FakeTransport; sweep: () => Promise<unknown> } {
    const fake = new FakeTransport({ script, readMessage: true });
    const delivery = createDeliveryWorker({
      db: t.db,
      transports: { direct: fake },
      openMessage: () => Promise.resolve(Readable.from([Buffer.from(BODY)])),
      onDsn: (intent: DsnIntent) => { dsns.push({ kind: intent.kind, address: intent.address, at: intent.at }); return Promise.resolve(); },
      now: () => clock,
      leaseMs,
      attemptTimeoutMs: leaseMs - 1,
    });
    const worker = startWorker({ db: t.db, databaseUrl: t.url, manual: true, now: () => clock, leaseMs, queues: { [OUTBOUND_QUEUE]: delivery.handle } });
    return { worker, fake, sweep: delivery.sweep };
  }

  async function submit(recipients: string[], notify?: string): Promise<string> {
    const { message } = await t.db.$transaction((tx) => enqueueOutbound(tx, {
      accountId,
      envelopeFrom: 'me@d3cloud.io',
      headerFrom: 'me@d3cloud.io',
      blobSha256: 'a'.repeat(64),
      size: BODY.length,
      submittedVia: 'test',
      recipients: recipients.map((address) => ({ address, ...(notify === undefined ? {} : { notify }) })),
    }, { now: clock }));
    return message.id;
  }

  it('groups recipients by lowercased domain: one job per domain, deduplicated', async () => {
    clock = new Date(T0);
    const id = await submit(['a@Example.COM', 'b@example.com', 'a@example.com', 'c@other.test']);
    const recipients = await t.db.outboundRecipient.findMany({ where: { outboundMessageId: id }, orderBy: { address: 'asc' } });
    expect(recipients.map((r) => [r.address, r.domain, r.state, r.transport])).toEqual([
      ['a@example.com', 'example.com', 'queued', 'direct'],
      ['b@example.com', 'example.com', 'queued', 'direct'],
      ['c@other.test', 'other.test', 'queued', 'direct'],
    ]);
    const jobs = await t.db.job.findMany({ where: { idempotencyKey: { startsWith: `outbound:${id}:` } }, orderBy: { idempotencyKey: 'asc' } });
    expect(jobs.map((j) => j.idempotencyKey)).toEqual([outboundJobKey(id, 'example.com', 0), outboundJobKey(id, 'other.test', 0)]);
    // Leave nothing runnable for the next test.
    await t.db.job.deleteMany({ where: { queue: OUTBOUND_QUEUE } });
    await t.db.outboundRecipient.updateMany({ where: { outboundMessageId: id }, data: { state: 'cancelled' } });
  });

  it('simulated 451s follow the schedule: delay DSN once at ≥ 4h, bounce + failure DSN at 5 days', async () => {
    clock = new Date(T0);
    dsns.length = 0;
    const { worker: w, fake } = setup(() => reply.tempfail('4.3.0 greylisted'));
    const worker = await w;
    const id = await submit(['grey@greylist.test']);

    const attemptTimes: number[] = [];
    for (let i = 0; i < 200; i++) {
      const ran = await worker.drain();
      expect(ran).toBeGreaterThan(0);
      attemptTimes.push(clock.getTime());
      const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: id } });
      if (r.state === 'bounced') break;
      expect(r.state).toBe('deferred');
      expect(r.lastCode).toBe(451);
      // A moment before it is due, nothing runs.
      clock = new Date(r.nextAttemptAt.getTime() - 1);
      expect(await worker.drain()).toBe(0);
      clock = new Date(r.nextAttemptAt);
    }
    const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: id } });
    expect(r.state).toBe('bounced');
    expect(clock.getTime()).toBe(T0.getTime() + MAX_QUEUE_AGE_MS);
    expect(r.attempts).toBe(attemptTimes.length);
    expect(fake.calls).toHaveLength(attemptTimes.length);
    expect(fake.calls.every((c) => c.bytes === BODY.length)).toBe(true);

    // Every attempt has a closed DeliveryAttempt row at the time the schedule said.
    const attempts = await t.db.deliveryAttempt.findMany({ where: { recipientId: r.id }, orderBy: { startedAt: 'asc' } });
    expect(attempts.map((a) => a.startedAt.getTime())).toEqual(attemptTimes);
    expect(attempts.every((a) => a.finishedAt !== null && a.remoteCode === 451 && a.mxHost === 'mx.fake.test' && a.transport === 'fake')).toBe(true);
    expect(attempts.slice(0, -1).every((a) => a.outcome === 'deferred')).toBe(true);
    expect(attempts.at(-1)?.outcome).toBe('bounced');
    for (let k = 1; k < attemptTimes.length; k++) {
      const gap = (attemptTimes[k] ?? 0) - (attemptTimes[k - 1] ?? 0);
      const base = baseDelayMs(k);
      expect(gap).toBeLessThanOrEqual(Math.round(base * (1 + JITTER)));
      if (k < attemptTimes.length - 1) expect(gap).toBeGreaterThanOrEqual(Math.round(base * (1 - JITTER)));
    }
    // The first retries follow the table: ~5m, ~10m, ~20m.
    expect((attemptTimes[1] ?? 0) - T0.getTime()).toBeGreaterThanOrEqual(0.85 * 5 * 60_000);

    // DSN intents: one delay (the first attempt at ≥ 4h), one failure at the bounce.
    expect(dsns.map((d) => d.kind)).toEqual(['delay', 'failure']);
    const firstAfter4h = attemptTimes.find((at) => at - T0.getTime() >= DELAY_DSN_AFTER_MS);
    expect(dsns[0]?.at.getTime()).toBe(firstAfter4h);
    expect(dsns[1]?.at.getTime()).toBe(T0.getTime() + MAX_QUEUE_AGE_MS);
    expect(r.delayDsnSentAt).not.toBeNull();
    expect(r.failureDsnSentAt).not.toBeNull();

    // Nothing left to run.
    clock = new Date(clock.getTime() + 30 * 24 * 3600_000);
    expect(await worker.drain()).toBe(0);
    await worker.stop();
  });

  it('mixed outcomes in one domain group: one SMTP transaction, 250 → delivered, 550 → bounced, 451 → deferred', async () => {
    clock = new Date(T0);
    dsns.length = 0;
    const { worker: w, fake } = setup((rcpt) => {
      if (rcpt.address.startsWith('ok@')) return reply.ok();
      if (rcpt.address.startsWith('gone@')) return reply.reject();
      return reply.tempfail();
    });
    const worker = await w;
    const id = await submit(['ok@mixed.test', 'gone@mixed.test', 'later@mixed.test']);
    expect(await worker.drain()).toBe(1);
    expect(fake.calls).toEqual([{ domain: 'mixed.test', addresses: ['gone@mixed.test', 'later@mixed.test', 'ok@mixed.test'], bytes: BODY.length }]);
    const rs = await t.db.outboundRecipient.findMany({ where: { outboundMessageId: id }, orderBy: { address: 'asc' } });
    expect(rs.map((r) => [r.address, r.state, r.lastCode])).toEqual([
      ['gone@mixed.test', 'bounced', 550],
      ['later@mixed.test', 'deferred', 451],
      ['ok@mixed.test', 'delivered', 250],
    ]);
    expect(rs[2]?.deliveredAt).toEqual(T0);
    expect(dsns.map((d) => [d.kind, d.address])).toEqual([['failure', 'gone@mixed.test']]);
    const attempts = await t.db.deliveryAttempt.findMany({ where: { recipient: { outboundMessageId: id } }, include: { recipient: true } });
    expect(attempts.map((a) => [a.recipient.address, a.outcome]).sort()).toEqual([
      ['gone@mixed.test', 'bounced'],
      ['later@mixed.test', 'deferred'],
      ['ok@mixed.test', 'delivered'],
    ]);
    // Only the deferred recipient is retried, alone, at its time.
    const next = await t.db.job.findFirstOrThrow({ where: { idempotencyKey: outboundJobKey(id, 'mixed.test', 1) } });
    expect(next.runAt).toEqual(rs[1]?.nextAttemptAt);
    clock = new Date(next.runAt);
    expect(await worker.drain()).toBe(1);
    expect(fake.calls[1]?.addresses).toEqual(['later@mixed.test']);
    await t.db.job.deleteMany({ where: { queue: OUTBOUND_QUEUE } });
    await t.db.outboundRecipient.updateMany({ where: { outboundMessageId: id, state: 'deferred' }, data: { state: 'cancelled' } });
    await worker.stop();
  });

  it('cancels queued and deferred recipients only', async () => {
    clock = new Date(T0);
    const id = await submit(['x@cancel.test']);
    const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: id } });
    const write = await t.db.$transaction((tx) => cancelRecipient(tx, r.id));
    expect(write.before.state).toBe('queued');
    expect(write.after.state).toBe('cancelled');
    await expect(t.db.$transaction((tx) => cancelRecipient(tx, r.id))).rejects.toBeInstanceOf(CannotCancelError);
    // Its job runs and attempts nothing.
    const { worker: w, fake } = setup(() => reply.ok());
    const worker = await w;
    expect(await worker.drain()).toBe(1);
    expect(fake.calls).toHaveLength(0);
    await worker.stop();
  });

  it('recovers an attempt interrupted by a crash, and gives a group whose job died a new one', async () => {
    clock = new Date(T0);
    const leaseMs = 60_000;
    const id = await submit(['crash@recover.test']);
    const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: id } });
    // What a kill -9 mid-attempt leaves behind: attempting, an open attempt, the job dead in the water.
    await t.db.outboundRecipient.update({ where: { id: r.id }, data: { state: 'attempting', attempts: 1, updatedAt: clock } });
    await t.db.deliveryAttempt.create({ data: { recipientId: r.id, startedAt: clock, transport: 'fake', outcome: 'error', error: 'in flight' } });
    await t.db.job.updateMany({ where: { idempotencyKey: outboundJobKey(id, 'recover.test', 0) }, data: { status: 'dead' } });

    const { worker: w, fake, sweep } = setup(() => reply.ok(), leaseMs);
    const worker = await w;
    expect(await sweep()).toEqual({ recovered: 0, rescheduled: 0, dsnRetried: 0 });
    clock = new Date(T0.getTime() + leaseMs + 1);
    expect(await sweep()).toMatchObject({ recovered: 1, rescheduled: 1 });
    expect(await worker.drain()).toBe(1);
    expect(fake.calls).toHaveLength(1);
    const after = await t.db.outboundRecipient.findUniqueOrThrow({ where: { id: r.id } });
    expect(after.state).toBe('delivered');
    const attempts = await t.db.deliveryAttempt.findMany({ where: { recipientId: r.id }, orderBy: { startedAt: 'asc' } });
    expect(attempts.map((a) => [a.outcome, a.error])).toEqual([['error', INTERRUPTED], ['delivered', null]]);
    await worker.stop();
  });

  it('reports queue depth and the oldest deferred age', async () => {
    clock = new Date(T0);
    const { worker: w } = setup(() => reply.tempfail());
    const worker = await w;
    await submit(['slow@health.test']);
    await worker.drain();
    const health = await deliveryHealth(t.db, new Date(T0.getTime() + 3600_000));
    expect(health.queueDepth).toBeGreaterThanOrEqual(1);
    expect(health.recipientsDeferred).toBe(1);
    expect(health.oldestDeferredAgeSeconds).toBe(3600);
    await worker.stop();
  });
});
