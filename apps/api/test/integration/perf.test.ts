// PST-T-11.3 (PST-REQ-157): the performance budget for a 50,000-message INBOX — proven against a
// real, seeded database, not a toy one. Three reads a mailbox screen makes on every load:
//   - GET /api/mailboxes/:id/messages   the first page, and page 2 via its cursor;
//   - GET /api/mailboxes                every mailbox ("bucket")'s total/unseen counts;
//   - GET /api/threads/:id              a thread's messages and its message count.
// Each is timed over 50 runs; p95 must clear PERF_BUDGET_MS (default 150, overridable for a slower
// CI runner). A second block runs EXPLAIN (ANALYZE, FORMAT JSON) on the same shapes of query and
// asserts no Seq Scan ever touches the message table — the 50k rows are meaningless as a budget
// proof if the plan would have been the same at 50.
import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { MailboxList, MessageList, ThreadDetail } from '../../src/mail/schemas.js';
import { request } from '../loopback.js';
import { TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';
// scripts/perf-seed.mjs is a plain JS operator tool (it runs with plain `node`, no build step);
// this test calls its exported function directly to prove the doneWhen — the same function the
// CLI entry point calls. Typed by the sibling perf-seed.d.mts.
import { DEFAULT_SENDERS, DEFAULT_THREADS, seedInbox } from '../../../../scripts/perf-seed.mjs';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const PERF_BUDGET_MS = Number(process.env['PERF_BUDGET_MS'] ?? 150);
const COUNT = 50_000;
const NOISE_COUNT = 150_000;
const RUNS = 50;

interface Timing {
  name: string;
  samples: number[];
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function printTable(timings: readonly Timing[]): void {
  const rows = timings.map((t) => ({
    query: t.name,
    runs: t.samples.length,
    'p50 (ms)': p95(t.samples.filter((_v, i) => i < Math.ceil(t.samples.length / 2))).toFixed(2),
    'p95 (ms)': p95(t.samples).toFixed(2),
    'max (ms)': Math.max(...t.samples).toFixed(2),
    'budget (ms)': PERF_BUDGET_MS,
  }));
  console.table(rows);
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Total Time'?: number;
  Plans?: PlanNode[];
}

interface ExplainRow {
  'QUERY PLAN': { Plan: PlanNode }[];
}

function seqScanOnMessage(node: PlanNode): boolean {
  if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'message') return true;
  return (node.Plans ?? []).some(seqScanOnMessage);
}

describe.skipIf(!baseUrl)('mailbox performance budget at 50k messages (PST-T-11.3, PST-REQ-157)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let accountId: string;
  let inboxId: string;
  let threadId: string;
  let cookie: string;
  let guardMissesBefore = 0;

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t113_perf');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });

    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    accountId = id;
    const inbox = await db.mailbox.create({
      data: { accountId, name: 'INBOX', specialUse: SpecialUse.inbox, uidvalidity: randomUidValidity(randomInt) },
    });
    await db.mailbox.create({ data: { accountId, name: 'Archive', specialUse: SpecialUse.archive, uidvalidity: randomUidValidity(randomInt) } });
    inboxId = inbox.id;

    // Noise: two more accounts' INBOXes, at three times the target's size combined, so the
    // mailbox_id filter the real queries use is actually selective (real deployments have many
    // accounts and mailboxes). Without this, the whole `message` table IS the target mailbox, and
    // a planner picking a Seq Scan there is not wrong — it proves nothing about the index a real,
    // multi-account deployment needs.
    for (let n = 0; n < 2; n++) {
      const noiseLogin = randomLogin();
      const { id: noiseAccountId } = await createAccount(db, { login: noiseLogin, password: PASSWORD });
      const noiseInbox = await db.mailbox.create({
        data: { accountId: noiseAccountId, name: 'INBOX', specialUse: SpecialUse.inbox, uidvalidity: randomUidValidity(randomInt) },
      });
      await seedInbox(db, { accountId: noiseAccountId, mailboxId: noiseInbox.id, count: NOISE_COUNT, threadCount: 20_000, senderCount: 3_000 });
    }

    await seedInbox(db, { accountId, mailboxId: inboxId, count: COUNT, threadCount: DEFAULT_THREADS, senderCount: DEFAULT_SENDERS });
    await db.$executeRaw`ANALYZE message`;
    await db.$executeRaw`ANALYZE mailbox`;
    await db.$executeRaw`ANALYZE thread`;

    const withThread = await db.message.findFirstOrThrow({ where: { mailboxId: inboxId, threadId: { not: null } }, select: { threadId: true } });
    threadId = withThread.threadId ?? '';

    app = createApp({ db, env: { DATABASE_URL: testDb.url }, config: baseConfig(clock) });
    cookie = await signIn(login, totpSecret);
    guardMissesBefore = missingAuditCount.value;
  }, 180_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await testDb.drop();
  });

  it(
    'first page, page 2, mailbox ("bucket") counts and thread counts all answer at p95 under budget',
    async () => {
      const firstPage: number[] = [];
      const secondPage: number[] = [];
      const mailboxCounts: number[] = [];
      const threadCounts: number[] = [];

      let cursor: string | null = null;
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        const res = await request(app).get(`/api/mailboxes/${inboxId}/messages?limit=50`).set('cookie', cookie);
        firstPage.push(performance.now() - t0);
        expect(res.status).toBe(200);
        const page = MessageList.parse(res.body);
        expect(page.messages).toHaveLength(50);
        cursor = page.nextCursor;
      }
      expect(cursor).not.toBeNull();

      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        const res = await request(app).get(`/api/mailboxes/${inboxId}/messages?limit=50&cursor=${cursor ?? ''}`).set('cookie', cookie);
        secondPage.push(performance.now() - t0);
        expect(res.status).toBe(200);
        expect(MessageList.parse(res.body).messages).toHaveLength(50);
      }

      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        const res = await request(app).get('/api/mailboxes').set('cookie', cookie);
        mailboxCounts.push(performance.now() - t0);
        expect(res.status).toBe(200);
        const list = MailboxList.parse(res.body);
        const box = list.mailboxes.find((m) => m.id === inboxId);
        expect(box?.total).toBe(COUNT);
      }

      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        const res = await request(app).get(`/api/threads/${threadId}`).set('cookie', cookie);
        threadCounts.push(performance.now() - t0);
        expect(res.status).toBe(200);
        const thread = ThreadDetail.parse(res.body);
        expect(thread.messageCount).toBeGreaterThan(0);
      }

      printTable([
        { name: 'GET /api/mailboxes/:id/messages (first page)', samples: firstPage },
        { name: 'GET /api/mailboxes/:id/messages (page 2, cursor)', samples: secondPage },
        { name: 'GET /api/mailboxes (bucket counts)', samples: mailboxCounts },
        { name: 'GET /api/threads/:id (thread counts)', samples: threadCounts },
      ]);

      expect(p95(firstPage)).toBeLessThan(PERF_BUDGET_MS);
      expect(p95(secondPage)).toBeLessThan(PERF_BUDGET_MS);
      expect(p95(mailboxCounts)).toBeLessThan(PERF_BUDGET_MS);
      expect(p95(threadCounts)).toBeLessThan(PERF_BUDGET_MS);
    },
    120_000,
  );

  it('EXPLAIN shows index scans for the list and count queries — no Seq Scan on message', async () => {
    const listPlan = await db.$queryRawUnsafe<ExplainRow[]>(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM message WHERE mailbox_id = '${inboxId}'::uuid ORDER BY uid DESC LIMIT 51`,
    );
    const bucketCountsPlan = await db.$queryRawUnsafe<ExplainRow[]>(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT mailbox_id, count(*), count(*) FILTER (WHERE NOT ('\\Seen' = ANY(flags))) FROM message WHERE mailbox_id = ANY(ARRAY['${inboxId}']::uuid[]) GROUP BY mailbox_id`,
    );
    const threadCountsPlan = await db.$queryRawUnsafe<ExplainRow[]>(
      `EXPLAIN (ANALYZE, FORMAT JSON) SELECT m.* FROM message m JOIN mailbox mb ON mb.id = m.mailbox_id WHERE m.thread_id = '${threadId}'::uuid AND mb.account_id = '${accountId}'::uuid`,
    );

    for (const [label, plan] of [
      ['list', listPlan],
      ['bucket counts', bucketCountsPlan],
      ['thread counts', threadCountsPlan],
    ] as const) {
      const root = plan[0]?.['QUERY PLAN'][0]?.Plan;
      expect(root, `${label} plan`).toBeDefined();
      if (root === undefined) continue;
      console.log(label, JSON.stringify({ 'Node Type': root['Node Type'], 'Actual Total Time': root['Actual Total Time'] }));
      expect(seqScanOnMessage(root), `${label}: a Seq Scan on message`).toBe(false);
    }
  });
});
