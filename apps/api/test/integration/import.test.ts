// PST-T-10.2, PST-REQ-152, HTTP half: POST /api/import starts one import per account (step-up,
// CSRF, audited; 409 while one is active), GET /api/import[/:id] reports it, POST
// /api/import/:id/cancel stops it — and the source password is sealed under the KEK in its own row,
// never in the job payload, a response or the audit log, and gone once the import is cancelled.
// The import itself (IMAP, resume, dedupe) is proven by the worker's own integration test
// (apps/worker/test/integration/import.test.ts); this one simulates the worker's side of the
// shared `setting` rows where it needs to (claiming the job, writing progress).
import { kekFromBase64, openWithKek } from '@postroom/crypto';
import { JobStatus, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, KEK_BASE64, randomLogin, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const SOURCE_PASSWORD = 'source-imap-secret-5b1e0c';
const FINGERPRINT = 'AB:'.repeat(31) + 'AB';

describe.skipIf(!baseUrl)('/api/import (PST-T-10.2, PST-REQ-152)', () => {
  let t: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();

  const signIn = async (login: string, secret: string): Promise<Record<string, string>> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookiesOf(second);
  };

  const person = async (): Promise<{ id: string; cookie: string; totpSecret: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    return { id, cookie: cookieHeader(await signIn(login, totpSecret)), totpSecret };
  };

  const stepUp = async (cookie: string, secret: string): Promise<void> => {
    clock.advance(31_000);
    const res = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(secret, clock.now()) });
    expect(res.status).toBe(200);
  };

  const body = { host: 'imap.example.org', port: 993, username: 'me@example.org', password: SOURCE_PASSWORD, trustFingerprint: FINGERPRINT };

  const nowhere = async (): Promise<void> => {
    const hay = JSON.stringify([
      await db.job.findMany({ where: { queue: 'import' } }),
      await db.auditEvent.findMany(),
      await db.setting.findMany({ where: { key: { startsWith: 'import-' } } }),
    ]);
    expect(hay.includes(SOURCE_PASSWORD)).toBe(false);
  };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t102_import_api');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
  }, 60_000);

  afterAll(async () => {
    await t.drop();
  });

  it('401 without a session, 403 without the CSRF header, 403 without a fresh step-up, 400 on a bad body', async () => {
    expect((await request(app).post('/api/import').set(CSRF).send(body)).status).toBe(401);
    const alice = await person();
    expect((await request(app).post('/api/import').set('cookie', alice.cookie).send(body)).status).toBe(403);
    const noStepUp = await request(app).post('/api/import').set(CSRF).set('cookie', alice.cookie).send(body);
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body).toEqual({ error: 'step_up_required' });
    await stepUp(alice.cookie, alice.totpSecret);
    for (const bad of [
      { ...body, host: 'imap.example.org/../x' },
      { ...body, port: 0 },
      { ...body, trustFingerprint: 'not-a-fingerprint' },
      { ...body, password: '' },
      { ...body, extra: true },
    ]) {
      const res = await request(app).post('/api/import').set(CSRF).set('cookie', alice.cookie).send(bad);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body).includes(SOURCE_PASSWORD)).toBe(false);
    }
    expect(await db.job.count({ where: { queue: 'import' } })).toBe(0);
  });

  it('202 starts one, sealed and audited without the password; 409 while active; status for its owner only', async () => {
    const alice = await person();
    await stepUp(alice.cookie, alice.totpSecret);
    const res = await request(app).post('/api/import').set(CSRF).set('cookie', alice.cookie).send({ ...body, folders: ['INBOX', 'Sent'] });
    expect(res.status).toBe(202);
    const started = res.body as { id: string; status: string; pinned: boolean; host: string; totals: { folders: number } };
    expect(started).toMatchObject({ status: 'pending', pinned: true, host: 'imap.example.org', totals: { folders: 0 } });
    expect(JSON.stringify(res.body).includes(SOURCE_PASSWORD)).toBe(false);

    const job = await db.job.findUniqueOrThrow({ where: { id: started.id } });
    expect(job.queue).toBe('import');
    expect(job.payload).toEqual({ accountId: alice.id });
    const secret = await db.setting.findUniqueOrThrow({ where: { key: `import-secret.${started.id}` } });
    const sealed = Buffer.from((secret.value as { sealed: string }).sealed, 'base64');
    expect(openWithKek(kekFromBase64(KEK_BASE64), sealed, `postroom-import-secret:${started.id}`).toString('utf8')).toBe(SOURCE_PASSWORD);
    const state = (await db.setting.findUniqueOrThrow({ where: { key: `import-state.${started.id}` } })).value as { trustFingerprint: string; folders: string[] };
    expect(state.trustFingerprint).toBe('AB'.repeat(32));
    expect(state.folders).toEqual(['INBOX', 'Sent']);
    const audit = await db.auditEvent.findMany({ where: { entityId: started.id } });
    expect(audit.map((a) => a.action)).toEqual(['import.start']);
    expect(audit[0]?.after).toEqual({ host: 'imap.example.org', port: 993, pinned: true, folders: 2 });
    await nowhere();

    const second = await request(app).post('/api/import').set(CSRF).set('cookie', alice.cookie).send(body);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'import_active', id: started.id });

    // The worker's progress, as it writes it, shows up in the status.
    await db.setting.update({
      where: { key: `import-state.${started.id}` },
      data: {
        value: {
          ...state,
          accountId: alice.id,
          host: 'imap.example.org',
          port: 993,
          username: 'me@example.org',
          status: 'running',
          error: null,
          createdAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          finishedAt: null,
          progress: [
            { source: 'INBOX', display: 'INBOX', target: 'INBOX', specialUse: 'inbox', uidvalidity: 7, lastUid: 40, total: 50, imported: 38, duplicates: 2, done: false },
            { source: 'Sent', display: 'Sent', target: 'Sent', specialUse: 'sent', uidvalidity: 9, lastUid: 10, total: 10, imported: 10, duplicates: 0, done: true },
          ],
        },
      },
    });
    const status = await request(app).get(`/api/import/${started.id}`).set('cookie', alice.cookie);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      status: 'running',
      folders: [
        { name: 'INBOX', target: 'INBOX', total: 50, imported: 38, duplicates: 2, done: false },
        { name: 'Sent', target: 'Sent', total: 10, imported: 10, duplicates: 0, done: true },
      ],
      totals: { folders: 2, foldersDone: 1, total: 60, imported: 48, duplicates: 2 },
    });
    const latest = await request(app).get('/api/import').set('cookie', alice.cookie);
    expect((latest.body as { import: { id: string } }).import.id).toBe(started.id);

    const bob = await person();
    expect((await request(app).get(`/api/import/${started.id}`).set('cookie', bob.cookie)).status).toBe(404);
    expect((await request(app).post(`/api/import/${started.id}/cancel`).set(CSRF).set('cookie', bob.cookie)).status).toBe(404);
    expect((await request(app).get('/api/import').set('cookie', bob.cookie)).body).toEqual({ import: null });
    expect((await request(app).get('/api/import/not-a-uuid').set('cookie', alice.cookie)).status).toBe(404);
  });

  it('cancel before a worker claims it ends it at once and wipes the secret; a finished one cannot be cancelled', async () => {
    const alice = await person();
    await stepUp(alice.cookie, alice.totpSecret);
    const started = (await request(app).post('/api/import').set(CSRF).set('cookie', alice.cookie).send(body)).body as { id: string };
    const cancel = await request(app).post(`/api/import/${started.id}/cancel`).set(CSRF).set('cookie', alice.cookie);
    expect(cancel.status).toBe(202);
    expect(cancel.body).toMatchObject({ status: 'cancelled', cancelRequested: false });
    expect((await db.job.findUniqueOrThrow({ where: { id: started.id } })).status).toBe(JobStatus.done);
    expect(await db.setting.count({ where: { key: { in: [`import-secret.${started.id}`, `import-cancel.${started.id}`] } } })).toBe(0);
    expect((await db.auditEvent.findMany({ where: { entityId: started.id }, orderBy: { at: 'asc' } })).map((a) => a.action)).toEqual(['import.start', 'import.cancel']);
    expect((await request(app).post(`/api/import/${started.id}/cancel`).set(CSRF).set('cookie', alice.cookie)).status).toBe(409);

    // Not active any more: a new one may start.
    await stepUp(alice.cookie, alice.totpSecret);
    expect((await request(app).post('/api/import').set(CSRF).set('cookie', alice.cookie).send(body)).status).toBe(202);
    await nowhere();
  });

  it('cancel while a worker runs it asks the worker to stop and wipes the secret now', async () => {
    const alice = await person();
    await stepUp(alice.cookie, alice.totpSecret);
    const started = (await request(app).post('/api/import').set(CSRF).set('cookie', alice.cookie).send(body)).body as { id: string };
    await db.job.update({ where: { id: started.id }, data: { status: JobStatus.running, lockedBy: 'worker-x', lockedAt: new Date(), attempts: 1 } });
    const cancel = await request(app).post(`/api/import/${started.id}/cancel`).set(CSRF).set('cookie', alice.cookie);
    expect(cancel.status).toBe(202);
    expect(cancel.body).toMatchObject({ status: 'pending', cancelRequested: true });
    expect((await db.job.findUniqueOrThrow({ where: { id: started.id } })).status).toBe(JobStatus.running);
    expect(await db.setting.count({ where: { key: `import-secret.${started.id}` } })).toBe(0);
    expect(await db.setting.count({ where: { key: `import-cancel.${started.id}` } })).toBe(1);
  });
});
