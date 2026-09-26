// PST-T-10.1, PST-REQ-151, HTTP half: POST /api/export enqueues one export per account (a second
// call while one is active is 409), GET /api/export/:id reports its status, and GET
// /api/export/:id/download streams the finished archive — both mutating routes need a fresh
// step-up, both are audited, and nobody reaches another account's export or archive. The archive's
// bytes and manifest are exactly what the worker wrote to the blob store (byte-for-byte streamed
// back); the mbox content itself and its mboxrd quoting are proven in the worker's own integration
// test (apps/worker/test/integration/export/export.test.ts), which is what actually builds it —
// this test simulates that completion (claim + complete on the same 'export' queue row, with the
// same `setting` row shape the worker writes) so the HTTP contract can be proven without a
// cross-app import of worker source.
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
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
const EXPORT_QUEUE = 'export';
const exportResultKey = (id: string): string => `export-result.${id}`;

/** Stands in for the worker finishing an export: claims the job, drops an archive in the blob
 * store and writes the same `setting` row apps/worker/src/export/settings.ts writes, then marks
 * the job done — exactly the state a real export leaves behind. */
async function completeExport(db: Db, blobs: BlobStore, jobId: string, accountId: string, now: Date): Promise<{ archiveSha256: string; archiveSize: number }> {
  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  if (job.queue !== EXPORT_QUEUE) throw new Error('not an export job');
  const archive = Buffer.from(`PK\u0003\u0004 fake archive for ${jobId}`, 'latin1');
  const put = await blobs.put(archive);
  const manifest = {
    account: accountId,
    exportedAt: now.toISOString(),
    revision: 'test-rev',
    schemaRevision: null,
    formatVersions: { mbox: 'mboxrd-1', manifest: 1 },
    folders: [{ name: 'INBOX', path: 'mail/INBOX.mbox', messageCount: 2, sha256: createHash('sha256').update('mbox').digest('hex') }],
    messageCount: 2,
    calendars: [],
    addressBooks: [],
  };
  await db.setting.create({
    data: {
      key: exportResultKey(jobId),
      value: {
        accountId,
        archiveSha256: put.sha256,
        archiveSize: put.size,
        finishedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
        manifest,
      },
    },
  });
  await db.job.update({ where: { id: jobId }, data: { status: JobStatus.done, finishedAt: now } });
  return { archiveSha256: put.sha256, archiveSize: put.size };
}

