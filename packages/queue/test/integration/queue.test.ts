import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { claim, complete, enqueue, fail, replay, startWorker } from '../../src/index.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('job queue', () => {
  let t: TestDatabase;
  beforeAll(async () => { t = await createTestDatabase(baseUrl ?? '', 'pst_queue'); }, 120_000);
  afterAll(async () => { await t.drop(); });

  it('is idempotent by key', async () => {
    expect(await enqueue(t.db, 'q1', { n: 1 }, { idempotencyKey: 'k1' })).not.toBeNull();
    expect(await enqueue(t.db, 'q1', { n: 1 }, { idempotencyKey: 'k1' })).toBeNull();
    expect(await t.db.job.count({ where: { queue: 'q1' } })).toBe(1);
  });

  it('never hands one job to two workers', async () => {
    for (let i = 0; i < 20; i++) await enqueue(t.db, 'q2', { i });
    const claims = await Promise.all(Array.from({ length: 40 }, (_, i) => claim(t.db, 'q2', { workerId: `w${i}` })));
    const ids = claims.filter((j) => j !== null).map((j) => j.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it('retries with backoff, then goes dead, and can be replayed', async () => {
    await enqueue(t.db, 'q3', {}, { maxAttempts: 2 });
    const now = new Date();
    const first = await claim(t.db, 'q3', { workerId: 'w', now });
    if (first === null) throw new Error('no job');
    expect(await fail(t.db, first, new Error('boom'), { retryAt: now })).toBe('retry');
    const second = await claim(t.db, 'q3', { workerId: 'w', now: new Date(now.getTime() + 1000) });
    if (second === null) throw new Error('no retry');
    expect(second.attempts).toBe(2);
    expect(await fail(t.db, second, new Error('boom'))).toBe('dead');
    expect((await t.db.job.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('dead');
    await replay(t.db, second.id);
    const again = await claim(t.db, 'q3', { workerId: 'w' });
    expect(again?.id).toBe(second.id);
    if (again !== null) await complete(t.db, again);
  });

  it('reclaims a job whose worker died mid-run', async () => {
    await enqueue(t.db, 'q4', {});
    const now = new Date();
    const taken = await claim(t.db, 'q4', { workerId: 'dead-worker', now });
    expect(taken).not.toBeNull();
    expect(await claim(t.db, 'q4', { workerId: 'w2', now, leaseMs: 60_000 })).toBeNull();
    const later = new Date(now.getTime() + 120_000);
    const retaken = await claim(t.db, 'q4', { workerId: 'w2', now: later, leaseMs: 60_000 });
    expect(retaken?.id).toBe(taken?.id);
  });

  it('a worker is woken by NOTIFY and runs the handler once per job', async () => {
    const seen: number[] = [];
    const worker = await startWorker({
      db: t.db,
      databaseUrl: t.url,
      pollMs: 60_000,
      queues: { q5: (job) => { seen.push((job.payload as { n: number }).n); return Promise.resolve(); } },
    });
    await enqueue(t.db, 'q5', { n: 1 });
    await enqueue(t.db, 'q5', { n: 2 });
    for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    await worker.stop();
    expect(seen.sort()).toEqual([1, 2]);
    expect(await t.db.job.count({ where: { queue: 'q5', status: 'done' } })).toBe(2);
  });
});
