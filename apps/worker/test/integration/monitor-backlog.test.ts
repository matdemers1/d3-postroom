// PST-REQ-097: the backlog monitor against real outbound `job` and `inbound_message` rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboundState, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { enqueue } from '@postroom/queue';
import { createBacklogMonitor } from '../../src/monitors/backlog.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('backlog monitor (PST-REQ-097)', () => {
  let t: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t47_backlog');
    db = t.db;
  }, 30_000);

  afterAll(async () => {
    await t.drop();
  });

  it('is ok with nothing queued, fires once the count crosses the threshold, clears once drained', async () => {
    const monitor = createBacklogMonitor({ db, threshold: 2, maxAgeS: 3_600 });
    expect((await monitor.check()).ok).toBe(true);

    await enqueue(db, 'outbound', { messageId: 'm1', domain: 'example.org' });
    await enqueue(db, 'outbound', { messageId: 'm2', domain: 'example.org' });
    await enqueue(db, 'outbound', { messageId: 'm3', domain: 'example.org' });
    const firing = await monitor.check();
    expect(firing.ok).toBe(false);
    expect(firing.detail).toMatch(/outbound=3/);

    await db.job.updateMany({ where: { queue: 'outbound' }, data: { status: 'done' } });
    const clear = await monitor.check();
    expect(clear.ok).toBe(true);
  });

  it('fires on age alone even under the count threshold', async () => {
    const monitor = createBacklogMonitor({ db, threshold: 1_000, maxAgeS: 1 });
    await db.inboundMessage.create({
      data: {
        envelopeFrom: 'alice@example.org',
        recipients: [],
        blobSha256: 'a'.repeat(64),
        size: 10,
        state: InboundState.spooled,
      },
    });
    await new Promise((r) => setTimeout(r, 1_100));
    const result = await monitor.check();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/oldest=/);
  });
});