describe.skipIf(!baseUrl)('POST/GET /api/export (PST-T-10.1, PST-REQ-151)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
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

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t101_export_api');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-export-api-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: (await import('@postroom/crypto')).kekFromBase64(KEK_BASE64) });
    app = createApp({ db, env: { BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
  }, 60_000);

  afterAll(async () => {
    await t.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('401 without a session, 403 without a fresh step-up', async () => {
    expect((await request(app).post('/api/export').set(CSRF)).status).toBe(401);
    const alice = await person();
    const noStepUp = await request(app).post('/api/export').set(CSRF).set('cookie', alice.cookie);
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body).toEqual({ error: 'step_up_required' });
  });

  it('202 starts an export, audited; a second call while it is active is 409; status reflects the job', async () => {
    const alice = await person();
    await stepUp(alice.cookie, alice.totpSecret);

    const started = await request(app).post('/api/export').set(CSRF).set('cookie', alice.cookie);
    expect(started.status).toBe(202);
    const body = started.body as { id: string; status: string };
    expect(body.status).toBe('pending');

    const audit = await db.auditEvent.findFirst({ where: { action: 'export.start', entityId: body.id } });
    expect(audit).toMatchObject({ actorKind: 'account', actorAccountId: alice.id });

    await stepUp(alice.cookie, alice.totpSecret);
    const again = await request(app).post('/api/export').set(CSRF).set('cookie', alice.cookie);
    expect(again.status).toBe(409);
    expect((again.body as { error: string }).error).toBe('export_active');

    const status = await request(app).get(`/api/export/${body.id}`).set('cookie', alice.cookie);
    expect(status.status).toBe(200);
    expect((status.body as { status: string }).status).toBe('pending');
  });

  it('404 for an export id that is not the caller\'s, and for an unknown id', async () => {
    const alice = await person();
    await stepUp(alice.cookie, alice.totpSecret);
    const started = await request(app).post('/api/export').set(CSRF).set('cookie', alice.cookie);
    const id = (started.body as { id: string }).id;

    const bob = await person();
    const asBob = await request(app).get(`/api/export/${id}`).set('cookie', bob.cookie);
    expect(asBob.status).toBe(404);

    const unknown = await request(app).get('/api/export/00000000-0000-0000-0000-000000000000').set('cookie', alice.cookie);
    expect(unknown.status).toBe(404);
  });

  it('once done: download needs step-up, streams the exact archive bytes, is audited, and another account gets 404', async () => {
    const alice = await person();
    await stepUp(alice.cookie, alice.totpSecret);
    const started = await request(app).post('/api/export').set(CSRF).set('cookie', alice.cookie);
    const id = (started.body as { id: string }).id;

    const now = clock.now();
    const { archiveSha256, archiveSize } = await completeExport(db, blobs, id, alice.id, now);

    const status = await request(app).get(`/api/export/${id}`).set('cookie', alice.cookie);
    expect((status.body as { status: string }).status).toBe('done');
    expect((status.body as { archiveSize: number }).archiveSize).toBe(archiveSize);
    expect((status.body as { manifest: { messageCount: number } }).manifest.messageCount).toBe(2);

    // The step-up from starting the export has gone stale: refused, not streamed.
    clock.advance(6 * 60_000);
    const noStepUp = await request(app).get(`/api/export/${id}/download`).set('cookie', alice.cookie);
    expect(noStepUp.status).toBe(403);

    await stepUp(alice.cookie, alice.totpSecret);
    const downloaded = await request(app)
      .get(`/api/export/${id}/download`)
      .set('cookie', alice.cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => { cb(null, Buffer.concat(chunks)); });
      });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers['content-type']).toBe('application/zip');
    expect(downloaded.headers['content-disposition']).toContain('.zip');
    const expected = await blobs.getBuffer(archiveSha256);
    expect((downloaded.body as Buffer).equals(expected)).toBe(true);

    const audit = await db.auditEvent.findFirst({ where: { action: 'export.download', entityId: id } });
    expect(audit).toMatchObject({ actorKind: 'account', actorAccountId: alice.id });

    const bob = await person();
    await stepUp(bob.cookie, bob.totpSecret);
    const asBob = await request(app).get(`/api/export/${id}/download`).set('cookie', bob.cookie);
    expect(asBob.status).toBe(404);
  });

  it('409 downloading before the export is done', async () => {
    const alice = await person();
    await stepUp(alice.cookie, alice.totpSecret);
    const started = await request(app).post('/api/export').set(CSRF).set('cookie', alice.cookie);
    const id = (started.body as { id: string }).id;
    await stepUp(alice.cookie, alice.totpSecret);
    const download = await request(app).get(`/api/export/${id}/download`).set('cookie', alice.cookie);
    expect(download.status).toBe(409);
  });

  it('404 downloading once the archive has expired and been swept', async () => {
    const alice = await person();
    await stepUp(alice.cookie, alice.totpSecret);
    const started = await request(app).post('/api/export').set(CSRF).set('cookie', alice.cookie);
    const id = (started.body as { id: string }).id;
    await completeExport(db, blobs, id, alice.id, clock.now());

    // The sweep (apps/worker/src/export/sweep.ts) deletes the `setting` row once past its
    // expiresAt; simulated directly here, the same state a real sweep leaves.
    await db.setting.deleteMany({ where: { key: exportResultKey(id) } });

    await stepUp(alice.cookie, alice.totpSecret);
    const download = await request(app).get(`/api/export/${id}/download`).set('cookie', alice.cookie);
    expect(download.status).toBe(404);
  });
});
