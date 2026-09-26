// PST-T-6.6 / PST-REQ-121: the outbound queue admin — list, retry now, bounce, delete and
// force-SES, per recipient, per message and per domain. doneWhen: force-SES re-routes a deferred
// message — proved here two ways: (1) the API mutates transport to 'ses' and gives the worker a
// due job, audited; (2) the delivery worker, run for real against that recipient, actually attempts
// it through the 'ses' transport rather than 'direct', even though DELIVERY_SES_DOMAINS never
// listed this recipient's domain.
import { Readable } from 'node:stream';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { createDeliveryWorker, OUTBOUND_QUEUE, type DeliveryResult, type Transport } from '@postroom/delivery';
import { startWorker } from '@postroom/queue';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

// SES "configured" from the daemon's own env, but its domain list never mentions example.test —
// the scenario the doneWhen names: force-SES has to win even when the claim list does not help it.
const SES_ENV = {
  SES_SMTP_HOST: 'email-smtp.fake.test',
  SES_SMTP_USER: 'AKIAFAKE',
  SES_SMTP_PASSWORD: 'fake-password',
  DELIVERY_SES_DOMAINS: 'not-example.test',
};

describe.skipIf(!baseUrl)('outbound queue admin: retry, bounce, delete, force-SES (PST-T-6.6)', () => {
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

  const person = async (isAdmin: boolean): Promise<{ id: string; cookie: string; totpSecret: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin });
    return { id, totpSecret, cookie: await signIn(login, totpSecret) };
  };

  const stepUp = async (cookie: string, secret: string): Promise<void> => {
    clock.advance(31_000);
    const res = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(secret, clock.now()) });
    expect(res.status).toBe(200);
  };

  const seedDeferred = async (accountId: string, domain = 'example.test'): Promise<{ messageId: string; recipientId: string }> => {
    const message = await db.outboundMessage.create({
      data: {
        accountId,
        envelopeFrom: `${accountId}@d3cloud.io`,
        headerFrom: 'Someone <someone@d3cloud.io>',
        subject: 'Queued',
        blobSha256: 'a'.repeat(64),
        size: 42,
        submittedVia: 'test',
      },
    });
    const recipient = await db.outboundRecipient.create({
      data: {
        outboundMessageId: message.id,
        address: `first@${domain}`,
        domain,
        state: 'deferred',
        attempts: 2,
        transport: 'direct',
        lastCode: 451,
        lastText: 'greylisted',
        nextAttemptAt: new Date(clock.now().getTime() + 3_600_000),
      },
    });
    return { messageId: message.id, recipientId: recipient.id };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t66');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: SES_ENV, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('is admin only and needs a fresh step-up for every mutation', async () => {
    const user = await person(false);
    const admin = await person(true);
    const { recipientId } = await seedDeferred(user.id);

    expect((await request(app).get('/api/admin/queue')).status).toBe(401);
    expect((await request(app).get('/api/admin/queue').set('cookie', user.cookie)).status).toBe(403);

    for (const [method, path] of [
      ['post', `/api/admin/queue/recipients/${recipientId}/retry`],
      ['post', `/api/admin/queue/recipients/${recipientId}/force-ses`],
      ['post', `/api/admin/queue/recipients/${recipientId}/bounce`],
      ['delete', `/api/admin/queue/recipients/${recipientId}`],
    ] as const) {
      const asUser = await request(app)[method](path).set(CSRF).set('cookie', user.cookie).send({ reason: 'x' });
      expect(asUser.status, `${method} ${path} as non-admin`).toBe(403);
      // Admin, but no step-up yet.
      const asAdmin = await request(app)[method](path).set(CSRF).set('cookie', admin.cookie).send({ reason: 'x' });
      expect(asAdmin.status, `${method} ${path} without step-up`).toBe(403);
    }
  });

  it('lists queued recipients grouped by message, filterable by domain and state', async () => {
    const user = await person(false);
    const { messageId, recipientId } = await seedDeferred(user.id, 'listed.test');

    const admin = await person(true);
    const all = await request(app).get('/api/admin/queue').set('cookie', admin.cookie);
    expect(all.status).toBe(200);
    const body = all.body as { messages: { id: string; recipients: { id: string; state: string; domain: string }[] }[]; sesConfigured: boolean };
    expect(body.sesConfigured).toBe(true);
    const found = body.messages.find((m) => m.id === messageId);
    expect(found?.recipients.map((r) => r.id)).toContain(recipientId);

    const byDomain = await request(app).get('/api/admin/queue?domain=listed.test').set('cookie', admin.cookie);
    expect((byDomain.body as { messages: { id: string }[] }).messages.some((m) => m.id === messageId)).toBe(true);

    const byState = await request(app).get('/api/admin/queue?state=deferred').set('cookie', admin.cookie);
    expect((byState.body as { messages: { recipients: { state: string }[] }[] }).messages.flatMap((m) => m.recipients.map((r) => r.state))).toEqual(
      expect.arrayContaining(['deferred']),
    );

    const noMatch = await request(app).get('/api/admin/queue?state=pending&domain=listed.test').set('cookie', admin.cookie);
    expect((noMatch.body as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it('retry-now sets nextAttemptAt to now and gives the worker a due job, audited', async () => {
    const user = await person(false);
    const { recipientId } = await seedDeferred(user.id);
    const admin = await person(true);
    await stepUp(admin.cookie, admin.totpSecret);

    const before = clock.now();
    const res = await request(app).post(`/api/admin/queue/recipients/${recipientId}/retry`).set(CSRF).set('cookie', admin.cookie);
    expect(res.status).toBe(202);
    expect((res.body as { count: number }).count).toBe(1);

    const row = await db.outboundRecipient.findUniqueOrThrow({ where: { id: recipientId } });
    expect(Math.abs(row.nextAttemptAt.getTime() - before.getTime())).toBeLessThan(2_000);
    expect(await db.job.count({ where: { queue: OUTBOUND_QUEUE, payload: { path: ['domain'], equals: row.domain } } })).toBeGreaterThan(0);
    expect(await db.auditEvent.count({ where: { action: 'admin.queue.retry', entityId: recipientId, actorAccountId: admin.id } })).toBe(1);
  });

  it('bounce marks a recipient permanently failed, audited, and refuses an already-final one', async () => {
    const user = await person(false);
    const { recipientId } = await seedDeferred(user.id);
    const admin = await person(true);
    await stepUp(admin.cookie, admin.totpSecret);

    const res = await request(app).post(`/api/admin/queue/recipients/${recipientId}/bounce`).set(CSRF).set('cookie', admin.cookie);
    expect(res.status).toBe(202);
    const row = await db.outboundRecipient.findUniqueOrThrow({ where: { id: recipientId } });
    expect(row.state).toBe('bounced');
    expect(await db.auditEvent.count({ where: { action: 'admin.queue.bounce', entityId: recipientId } })).toBe(1);

    await stepUp(admin.cookie, admin.totpSecret);
    const again = await request(app).post(`/api/admin/queue/recipients/${recipientId}/bounce`).set(CSRF).set('cookie', admin.cookie);
    expect(again.status).toBe(409);
  });

  it('delete removes a recipient from the queue without a DSN, audited with the reason; the Sent copy stays', async () => {
    const user = await person(false);
    const { messageId, recipientId } = await seedDeferred(user.id);
    const admin = await person(true);
    await stepUp(admin.cookie, admin.totpSecret);

    const res = await request(app).delete(`/api/admin/queue/recipients/${recipientId}`).set(CSRF).set('cookie', admin.cookie).send({ reason: 'operator requested' });
    expect(res.status).toBe(202);
    const row = await db.outboundRecipient.findUniqueOrThrow({ where: { id: recipientId } });
    expect(row.state).toBe('cancelled');
    expect(row.failureDsnSentAt).toBeNull();
    expect(row.delayDsnSentAt).toBeNull();
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'admin.queue.delete', entityId: recipientId } });
    expect(JSON.stringify(audit.after)).toContain('operator requested');
    // The message itself (the Sent copy's record) is untouched.
    expect(await db.outboundMessage.findUnique({ where: { id: messageId } })).not.toBeNull();
  });

  it('force-SES refuses with 409 when SES is not configured', async () => {
    const noSesApp = createApp({ db, env: {}, config: baseConfig(clock) });
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: true });
    clock.advance(31_000);
    const first = await request(noSesApp).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    const { challenge } = first.body as { challenge: string };
    const second = await request(noSesApp).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(totpSecret, clock.now()) });
    const cookie = cookieHeader(cookiesOf(second));
    clock.advance(31_000);
    const stepUpRes = await request(noSesApp).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(totpSecret, clock.now()) });
    expect(stepUpRes.status).toBe(200);

    const { recipientId } = await seedDeferred(id);
    const res = await request(noSesApp).post(`/api/admin/queue/recipients/${recipientId}/force-ses`).set(CSRF).set('cookie', cookie);
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe('ses_not_configured');
  });

  it('force-SES re-routes a deferred message: sets transport to ses, and the worker actually attempts it through ses even though DELIVERY_SES_DOMAINS does not list the domain (the doneWhen)', async () => {
    const user = await person(false);
    const { messageId, recipientId } = await seedDeferred(user.id, 'example.test');
    const admin = await person(true);
    await stepUp(admin.cookie, admin.totpSecret);

    const res = await request(app).post(`/api/admin/queue/recipients/${recipientId}/force-ses`).set(CSRF).set('cookie', admin.cookie);
    expect(res.status).toBe(202);
    expect((res.body as { transport: string }).transport).toBe('ses');

    const forced = await db.outboundRecipient.findUniqueOrThrow({ where: { id: recipientId } });
    expect(forced.transport).toBe('ses');
    expect(Math.abs(forced.nextAttemptAt.getTime() - clock.now().getTime())).toBeLessThan(2_000);
    expect(await db.auditEvent.count({ where: { action: 'admin.queue.force_ses', entityId: recipientId, actorAccountId: admin.id } })).toBe(1);

    // Now run the real delivery worker against it. 'example.test' is not in DELIVERY_SES_DOMAINS
    // (SES_ENV above lists only 'not-example.test'), so only the forced per-recipient transport can
    // be why the attempt goes via 'ses' rather than 'direct'.
    const usedFor = (name: string): Transport => ({
      name,
      deliver: (req): Promise<DeliveryResult> => {
        const results = Object.fromEntries(req.recipients.map((r) => [r.id, { kind: 'delivered', code: 250, enhanced: '2.0.0', text: 'ok' } as const]));
        return Promise.resolve({ details: { mxHost: `${name}.fake.test` }, results });
      },
    });
    const delivery = createDeliveryWorker({
      db,
      transports: { direct: usedFor('direct'), ses: usedFor('ses') },
      openMessage: () => Promise.resolve(Readable.from([Buffer.from('Subject: x\r\n\r\nbody\r\n')])),
      now: () => clock.now(),
      leaseMs: 60_000,
      attemptTimeoutMs: 30_000,
    });
    const worker = await startWorker({ db, databaseUrl: baseUrl ?? '', manual: true, now: () => clock.now(), leaseMs: 60_000, queues: { [OUTBOUND_QUEUE]: delivery.handle } });
    try {
      expect(await worker.drain()).toBeGreaterThan(0);
    } finally {
      await worker.stop();
    }

    const finished = await db.outboundRecipient.findUniqueOrThrow({ where: { id: recipientId }, include: { attemptsLog: { orderBy: { startedAt: 'desc' }, take: 1 } } });
    expect(finished.state).toBe('delivered');
    expect(finished.attemptsLog[0]?.transport).toBe('ses');
    expect(finished.attemptsLog[0]?.mxHost).toBe('ses.fake.test');
    expect(messageId).toBe(messageId);
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
