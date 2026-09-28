// PST-T-11.10 against a real database and blob store:
//   PST-REQ-176  a webmail send whose recipient the fake transport rejects 550 5.1.1 (the delivery
//                worker run for real) puts that address on the suppression list; an admin bounce
//                from the queue screen never does.
//   PST-REQ-179  a second webmail send to it is refused 422 recipient_suppressed with the addresses,
//                nothing queued or held — and removal re-allows it.
//   PST-REQ-178  GET/POST/DELETE /api/admin/suppressions: admin only, step-up on mutations.
//   PST-REQ-181  every change audited, naming the address, the actor and the reason.
import { randomInt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { createDeliveryWorker, OUTBOUND_QUEUE } from '@postroom/delivery';
import { FakeTransport, reply } from '@postroom/delivery/fake';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { refusalBody, refusalStatus } from '../../src/compose/index.js';
import { SuppressedRefusal, SuppressionList } from '../../src/admin-suppressions/schemas.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe('a suppression refusal from the accepting transaction, over HTTP (pure)', () => {
  it('is 422 recipient_suppressed with the addresses, on every webmail route that maps refusals', () => {
    const outcome = { ok: false, reason: 'recipient-suppressed', reply: { code: 550, enhanced: '5.1.1', lines: ['a@example.org is on this server\'s suppression list (after a hard bounce); an admin can remove it'] }, suppressed: ['a@example.org'] } as const;
    expect(refusalStatus(outcome)).toEqual({ status: 422, error: 'recipient_suppressed' });
    expect(SuppressedRefusal.parse(refusalBody(outcome)).addresses).toEqual(['a@example.org']);
  });
});

