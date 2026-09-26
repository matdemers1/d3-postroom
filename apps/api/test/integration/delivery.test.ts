// PST-T-1.13, HTTP half: a sent message's per-recipient attempts (MX, TLS, remote response) are
// visible to the account that sent it and nobody else (404, never 403); a queued recipient can be
// cancelled and that mutation is audited.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!baseUrl)('delivery attempts over HTTP (PST-T-1.13)', () => {
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

  /** An OutboundMessage with two recipients: one with a deferred-then-delivered attempt log, one delivered outright. */
  const seedMessage = async (accountId: string): Promise<{ messageId: string; deferredId: string; deliveredId: string }> => {
    const message = await db.outboundMessage.create({
      data: {
        accountId,
        envelopeFrom: `${accountId}@d3cloud.io`,
        headerFrom: 'Someone <someone@d3cloud.io>',
        subject: 'Test subject',
        blobSha256: 'a'.repeat(64),
        size: 1234,
        submittedVia: 'smtp',
      },
    });
    const deferred = await db.outboundRecipient.create({
      data: { outboundMessageId: message.id, address: 'first@example.com', domain: 'example.com', state: 'deferred', attempts: 2, lastCode: 451, lastText: 'greylisted' },
    });
    const delivered = await db.outboundRecipient.create({
      data: {
        outboundMessageId: message.id,
        address: 'second@example.com',
        domain: 'example.com',
        state: 'delivered',
        attempts: 1,
        lastCode: 250,
        lastText: 'ok',
        deliveredAt: new Date(),
      },
    });
    await db.deliveryAttempt.create({
      data: {
        recipientId: deferred.id,
        transport: 'direct',
        mxHost: 'mx1.example.com',
        mxIp: '203.0.113.1',
        tlsVersion: 'TLSv1.3',
        tlsCipher: 'TLS_AES_128_GCM_SHA256',
        tlsPeer: 'mx1.example.com',
        remoteCode: 451,
        remoteEnhanced: '4.3.0',
        remoteText: 'greylisted, try later',
        outcome: 'deferred',
        finishedAt: new Date(),
      },
    });
    await db.deliveryAttempt.create({
      data: {
        recipientId: delivered.id,
        transport: 'direct',
        mxHost: 'mx2.example.com',
        mxIp: '203.0.113.2',
        tlsVersion: 'TLSv1.3',
        tlsCipher: 'TLS_AES_128_GCM_SHA256',
        tlsPeer: 'mx2.example.com',
        remoteCode: 550,
        remoteEnhanced: '5.1.1',
        remoteText: 'user unknown (retried different recipient)',
        outcome: 'bounced',
        finishedAt: new Date(),
      },
    });
    await db.deliveryAttempt.create({
      data: {
        recipientId: delivered.id,
        transport: 'direct',
        mxHost: 'mx2.example.com',
        mxIp: '203.0.113.2',
        tlsVersion: 'TLSv1.3',
        tlsCipher: 'TLS_AES_128_GCM_SHA256',
        tlsPeer: 'mx2.example.com',
        remoteCode: 250,
        remoteEnhanced: '2.0.0',
        remoteText: 'accepted',
        outcome: 'delivered',
        finishedAt: new Date(),
      },
    });
    return { messageId: message.id, deferredId: deferred.id, deliveredId: delivered.id };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t113');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('needs a session', async () => {
    expect((await request(app).get('/api/messages/outbound')).status).toBe(401);
    expect((await request(app).get('/api/messages/00000000-0000-0000-0000-000000000000/delivery')).status).toBe(401);
  });

  it('lists the account’s own outbound, newest first', async () => {
    const me = await person();
    const { messageId } = await seedMessage(me.id);
    const listed = await request(app).get('/api/messages/outbound').set('cookie', me.cookie);
    expect(listed.status).toBe(200);
    const body = listed.body as { messages: { id: string; subject: string; recipients: { address: string; state: string }[] }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ id: messageId, subject: 'Test subject' });
    expect(body.messages[0]?.recipients.map((r) => r.address).sort()).toEqual(['first@example.com', 'second@example.com']);
  });

  it('returns the full delivery timeline with MX, TLS and remote response for every attempt', async () => {
    const me = await person();
    const { messageId, deferredId, deliveredId } = await seedMessage(me.id);

    const res = await request(app).get(`/api/messages/${messageId}/delivery`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as {
      message: { id: string; subject: string };
      recipients: {
        id: string;
        address: string;
        state: string;
        attemptsLog: { mxHost: string; tls: { version: string; cipher: string; peer: string }; remote: { code: number; enhanced: string; text: string }; outcome: string }[];
      }[];
    };
    expect(body.message).toMatchObject({ id: messageId, subject: 'Test subject' });

    const deferred = body.recipients.find((r) => r.id === deferredId);
    expect(deferred).toMatchObject({ address: 'first@example.com', state: 'deferred' });
    expect(deferred?.attemptsLog).toHaveLength(1);
    expect(deferred?.attemptsLog[0]).toMatchObject({
      mxHost: 'mx1.example.com',
      tls: { version: 'TLSv1.3', cipher: 'TLS_AES_128_GCM_SHA256', peer: 'mx1.example.com' },
      remote: { code: 451, enhanced: '4.3.0', text: 'greylisted, try later' },
      outcome: 'deferred',
    });

    const delivered = body.recipients.find((r) => r.id === deliveredId);
    expect(delivered).toMatchObject({ address: 'second@example.com', state: 'delivered' });
    // Ordered oldest first: the 550, then the 250 that actually landed.
    expect(delivered?.attemptsLog.map((a) => a.remote.code)).toEqual([550, 250]);
  });

  it('answers 404, never 403, for another account’s message', async () => {
    const owner = await person();
    const other = await person();
    const { messageId } = await seedMessage(owner.id);
    expect((await request(app).get(`/api/messages/${messageId}/delivery`).set('cookie', other.cookie)).status).toBe(404);
  });

  it('rejects a malformed id with 400', async () => {
    const me = await person();
    expect((await request(app).get('/api/messages/not-a-uuid/delivery').set('cookie', me.cookie)).status).toBe(400);
  });

  it('cancels a deferred recipient, audited, and refuses an already-delivered one', async () => {
    const me = await person();
    const { messageId, deferredId, deliveredId } = await seedMessage(me.id);

    const cancelled = await request(app).post(`/api/messages/${messageId}/recipients/${deferredId}/cancel`).set(CSRF).set('cookie', me.cookie);
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { state: string }).state).toBe('cancelled');
    expect(await db.auditEvent.count({ where: { entityId: deferredId, action: 'outbound.recipient.cancel', actorAccountId: me.id } })).toBe(1);

    const tooLate = await request(app).post(`/api/messages/${messageId}/recipients/${deliveredId}/cancel`).set(CSRF).set('cookie', me.cookie);
    expect(tooLate.status).toBe(409);
  });

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
