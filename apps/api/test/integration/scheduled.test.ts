// PST-T-9.1 over HTTP against a real database and blob store: the API half of undo send (PST-REQ-140),
// scheduled send (PST-REQ-141), snooze (PST-REQ-142) and remind-if-no-reply (PST-REQ-143). The worker
// half — releasing, returning, resurfacing — is apps/worker/test/integration/scheduled.test.ts.
//   · a held send queues nothing: no outbound_message, no Sent copy; the message is in Drafts;
//   · undo within the window cancels it and it stays in Drafts; undo after the release is a 409;
//   · a scheduled send is listed, can be moved, and discarding its draft cancels it;
//   · snooze moves the thread's INBOX messages to Snoozed IMAP-visibly (expunged_message + notify);
//   · every mutation audited (the audit guard's miss count does not move).
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import { assignThread } from '@postroom/threading';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { PendingSend, PendingSendList, SendResponse } from '../../src/compose/schemas.js';
import { Snooze } from '../../src/mail/snooze.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!baseUrl)('held sends and snooze over HTTP (PST-T-9.1)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  const clock = new TestClock();
  let guardMissesBefore = 0;
  let listener: pg.Client;
  const notified: string[] = [];

  interface Person {
    id: string;
    address: string;
    cookie: string;
    inbox: string;
    sent: string;
    drafts: string;
  }

  const person = async (): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, displayName: `Person ${login}` });
    const mk = (name: string, specialUse: SpecialUse) => db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    const inbox = await mk('INBOX', SpecialUse.inbox);
    const sent = await mk('Sent', SpecialUse.sent);
    const drafts = await mk('Drafts', SpecialUse.drafts);
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(totpSecret, clock.now()) });
    expect(second.status).toBe(200);
    return { id, address: `${login}@d3cloud.io`, cookie: cookieHeader(cookiesOf(second)), inbox: inbox.id, sent: sent.id, drafts: drafts.id };
  };

  const send = (who: Person, body: Record<string, unknown>) =>
    request(app).post('/api/compose/send').set(CSRF).set('cookie', who.cookie).send({ from: who.address, to: ['alice@example.org'], subject: 'Hello', text: 'Hi Alice', ...body });
  const undo = (who: Person, id: string) => request(app).post(`/api/compose/pending/${id}/undo`).set(CSRF).set('cookie', who.cookie).send({});
  const outbound = (who: Person) => db.outboundMessage.count({ where: { accountId: who.id } });

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t91_api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t91-blobs-'));
    const kek = kekFromBase64(KEK_BASE64);
    blobs = createBlobStore({ root: blobRoot, db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
    listener = new pg.Client({ connectionString: testDb.url });
    await listener.connect();
    listener.on('notification', (n) => {
      if (n.channel === 'postroom_mailbox' && n.payload !== undefined) notified.push(n.payload);
    });
    await listener.query('LISTEN postroom_mailbox');
  }, 120_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await listener.end();
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('undo send: a held send queues nothing and sits in Drafts; undo within the window cancels it, and it stays in Drafts', async () => {
    const me = await person();
    const res = await send(me, { undoSeconds: 10, bcc: ['hidden@example.org'] });
    expect(res.status).toBe(202);
    const pending = PendingSend.parse(res.body);
    expect(pending.kind).toBe('undo');
    expect(pending.state).toBe('held');
    expect(new Date(pending.releaseAt).getTime() - clock.now().getTime()).toBeGreaterThan(9_000);
    expect(await outbound(me)).toBe(0);
    expect(await db.message.count({ where: { mailboxId: me.sent } })).toBe(0);
    const draft = await db.message.findUniqueOrThrow({ where: { id: pending.draftId ?? '' } });
    expect(draft.mailboxId).toBe(me.drafts);
    expect(draft.flags).toEqual(['\\Draft', '\\Seen']);
    // The Drafts copy keeps its Bcc; the held message (what will be submitted) has none.
    expect((await blobs.getBuffer(draft.blobSha256)).toString('latin1')).toContain('Bcc: hidden@example.org\r\n');
    const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
    expect((await blobs.getBuffer(row.heldBlobSha256)).toString('latin1')).not.toContain('Bcc:');
    expect(row.recipients.sort()).toEqual(['alice@example.org', 'hidden@example.org']);

    const listed = PendingSendList.parse((await request(app).get('/api/compose/pending').set('cookie', me.cookie)).body);
    expect(listed.pending.map((p) => p.id)).toEqual([pending.id]);

    const undone = await undo(me, pending.id);
    expect(undone.status).toBe(200);
    expect(PendingSend.parse(undone.body).state).toBe('cancelled');
    expect(await outbound(me)).toBe(0);
    expect(await db.message.count({ where: { id: pending.draftId ?? '', mailboxId: me.drafts } })).toBe(1);
    // The held blob's reference went with it.
    expect(await db.blob.findUnique({ where: { sha256: row.heldBlobSha256 } })).toBeNull();
    expect(await db.auditEvent.count({ where: { entityId: pending.id, action: { in: ['compose.hold', 'compose.undo'] } } })).toBe(2);
    expect((await undo(me, pending.id)).status).toBe(409);
    expect(PendingSendList.parse((await request(app).get('/api/compose/pending').set('cookie', me.cookie)).body).pending).toEqual([]);
  });

  it('undo after the release is refused: it has been sent', async () => {
    const me = await person();
    const pending = PendingSend.parse((await send(me, { undoSeconds: 5 })).body);
    await db.pendingSend.update({ where: { id: pending.id }, data: { state: 'released' } });
    const res = await undo(me, pending.id);
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toMatch(/already been sent/);
  });

  it('another account cannot see or undo my held send', async () => {
    const me = await person();
    const other = await person();
    const pending = PendingSend.parse((await send(me, { undoSeconds: 5 })).body);
    expect((await undo(other, pending.id)).status).toBe(404);
    expect(PendingSendList.parse((await request(app).get('/api/compose/pending').set('cookie', other.cookie)).body).pending).toEqual([]);
  });

  it('undoSeconds 0 or absent sends at once, and remindAfterSeconds arms a reminder on the Sent copy', async () => {
    const me = await person();
    const res = await send(me, { undoSeconds: 0, remindAfterSeconds: 86_400 });
    expect(res.status).toBe(201);
    const sent = SendResponse.parse(res.body);
    expect(await outbound(me)).toBe(1);
    const reminder = await db.replyReminder.findUniqueOrThrow({ where: { id: sent.reminderId ?? '' } });
    expect(reminder.sentMessageId).toBe(sent.sentMessageId);
    expect(reminder.dueAt.getTime() - reminder.sentAt.getTime()).toBe(86_400_000);
    expect(reminder.state).toBe('pending');
  });

  it('scheduled send: validated, listed, movable; discarding its draft cancels it', async () => {
    const me = await person();
    expect((await send(me, { sendAt: new Date(clock.now().getTime() - 1000).toISOString() })).status).toBe(400);
    expect((await send(me, { sendAt: new Date(clock.now().getTime() + 60_000).toISOString(), undoSeconds: 10 })).status).toBe(400);
    expect((await send(me, { undoSeconds: 31 })).status).toBe(400);

    const at = new Date(clock.now().getTime() + 3_600_000);
    const res = await send(me, { sendAt: at.toISOString(), remindAfterSeconds: 3_600 });
    expect(res.status).toBe(202);
    const pending = PendingSend.parse(res.body);
    expect(pending.kind).toBe('scheduled');
    expect(pending.releaseAt).toBe(at.toISOString());
    expect(pending.remindAfterSeconds).toBe(3_600);
    // Dated when it goes, not when it was written.
    const row = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
    expect((await blobs.getBuffer(row.heldBlobSha256)).toString('latin1')).toContain(`Date: ${at.toUTCString().replace('GMT', '+0000')}`);

    const later = new Date(at.getTime() + 86_400_000);
    const moved = await request(app).patch(`/api/compose/pending/${pending.id}`).set(CSRF).set('cookie', me.cookie).send({ sendAt: later.toISOString() });
    expect(moved.status).toBe(200);
    expect(PendingSend.parse(moved.body).releaseAt).toBe(later.toISOString());

    const discarded = await request(app).delete(`/api/compose/drafts/${pending.draftId ?? ''}`).set(CSRF).set('cookie', me.cookie);
    expect(discarded.status).toBe(204);
    const after = await db.pendingSend.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.state).toBe('cancelled');
    expect(after.reason).toMatch(/discarded/);
    expect(await outbound(me)).toBe(0);
  });

  it('a held send replaces the draft it was written in', async () => {
    const me = await person();
    const saved = await request(app).post('/api/compose/drafts').set(CSRF).set('cookie', me.cookie).send({ from: me.address, to: ['alice@example.org'], subject: 'Draft', text: 'first' });
    expect(saved.status).toBe(201);
    const oldId = (saved.body as { id: string }).id;
    const pending = PendingSend.parse((await send(me, { undoSeconds: 10, draftId: oldId })).body);
    expect(await db.message.count({ where: { id: oldId } })).toBe(0);
    expect(await db.message.count({ where: { mailboxId: me.drafts } })).toBe(1);
    expect(pending.draftId).not.toBe(oldId);
  });

  // --- Snooze ----------------------------------------------------------------------------------------

  const inboundThread = async (me: Person): Promise<{ threadId: string; ids: string[] }> => {
    const ids: string[] = [];
    let threadId = '';
    let parent: string | null = null;
    for (const subject of ['Plans', 'Re: Plans']) {
      const mid = `${randomUUID()}@example.org`;
      const raw = Buffer.from(`From: alice@example.org\r\nTo: ${me.address}\r\nSubject: ${subject}\r\nMessage-ID: <${mid}>\r\n${parent === null ? '' : `In-Reply-To: <${parent}>\r\n`}\r\nbody\r\n`);
      const put = await blobs.put(raw);
      const filed = await db.$transaction((tx) => fileLocalMessage(tx, { accountId: me.id, mailbox: 'INBOX', blobSha256: put.sha256, size: put.size, internalDate: new Date(), flags: ['\\Seen'] }));
      threadId = await assignThread(db, { accountId: me.id, messageId: filed.id, messageIdHeader: `<${mid}>`, ...(parent === null ? {} : { inReplyTo: `<${parent}>` }), references: parent === null ? [] : [`<${parent}>`], subject, from: 'alice@example.org', to: me.address, date: new Date() });
      ids.push(filed.id);
      parent = mid;
    }
    return { threadId, ids };
  };

  it('snooze moves the thread out of INBOX into Snoozed, IMAP-visibly; unsnooze brings it back', async () => {
    const me = await person();
    const { threadId, ids } = await inboundThread(me);
    const inboxUids = (await db.message.findMany({ where: { id: { in: ids } }, select: { uid: true } })).map((m) => m.uid).sort();
    const until = new Date(clock.now().getTime() + 3_600_000);
    notified.length = 0;
    const res = await request(app).post(`/api/threads/${threadId}/snooze`).set(CSRF).set('cookie', me.cookie).send({ until: until.toISOString() });
    expect(res.status).toBe(200);
    const snooze = Snooze.parse(res.body);
    expect(snooze.messageIds.sort()).toEqual([...ids].sort());
    expect(snooze.until).toBe(until.toISOString());

    const box = await db.mailbox.findUniqueOrThrow({ where: { id: snooze.mailboxId } });
    expect(box.name).toBe('Snoozed');
    expect(box.subscribed).toBe(true);
    expect(await db.message.count({ where: { mailboxId: me.inbox } })).toBe(0);
    expect(await db.message.count({ where: { mailboxId: box.id, id: { in: ids } } })).toBe(2);
    // EXPUNGE (VANISHED) in INBOX for exactly those UIDs, and a notify on both mailboxes.
    expect((await db.expungedMessage.findMany({ where: { mailboxId: me.inbox } })).map((e) => e.uid).sort()).toEqual(inboxUids);
    await new Promise((r) => setTimeout(r, 200));
    expect(notified).toEqual(expect.arrayContaining([me.inbox, box.id]));
    expect(await db.auditEvent.count({ where: { action: 'thread.snooze', entityId: threadId } })).toBe(1);

    // The messages are listed under Snoozed in the API as well.
    const listed = await request(app).get(`/api/mailboxes/${box.id}/messages`).set('cookie', me.cookie);
    expect(listed.status).toBe(200);
    expect((listed.body as { messages: { id: string }[] }).messages.map((m) => m.id).sort()).toEqual([...ids].sort());

    const back = await request(app).delete(`/api/threads/${threadId}/snooze`).set(CSRF).set('cookie', me.cookie);
    expect(back.status).toBe(200);
    expect(Snooze.parse(back.body).state).toBe('unsnoozed');
    expect(await db.message.count({ where: { mailboxId: me.inbox, id: { in: ids } } })).toBe(2);
    expect((await request(app).delete(`/api/threads/${threadId}/snooze`).set(CSRF).set('cookie', me.cookie)).status).toBe(404);
  });

  it('snooze is refused for a time in the past, a thread with nothing in INBOX, and another account’s thread', async () => {
    const me = await person();
    const other = await person();
    const { threadId } = await inboundThread(me);
    const post = (who: Person, until: Date) => request(app).post(`/api/threads/${threadId}/snooze`).set(CSRF).set('cookie', who.cookie).send({ until: until.toISOString() });
    expect((await post(me, new Date(clock.now().getTime() - 1000))).status).toBe(400);
    expect((await post(other, new Date(clock.now().getTime() + 60_000))).status).toBe(404);
    // A conversation that is only in Sent has nothing to snooze.
    const put = await blobs.put(Buffer.from(`From: ${me.address}\r\nTo: bob@example.org\r\nSubject: Mine\r\nMessage-ID: <${randomUUID()}@d3cloud.io>\r\n\r\nbody\r\n`));
    const filed = await db.$transaction((tx) => fileLocalMessage(tx, { accountId: me.id, mailbox: 'Sent', blobSha256: put.sha256, size: put.size, internalDate: new Date(), flags: ['\\Seen'] }));
    const sentThread = await assignThread(db, { accountId: me.id, messageId: filed.id, messageIdHeader: `<${randomUUID()}@d3cloud.io>`, references: [], subject: 'Mine', from: me.address, to: 'bob@example.org', date: new Date() });
    const res = await request(app).post(`/api/threads/${sentThread}/snooze`).set(CSRF).set('cookie', me.cookie).send({ until: new Date(clock.now().getTime() + 60_000).toISOString() });
    expect(res.status).toBe(409);
  });
});