describe.skipIf(!baseUrl)('suppression list: admin API and the webmail send path (PST-T-11.10)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobRoot: string;
  const clock = new TestClock();
  let guardMissesBefore = 0;

  interface Person {
    id: string;
    address: string;
    cookie: string;
    totpSecret: string;
  }

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (isAdmin = false): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, displayName: `Person ${login}`, isAdmin });
    for (const [name, specialUse] of [['INBOX', SpecialUse.inbox], ['Sent', SpecialUse.sent], ['Drafts', SpecialUse.drafts]] as const) {
      await db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    }
    return { id, address: `${login}@d3cloud.io`, totpSecret, cookie: await signIn(login, totpSecret) };
  };

  const stepUp = async (who: Person): Promise<void> => {
    clock.advance(31_000);
    const res = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', who.cookie).send({ code: totpCode(who.totpSecret, clock.now()) });
    expect(res.status).toBe(200);
  };

  const send = (who: Person, body: Record<string, unknown>) =>
    request(app).post('/api/compose/send').set(CSRF).set('cookie', who.cookie).send({ from: who.address, subject: 'Hello', text: 'Hi.', ...body });

  /** Every due outbound job, through the real delivery worker and the fake transport. */
  const deliverAll = async (): Promise<void> => {
    const fake = new FakeTransport({
      script: (r) => {
        if (r.address.startsWith('gone')) return reply.reject('No such user');
        if (r.address.startsWith('policy')) return { kind: 'permanent', code: 550, enhanced: '5.7.1', text: 'Rejected by policy' };
        if (r.address.startsWith('later')) return reply.tempfail('Try again later');
        return reply.ok();
      },
    });
    const worker = createDeliveryWorker({ db, transports: { direct: fake }, openMessage: () => Promise.resolve(Readable.from([Buffer.from('x')])), onDsn: () => Promise.resolve() });
    for (const job of await db.job.findMany({ where: { queue: OUTBOUND_QUEUE, status: 'pending' } })) {
      await worker.handle(job);
      await db.job.update({ where: { id: job.id }, data: { status: 'done' } });
    }
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t1110_api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t1110-blobs-'));
    await ensureDkimKeys(db, kekFromBase64(KEK_BASE64), 'd3cloud.io');
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 120_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('is admin only, and every mutation needs a fresh step-up', async () => {
    const user = await person(false);
    const admin = await person(true);
    expect((await request(app).get('/api/admin/suppressions')).status).toBe(401);
    expect((await request(app).get('/api/admin/suppressions').set('cookie', user.cookie)).status).toBe(403);
    const asUser = await request(app).post('/api/admin/suppressions').set(CSRF).set('cookie', user.cookie).send({ address: 'x@example.org', reason: 'x' });
    expect(asUser.status).toBe(403);
    const noStepUp = await request(app).post('/api/admin/suppressions').set(CSRF).set('cookie', admin.cookie).send({ address: 'x@example.org', reason: 'x' });
    expect(noStepUp.status).toBe(403);
    const del = await request(app).delete('/api/admin/suppressions/00000000-0000-4000-8000-000000000000').set(CSRF).set('cookie', admin.cookie).send({ reason: 'x' });
    expect(del.status).toBe(403);
    expect(await db.suppressedRecipient.count({ where: { address: 'x@example.org' } })).toBe(0);
  });

  it('dev-clear exists only on the e2e stack, is admin only, removes just the listed addresses, and is audited', async () => {
    const admin = await person(true);
    const user = await person(false);
    const now = new Date();
    for (const address of ['clear.me@example.org', 'keep.me@example.org']) {
      await db.suppressedRecipient.create({ data: { address, reason: 'hard-bounce', code: 556, enhanced: '5.1.10', text: 'null MX', firstAt: now, lastAt: now } });
    }
    const body = { addresses: ['Clear.Me@example.org'] };
    expect((await request(app).post('/api/admin/suppressions/dev-clear').set(CSRF).set('cookie', admin.cookie).send(body)).status).toBe(404);

    try {
    const e2e = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot, POSTROOM_E2E_SEED: '1' }, config: baseConfig(clock) });
    expect((await request(e2e).post('/api/admin/suppressions/dev-clear').set(CSRF).set('cookie', user.cookie).send(body)).status).toBe(403);
    expect((await request(e2e).post('/api/admin/suppressions/dev-clear').set(CSRF).set('cookie', admin.cookie).send({ addresses: 'x' })).status).toBe(400);
    const cleared = await request(e2e).post('/api/admin/suppressions/dev-clear').set(CSRF).set('cookie', admin.cookie).send(body);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ removed: 1 });
    expect(await db.suppressedRecipient.count({ where: { address: 'clear.me@example.org' } })).toBe(0);
    expect(await db.suppressedRecipient.count({ where: { address: 'keep.me@example.org' } })).toBe(1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'admin.dev.clear-suppression' }, orderBy: { at: 'desc' } });
    expect(audit).toMatchObject({ actorKind: 'account', actorAccountId: admin.id });
    expect(audit.before).toMatchObject({ addresses: ['clear.me@example.org'] });
    } finally {
      await db.suppressedRecipient.deleteMany({ where: { address: { in: ['clear.me@example.org', 'keep.me@example.org'] } } });
    }
  });

  it('doneWhen: a fake-transport 550 5.1.1 suppresses; 5.7.1 and 4xx do not; the next webmail send is 422 with the addresses', async () => {
    const me = await person();
    const first = await send(me, { to: ['gone@example.org', 'policy@example.org', 'later@example.org', 'fine@example.org'] });
    expect(first.status).toBe(201);
    await deliverAll();

    const rows = await db.suppressedRecipient.findMany();
    expect(rows.map((r) => r.address)).toEqual(['gone@example.org']);
    expect(rows[0]).toMatchObject({ reason: 'hard-bounce', code: 550, enhanced: '5.1.1', text: 'No such user', bounceCount: 1 });

    const outboundBefore = await db.outboundMessage.count();
    const pendingBefore = await db.pendingSend.count();
    const refused = await send(me, { to: ['Gone <GONE@example.org>', 'fine@example.org'] });
    expect(refused.status).toBe(422);
    const body = SuppressedRefusal.parse(refused.body);
    expect(body.addresses).toEqual(['gone@example.org']);
    expect(body.message).toContain('gone@example.org is on this server\'s suppression list (after a hard bounce); an admin can remove it');
    // Refused whole, and up front: neither sent nor held, and a Bcc is no way round it.
    expect((await send(me, { to: ['fine@example.org'], bcc: ['gone@example.org'] })).status).toBe(422);
    expect((await send(me, { to: ['gone@example.org'], undoSeconds: 10 })).status).toBe(422);
    expect(await db.outboundMessage.count()).toBe(outboundBefore);
    expect(await db.pendingSend.count()).toBe(pendingBefore);
  });

  it('lists entries with the bounce that caused each, filterable, newest first', async () => {
    const admin = await person(true);
    const res = await request(app).get('/api/admin/suppressions?q=GONE').set('cookie', admin.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const list = SuppressionList.parse(res.body);
    expect(list.total).toBe(1);
    expect(list.suppressions[0]).toMatchObject({ address: 'gone@example.org', reason: 'hard-bounce', code: 550, enhanced: '5.1.1', text: 'No such user', note: null });
    expect(list.suppressions[0]?.source).toMatchObject({ subject: 'Hello' });
    expect(SuppressionList.parse((await request(app).get('/api/admin/suppressions?q=nobody').set('cookie', admin.cookie)).body).total).toBe(0);
  });

  it('manual add: audited with the address, actor and reason; a duplicate is 409; a bad address is 400', async () => {
    const admin = await person(true);
    await stepUp(admin);
    const added = await request(app).post('/api/admin/suppressions').set(CSRF).set('cookie', admin.cookie).send({ address: ' Spam.Trap@Example.org ', reason: 'a known spam trap' });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ address: 'spam.trap@example.org', reason: 'manual', note: 'a known spam trap', code: null, source: null });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'admin.suppression.add', entityId: (added.body as { id: string }).id } });
    expect(audit).toMatchObject({ actorKind: 'account', actorAccountId: admin.id });
    expect(audit.after).toMatchObject({ address: 'spam.trap@example.org', reason: 'manual', note: 'a known spam trap' });

    await stepUp(admin);
    const dup = await request(app).post('/api/admin/suppressions').set(CSRF).set('cookie', admin.cookie).send({ address: 'spam.trap@example.org', reason: 'again' });
    expect(dup.status).toBe(409);
    await stepUp(admin);
    const bad = await request(app).post('/api/admin/suppressions').set(CSRF).set('cookie', admin.cookie).send({ address: 'not an address', reason: 'x' });
    expect(bad.status).toBe(400);

    const me = await person();
    const refused = await send(me, { to: ['spam.trap@example.org'] });
    expect(refused.status).toBe(422);
    expect(SuppressedRefusal.parse(refused.body).message).toContain('(added by an admin)');
  });

  it('removal re-allows sending, audited with the address, actor and reason', async () => {
    const admin = await person(true);
    const row = await db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'gone@example.org' } });
    await stepUp(admin);
    const removed = await request(app).delete(`/api/admin/suppressions/${row.id}`).set(CSRF).set('cookie', admin.cookie).send({ reason: 'the mailbox exists again' });
    expect(removed.status).toBe(204);
    expect(await db.suppressedRecipient.findUnique({ where: { id: row.id } })).toBeNull();
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'admin.suppression.remove', entityId: row.id } });
    expect(audit).toMatchObject({ actorKind: 'account', actorAccountId: admin.id });
    expect(audit.before).toMatchObject({ address: 'gone@example.org', reason: 'hard-bounce', enhanced: '5.1.1' });
    expect(audit.after).toMatchObject({ address: 'gone@example.org', reason: 'the mailbox exists again' });

    await stepUp(admin);
    const again = await request(app).delete(`/api/admin/suppressions/${row.id}`).set(CSRF).set('cookie', admin.cookie).send({ reason: 'x' });
    expect(again.status).toBe(404);

    const me = await person();
    expect((await send(me, { to: ['gone@example.org'] })).status).toBe(201);
  });

  it('an admin bounce from the queue screen never suppresses', async () => {
    const admin = await person(true);
    const message = await db.outboundMessage.create({ data: { accountId: admin.id, envelopeFrom: admin.address, headerFrom: admin.address, blobSha256: 'b'.repeat(64), size: 1, submittedVia: 'test' } });
    const recipient = await db.outboundRecipient.create({ data: { outboundMessageId: message.id, address: 'bounced-by-admin@example.org', domain: 'example.org', state: 'deferred', lastCode: 450, lastEnhanced: '4.1.1', lastText: 'try later' } });
    await stepUp(admin);
    const res = await request(app).post(`/api/admin/queue/recipients/${recipient.id}/bounce`).set(CSRF).set('cookie', admin.cookie);
    expect(res.status).toBe(202);
    expect((await db.outboundRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).state).toBe('bounced');
    expect(await db.suppressedRecipient.findUnique({ where: { address: 'bounced-by-admin@example.org' } })).toBeNull();
  });
});
