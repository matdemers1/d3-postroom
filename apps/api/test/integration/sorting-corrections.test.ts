// PST-T-14.9, HTTP half: a sorting correction is a move plus a recorded sender preference — audited,
// listed for Settings → Rules, and undoable (the preference and the move both reversed, the row kept
// and marked undone). Scoped strictly to the caller's own account; 401 without a session.
import { randomInt } from 'node:crypto';
import { missingAuditCount } from '@postroom/audit';
import { DEFAULT_MAILBOXES, randomUidValidity, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { request } from '../loopback.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode, TestClock } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

interface Person {
  id: string;
  cookie: string;
  box: Map<string, string>;
}

describe.skipIf(!baseUrl)('sorting corrections over HTTP (PST-T-14.9)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let guardMissesBefore = 0;
  let blobSeq = 0;

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    const box = new Map<string, string>();
    for (const m of DEFAULT_MAILBOXES) {
      const created = await db.mailbox.create({ data: { accountId: id, name: m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt), uidnext: 1 } });
      box.set(m.name, created.id);
    }
    return { id, cookie: await signIn(login, totpSecret), box };
  };

  /** A filed message with a stored verdict, the way the worker leaves one. */
  const filed = async (p: Person, opts: { mailbox: string; from: string; bucket: string; flags?: string[]; subject?: string }) => {
    blobSeq += 1;
    const sha = blobSeq.toString(16).padStart(64, 'c');
    await db.blob.create({ data: { sha256: sha, size: 10, refcount: 1, wrappedDek: Buffer.alloc(1), kekId: 'test', aead: 'aes-256-gcm', nonce: Buffer.alloc(12) } });
    const mailboxId = p.box.get(opts.mailbox) ?? '';
    const mb = await db.mailbox.update({ where: { id: mailboxId }, data: { uidnext: { increment: 1 }, highestModseq: { increment: 1 } } });
    const msg = await db.message.create({
      data: { mailboxId, uid: mb.uidnext - 1, modseq: mb.highestModseq, blobSha256: sha, size: 10, internalDate: new Date(), fromAddress: opts.from, subject: opts.subject ?? 'hello', flags: opts.flags ?? [] },
    });
    await db.messageVerdict.create({ data: { messageId: msg.id, bucket: opts.bucket, reasons: ['auth: spf=pass dkim=pass dmarc=pass arc=none', `${opts.bucket}: because`], scores: {} } });
    return msg;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t149api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('needs a session, and the CSRF header for a mutation', async () => {
    expect((await request(app).get('/api/sorting/corrections')).status).toBe(401);
    expect((await request(app).post('/api/sorting/corrections').set(CSRF).send({})).status).toBe(401);
    const me = await person();
    const msg = await filed(me, { mailbox: 'Notifications', from: 'notifications@github.com', bucket: 'notifications' });
    expect((await request(app).post('/api/sorting/corrections').set('cookie', me.cookie).send({ messageId: msg.id, bucket: 'priority' })).status).toBe(403);
  });

  it('"Move this message to Priority": moves it to INBOX with $Priority, pins the sender, adds a reason, audits, lists it', async () => {
    const me = await person();
    const msg = await filed(me, { mailbox: 'Notifications', from: 'Elena+gh@Example.org', bucket: 'notifications', subject: 'PR #212' });

    const res = await request(app).post('/api/sorting/corrections').set(CSRF).set('cookie', me.cookie).send({ messageId: msg.id, bucket: 'priority', scope: 'sender' });
    expect(res.status).toBe(201);
    const body = res.body as { correction: { id: string; target: string; toBucket: string; fromBucket: string; moved: boolean; messageId: string }; message: { id: string; mailboxId: string; flags: string[]; bucket: string } };
    expect(body.correction).toMatchObject({ target: 'elena@example.org', toBucket: 'priority', fromBucket: 'notifications', moved: true, scope: 'sender', source: 'chip', undoneAt: null });
    expect(body.message).toMatchObject({ mailboxId: me.box.get('INBOX'), flags: ['$Priority'], bucket: 'priority' });
    expect(body.correction.messageId).toBe(body.message.id);

    const pin = await db.senderPin.findUniqueOrThrow({ where: { accountId_address: { accountId: me.id, address: 'elena@example.org' } } });
    expect(pin.bucket).toBe('priority');
    const verdict = await db.messageVerdict.findUniqueOrThrow({ where: { messageId: body.message.id } });
    expect(verdict.reasons[0]).toBe('auth: spf=pass dkim=pass dmarc=pass arc=none');
    expect(verdict.reasons.at(-1)).toMatch(/^corrected: you put this in Priority/);
    // The move trained the Bayes model like any other move between buckets (PST-REQ-104).
    expect(await db.bayesTrainingEvent.count({ where: { accountId: me.id, messageId: body.message.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { entityId: body.correction.id, actorAccountId: me.id, action: 'sorting.correction.create' } })).toBe(1);

    const list = await request(app).get('/api/sorting/corrections').set('cookie', me.cookie);
    expect(list.status).toBe(200);
    expect((list.body as { corrections: { id: string }[] }).corrections.map((c) => c.id)).toEqual([body.correction.id]);
  });

  it('"Always put github.com in Notifications": a domain preference, nothing moved', async () => {
    const me = await person();
    const msg = await filed(me, { mailbox: 'Notifications', from: 'notifications@github.com', bucket: 'notifications' });
    const res = await request(app).post('/api/sorting/corrections').set(CSRF).set('cookie', me.cookie).send({ messageId: msg.id, bucket: 'notifications', scope: 'domain' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ correction: { target: '@github.com', scope: 'domain', moved: false }, message: { id: msg.id, mailboxId: me.box.get('Notifications') } });
    expect((await db.senderPin.findUniqueOrThrow({ where: { accountId_address: { accountId: me.id, address: '@github.com' } } })).bucket).toBe('notifications');
  });

  it('refuses a domain preference for a mailbox provider or for Priority', async () => {
    const me = await person();
    const msg = await filed(me, { mailbox: 'Newsletters', from: 'jane@gmail.com', bucket: 'newsletters' });
    const a = await request(app).post('/api/sorting/corrections').set(CSRF).set('cookie', me.cookie).send({ messageId: msg.id, bucket: 'newsletters', scope: 'domain' });
    expect(a.status).toBe(400);
    const b = await request(app).post('/api/sorting/corrections').set(CSRF).set('cookie', me.cookie).send({ messageId: msg.id, bucket: 'priority', scope: 'domain' });
    expect(b.status).toBe(400);
    expect(await db.sortingCorrection.count({ where: { accountId: me.id } })).toBe(0);
  });

  it('within INBOX, People → Priority is a keyword change, and Undo puts $People back', async () => {
    const me = await person();
    const msg = await filed(me, { mailbox: 'INBOX', from: 'sam@example.net', bucket: 'people', flags: ['$People', '\\Seen'] });
    const res = await request(app).post('/api/sorting/corrections').set(CSRF).set('cookie', me.cookie).send({ messageId: msg.id, bucket: 'priority' });
    expect(res.status).toBe(201);
    const made = res.body as { correction: { id: string }; message: { id: string; flags: string[] } };
    expect(made.message.id).toBe(msg.id);
    expect([...made.message.flags].sort()).toEqual(['$Priority', '\\Seen']);

    const undo = await request(app).post(`/api/sorting/corrections/${made.correction.id}/undo`).set(CSRF).set('cookie', me.cookie);
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ movedBack: true, preferenceRestored: true, message: { id: msg.id, bucket: 'people' } });
    expect([...(undo.body as { message: { flags: string[] } }).message.flags].sort()).toEqual(['$People', '\\Seen']);
  });

  it('Undo reverses both halves, keeps the row marked undone, audits, and cannot run twice', async () => {
    const me = await person();
    await db.senderPin.create({ data: { accountId: me.id, address: 'deals@shop.example', screen: 'allow', bucket: 'updates' } });
    const msg = await filed(me, { mailbox: 'Updates', from: 'deals@shop.example', bucket: 'updates' });
    const res = await request(app).post('/api/sorting/corrections').set(CSRF).set('cookie', me.cookie).send({ messageId: msg.id, bucket: 'newsletters' });
    const made = res.body as { correction: { id: string }; message: { id: string; mailboxId: string } };
    expect(made.message.mailboxId).toBe(me.box.get('Newsletters'));

    const undo = await request(app).post(`/api/sorting/corrections/${made.correction.id}/undo`).set(CSRF).set('cookie', me.cookie);
    expect(undo.status).toBe(200);
    const body = undo.body as { movedBack: boolean; preferenceRestored: boolean; message: { id: string; mailboxId: string; bucket: string }; correction: { undoneAt: string | null } };
    expect(body).toMatchObject({ movedBack: true, preferenceRestored: true, message: { mailboxId: me.box.get('Updates'), bucket: 'updates' } });
    expect(body.correction.undoneAt).not.toBeNull();
    // The pin is back as it was — bucket AND the screen decision it already carried.
    expect(await db.senderPin.findUniqueOrThrow({ where: { accountId_address: { accountId: me.id, address: 'deals@shop.example' } } })).toMatchObject({ bucket: 'updates', screen: 'allow' });
    const verdict = await db.messageVerdict.findUniqueOrThrow({ where: { messageId: body.message.id } });
    expect(verdict.reasons.some((r) => r.startsWith('corrected:'))).toBe(false);
    // Kept, marked, gone from the list.
    expect(await db.sortingCorrection.count({ where: { id: made.correction.id } })).toBe(1);
    expect((await request(app).get('/api/sorting/corrections').set('cookie', me.cookie)).body).toEqual({ corrections: [] });
    expect(await db.auditEvent.count({ where: { entityId: made.correction.id, action: 'sorting.correction.undo' } })).toBe(1);

    expect((await request(app).post(`/api/sorting/corrections/${made.correction.id}/undo`).set(CSRF).set('cookie', me.cookie)).status).toBe(409);
  });

  it('Undo of a new pin removes it; a message that moved on since is left where it is', async () => {
    const me = await person();
    const msg = await filed(me, { mailbox: 'Receipts', from: 'billing@vendor.example', bucket: 'receipts' });
    const made = (await request(app).post('/api/sorting/corrections').set(CSRF).set('cookie', me.cookie).send({ messageId: msg.id, bucket: 'updates' })).body as { correction: { id: string }; message: { id: string; modseq: string } };
    // The reader archived it afterwards.
    const archived = await request(app).patch(`/api/messages/${made.message.id}`).set(CSRF).set('cookie', me.cookie).set('if-match', `"${made.message.modseq}"`).send({ mailboxId: me.box.get('Archive') });
    expect(archived.status).toBe(200);
    const undo = await request(app).post(`/api/sorting/corrections/${made.correction.id}/undo`).set(CSRF).set('cookie', me.cookie);
    expect(undo.body).toMatchObject({ movedBack: false, preferenceRestored: true, message: null });
    expect(await db.senderPin.count({ where: { accountId: me.id, address: 'billing@vendor.example' } })).toBe(0);
  });

  it('one account can neither correct nor undo another\'s', async () => {
    const alice = await person();
    const bob = await person();
    const msg = await filed(alice, { mailbox: 'Updates', from: 'x@corp.example', bucket: 'updates' });
    expect((await request(app).post('/api/sorting/corrections').set(CSRF).set('cookie', bob.cookie).send({ messageId: msg.id, bucket: 'receipts' })).status).toBe(404);
    const made = (await request(app).post('/api/sorting/corrections').set(CSRF).set('cookie', alice.cookie).send({ messageId: msg.id, bucket: 'receipts' })).body as { correction: { id: string } };
    expect((await request(app).post(`/api/sorting/corrections/${made.correction.id}/undo`).set(CSRF).set('cookie', bob.cookie)).status).toBe(404);
    expect((await request(app).get('/api/sorting/corrections').set('cookie', bob.cookie)).body).toEqual({ corrections: [] });
  });

  it('left no mutation unaudited', () => {
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
