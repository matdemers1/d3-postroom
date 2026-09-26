// PST-T-5.4, HTTP half: pin CRUD and the new-sender screen (PST-REQ-105, PST-REQ-106) — every
// mutation audited, scoped strictly to the caller's own account, and 401 without a session.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode, TestClock } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!baseUrl)('sender pins and the new-sender screen over HTTP (PST-T-5.4)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
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

  const person = async (): Promise<{ id: string; login: string; cookie: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    return { id, login, cookie: await signIn(login, totpSecret) };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t54api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('needs a session', async () => {
    expect((await request(app).get('/api/senders/jane@example.com/pin')).status).toBe(401);
    expect((await request(app).put('/api/senders/jane@example.com/pin').set(CSRF).send({ bucket: 'receipts' })).status).toBe(401);
    expect((await request(app).delete('/api/senders/jane@example.com/pin').set(CSRF)).status).toBe(401);
    expect((await request(app).post('/api/senders/jane@example.com/screen').set(CSRF).send({ decision: 'allow' })).status).toBe(401);
  });

  it('needs the CSRF header for a mutation', async () => {
    const me = await person();
    const res = await request(app).put('/api/senders/jane@example.com/pin').set('cookie', me.cookie).send({ bucket: 'receipts' });
    expect(res.status).toBe(403);
  });

  it('has no pin until one is set, and normalizes the address (+tag, case)', async () => {
    const me = await person();
    const before = await request(app).get('/api/senders/Jane+Newsletter@Example.COM/pin').set('cookie', me.cookie);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ address: 'jane@example.com', bucket: null });

    const put = await request(app).put('/api/senders/Jane+Newsletter@Example.COM/pin').set(CSRF).set('cookie', me.cookie).send({ bucket: 'receipts' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ address: 'jane@example.com', bucket: 'receipts' });

    const get = await request(app).get('/api/senders/jane@example.com/pin').set('cookie', me.cookie);
    expect(get.body).toEqual({ address: 'jane@example.com', bucket: 'receipts' });

    const audit = await db.auditEvent.findMany({ where: { entityId: 'jane@example.com', actorAccountId: me.id } });
    expect(audit.map((a) => a.action)).toContain('sender.pin.set');

    const del = await request(app).delete('/api/senders/jane@example.com/pin').set(CSRF).set('cookie', me.cookie);
    expect(del.status).toBe(200);
    expect((await request(app).get('/api/senders/jane@example.com/pin').set('cookie', me.cookie)).body).toEqual({ address: 'jane@example.com', bucket: null });
    expect(await db.auditEvent.count({ where: { entityId: 'jane@example.com', actorAccountId: me.id, action: 'sender.pin.clear' } })).toBe(1);
  });

  it('rejects an unknown bucket', async () => {
    const me = await person();
    const res = await request(app).put('/api/senders/x@example.com/pin').set(CSRF).set('cookie', me.cookie).send({ bucket: 'trash' });
    expect(res.status).toBe(400);
  });

  it('screens a sender Allow or Block, audited, and clears their new-sender badge', async () => {
    const me = await person();
    const inbox = await db.mailbox.create({ data: { accountId: me.id, name: 'INBOX', specialUse: 'inbox', uidvalidity: 1 } });
    const blob = await db.blob.create({ data: { sha256: 'a'.repeat(64), size: 10, refcount: 1, wrappedDek: Buffer.alloc(1), kekId: 'test', aead: 'aes-256-gcm', nonce: Buffer.alloc(12) } });
    const msg = await db.message.create({
      data: { mailboxId: inbox.id, uid: 1, modseq: 1n, blobSha256: blob.sha256, size: 10, internalDate: new Date(), fromAddress: 'newperson@example.net' },
    });
    await db.messageVerdict.create({ data: { messageId: msg.id, bucket: 'people', reasons: ['x'], scores: { newSender: 1 } } });

    const res = await request(app).post('/api/senders/newperson@example.net/screen').set(CSRF).set('cookie', me.cookie).send({ decision: 'allow' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, address: 'newperson@example.net', decision: 'allow', clearedNewSender: 1 });

    const verdict = await db.messageVerdict.findUniqueOrThrow({ where: { messageId: msg.id } });
    expect(verdict.scores).not.toHaveProperty('newSender');
    expect(await db.auditEvent.count({ where: { entityId: 'newperson@example.net', actorAccountId: me.id, action: 'sender.screen.set' } })).toBe(1);

    const listed = await request(app).get(`/api/messages/${msg.id}`).set('cookie', me.cookie);
    expect(listed.body).toMatchObject({ newSender: false });
  });

  it('one account never sees another\'s pin', async () => {
    const alice = await person();
    const bob = await person();
    await request(app).put('/api/senders/shared@example.com/pin').set(CSRF).set('cookie', alice.cookie).send({ bucket: 'priority' });
    const bobsView = await request(app).get('/api/senders/shared@example.com/pin').set('cookie', bob.cookie);
    expect(bobsView.body).toEqual({ address: 'shared@example.com', bucket: null });
  });

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
