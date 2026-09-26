// PST-REQ-075 against a real database: every failure is an audit_event row, and the tarpit is
// computed from those rows, so two daemons (two throttle instances) see one streak.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { createAuthThrottle, type AuthAttempt, type Sleep } from '../../src/index.js';

const baseUrl = process.env['DATABASE_URL'];
const SECRET = 'correct horse battery staple';

describe.skipIf(baseUrl === undefined)('auth throttle on the audit log', () => {
  let t: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t34');
    db = t.db;
  });

  afterAll(async () => {
    await t.drop();
  });

  const recording = (): { sleep: Sleep; slept: number[] } => {
    const slept: number[] = [];
    return {
      slept,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    };
  };

  it('ten failures: ten audit rows with the right fields and no password, and increasing delays', async () => {
    const { sleep } = recording();
    const throttle = createAuthThrottle({ db, sleep });
    const attempt: AuthAttempt = { protocol: 'imap', username: 'Carol@D3cloud.io', ip: '192.0.2.44' };
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      delays.push((await throttle.before(attempt)).delayMs);
      await throttle.failure(attempt, 'bad-password');
    }
    expect(delays).toEqual([0, 0, 0, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    const rows = await db.auditEvent.findMany({ where: { action: 'auth.failure', entityId: 'carol@d3cloud.io' }, orderBy: { at: 'asc' } });
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row).toMatchObject({
        actorKind: 'anonymous',
        actorAccountId: null,
        action: 'auth.failure',
        entityType: 'credential',
        entityId: 'carol@d3cloud.io',
        ip: '192.0.2.44',
        before: null,
        after: { protocol: 'imap', username: 'carol@d3cloud.io', network: '192.0.2.0/24', source: '192.0.2.44', reason: 'bad-password' },
      });
      expect(row.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it('two instances (two daemon containers) share one streak through the database', async () => {
    const a = recording();
    const b = recording();
    const imap = createAuthThrottle({ db, sleep: a.sleep });
    const submission = createAuthThrottle({ db, sleep: b.sleep });
    const who = (protocol: string): AuthAttempt => ({ protocol, username: 'dave@d3cloud.io', ip: '2001:db8:7:7::10' });

    for (let i = 0; i < 3; i++) await imap.failure(who('imap'), 'bad-password');
    for (let i = 0; i < 2; i++) await submission.failure({ ...who('submission'), ip: '2001:db8:7:7::99' }, 'bad-password');
    // Five failures in the same /64, split across daemons: either one now waits 4 s.
    expect(await submission.before(who('submission'))).toMatchObject({ outcome: 'proceed', streak: 5, delayMs: 4_000 });
    expect(await imap.before(who('imap'))).toMatchObject({ streak: 5, delayMs: 4_000 });
    expect(b.slept).toEqual([4_000]);
    expect(a.slept).toEqual([4_000]);

    // A success resets that daemon's streak; the rows stay.
    await imap.success(who('imap'));
    expect(await imap.before(who('imap'))).toMatchObject({ streak: 0, delayMs: 0 });
    expect(await db.auditEvent.count({ where: { action: 'auth.failure', entityId: 'dave@d3cloud.io' } })).toBe(5);
  });

  it('many usernames from one source trip the ceiling for every instance', async () => {
    const one = createAuthThrottle({ db, sleep: recording().sleep });
    const two = createAuthThrottle({ db, sleep: recording().sleep });
    for (let i = 0; i < 20; i++) {
      await (i % 2 === 0 ? one : two).failure({ protocol: 'managesieve', username: `spray${String(i)}@d3cloud.io`, ip: '203.0.113.200' }, 'unknown-user');
    }
    expect(await two.before({ protocol: 'dav', username: 'new@d3cloud.io', ip: '203.0.113.200' })).toMatchObject({
      outcome: 'refuse',
      delayMs: 30_000,
      sourceFailures: 20,
    });
  });
});
