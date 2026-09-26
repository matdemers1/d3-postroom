// PST-T-2.7, the operator's half: list jobs with their last error, put a dead job back in line, and
// ask for one inbound message's stages to run again — admin only, every replay audited.
import { randomUUID } from 'node:crypto';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { InboundState, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

interface ListedJob {
  id: string;
  queue: string;
  status: string;
  lastError: string | null;
  payload: unknown;
}

describe.skipIf(!baseUrl)('admin jobs and replay (PST-T-2.7)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let admin: { id: string; cookie: string };
  let user: { id: string; cookie: string };
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

  const person = async (isAdmin: boolean): Promise<{ id: string; cookie: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin });
    return { id, cookie: await signIn(login, totpSecret) };
  };

  const spoolRow = async (state: InboundState = InboundState.filed): Promise<string> => {
    const id = randomUUID();
    await db.blob.upsert({
      where: { sha256: 'a'.repeat(64) },
      create: { sha256: 'a'.repeat(64), size: 1, wrappedDek: new Uint8Array(1), kekId: 'k', aead: 'x', nonce: new Uint8Array(1) },
      update: {},
    });
    await db.inboundMessage.create({ data: { id, envelopeFrom: 'a@example.org', recipients: [], blobSha256: 'a'.repeat(64), size: 1, state } });
    return id;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t27');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    admin = await person(true);
    user = await person(false);
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('is admin only: 401 without a session, 403 for a non-admin', async () => {
    expect((await request(app).get('/api/admin/jobs')).status).toBe(401);
    const id = await spoolRow();
    for (const [method, path] of [
      ['get', '/api/admin/jobs'],
      ['post', `/api/admin/jobs/${randomUUID()}/replay`],
      ['post', `/api/admin/jobs/inbound/${id}/replay`],
    ] as const) {
      const res = await request(app)[method](path).set(CSRF).set('cookie', user.cookie).send({ fromStage: 'file' });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(await db.job.count({ where: { queue: 'inbound' } })).toBe(0);
  });

  it('lists jobs by status with their last error, and replays a dead one (audited)', async () => {
    const dead = await db.job.create({ data: { queue: 'inbound', payload: { inboundMessageId: randomUUID() }, status: 'dead', attempts: 10, lastError: 'Error: blob missing' } });
    await db.job.create({ data: { queue: 'outbound', payload: {}, status: 'pending' } });

    const listed = await request(app).get('/api/admin/jobs?status=dead').set('cookie', admin.cookie);
    expect(listed.status).toBe(200);
    const jobs = (listed.body as { jobs: ListedJob[] }).jobs;
    expect(jobs.map((j) => j.id)).toEqual([dead.id]);
    expect(jobs[0]).toMatchObject({ queue: 'inbound', status: 'dead', lastError: 'Error: blob missing' });
    expect((await request(app).get('/api/admin/jobs?status=bogus').set('cookie', admin.cookie)).status).toBe(400);

    const replayed = await request(app).post(`/api/admin/jobs/${dead.id}/replay`).set(CSRF).set('cookie', admin.cookie);
    expect(replayed.status).toBe(202);
    const after = await db.job.findUniqueOrThrow({ where: { id: dead.id } });
    expect(after).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'admin.job.replay', entityId: dead.id } });
    expect(audit.actorAccountId).toBe(admin.id);
    expect(audit.before).toMatchObject({ status: 'dead' });

    // Already back in line: a second replay is refused rather than resetting a live job.
    const again = await request(app).post(`/api/admin/jobs/${dead.id}/replay`).set(CSRF).set('cookie', admin.cookie);
    expect(again.status).toBe(409);
    expect((await request(app).post(`/api/admin/jobs/${randomUUID()}/replay`).set(CSRF).set('cookie', admin.cookie)).status).toBe(404);
  });

  it('replays one inbound message from a stage by enqueueing the worker payload (audited)', async () => {
    const id = await spoolRow();
    const res = await request(app).post(`/api/admin/jobs/inbound/${id}/replay`).set(CSRF).set('cookie', admin.cookie).send({ fromStage: 'parse' });
    expect(res.status).toBe(202);
    const { jobId } = res.body as { jobId: string };
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job).toMatchObject({ queue: 'inbound', status: 'pending', payload: { inboundMessageId: id, replayFrom: 'parse' } });
    expect(job.idempotencyKey).toMatch(new RegExp(`^inbound:${id}:replay:parse:`));
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'admin.inbound.replay', entityId: id } });
    expect(audit.after).toMatchObject({ fromStage: 'parse', jobId });

    // Twice is fine: each request is its own job, and the stages are idempotent.
    const second = await request(app).post(`/api/admin/jobs/inbound/${id}/replay`).set(CSRF).set('cookie', admin.cookie).send({ fromStage: 'parse' });
    expect(second.status).toBe(202);
    expect((second.body as { jobId: string }).jobId).not.toBe(jobId);

    const bad = await request(app).post(`/api/admin/jobs/inbound/${id}/replay`).set(CSRF).set('cookie', admin.cookie).send({ fromStage: 'deliver' });
    expect(bad.status).toBe(400);
    const missing = await request(app).post(`/api/admin/jobs/inbound/${randomUUID()}/replay`).set(CSRF).set('cookie', admin.cookie).send({ fromStage: 'file' });
    expect(missing.status).toBe(404);
    const rejected = await spoolRow(InboundState.rejected);
    const refused = await request(app).post(`/api/admin/jobs/inbound/${rejected}/replay`).set(CSRF).set('cookie', admin.cookie).send({ fromStage: 'file' });
    expect(refused.status).toBe(409);
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
