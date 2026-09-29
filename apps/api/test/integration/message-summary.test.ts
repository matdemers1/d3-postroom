// PST-T-14.2: every list the webmail renders — a mailbox page, a thread and search's `messages` —
// carries fromName and snippet for each message, stored on the row at filing time (here written by
// indexMessage, as the worker's file stage writes them), and a move keeps them. Every response is
// checked against the zod schema the OpenAPI document is generated from.
import { randomInt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { indexMessage } from '@postroom/search';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { MessageDetail, MessageList, SearchResponse, ThreadDetail } from '../../src/mail/schemas.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';
const CSRF = { 'x-postroom-csrf': '1' };

interface Person {
  id: string;
  cookie: string;
  inbox: string;
  archive: string;
}

describe.skipIf(!baseUrl)('list summaries: fromName and snippet (PST-T-14.2)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  const clock = new TestClock();

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    const mk = (name: string, specialUse: SpecialUse) => db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    const inbox = await mk('INBOX', SpecialUse.inbox);
    const archive = await mk('Archive', SpecialUse.archive);
    return { id, cookie: await signIn(login, totpSecret), inbox: inbox.id, archive: archive.id };
  };

  /** Files a message into `mailboxId` and indexes it with its display name, as the file stage does. */
  const file = async (me: Person, fields: { subject: string; from: string; fromName: string | null; body: string; threadId?: string }) => {
    const raw = Buffer.from(`From: ${fields.from}\r\nSubject: ${fields.subject}\r\n\r\n${fields.body}\r\n`);
    const put = await blobs.put(raw);
    return db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ uidnext: number; highest_modseq: bigint }[]>`
        SELECT uidnext, highest_modseq FROM mailbox WHERE id = ${me.inbox}::uuid FOR UPDATE`;
      const mb = rows[0];
      if (mb === undefined) throw new Error('no mailbox');
      const modseq = mb.highest_modseq + 1n;
      const created = await tx.message.create({
        data: {
          mailboxId: me.inbox,
          uid: mb.uidnext,
          modseq,
          blobSha256: put.sha256,
          size: put.size,
          internalDate: new Date(),
          subject: fields.subject,
          fromAddress: fields.from,
          ...(fields.threadId === undefined ? {} : { threadId: fields.threadId }),
        },
      });
      await tx.mailbox.update({ where: { id: me.inbox }, data: { uidnext: mb.uidnext + 1, highestModseq: modseq } });
      await indexMessage(tx, { messageId: created.id, accountId: me.id, subject: fields.subject, from: fields.from, bodyText: fields.body, fromName: fields.fromName });
      return created;
    });
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t142_api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t142-api-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: kekFromBase64(KEK_BASE64) });
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('a mailbox page, a thread and search all carry fromName and snippet for every message', async () => {
    const me = await person();
    const thread = await db.thread.create({ data: { accountId: me.id, subject: 'Photos from Sunday', messageCount: 2 } });
    const named = await file(me, {
      subject: 'Photos from Sunday',
      from: 'linda.demers@example.com',
      fromName: 'Linda Demers',
      body: 'Photos from Sunday are up —\n  have a look!\n\nOn Sun, Mat wrote:\n> Did you get the photos?',
      threadId: thread.id,
    });
    const bare = await file(me, { subject: 'Re: Photos from Sunday', from: 'bare@example.com', fromName: null, body: 'Lovely platypus pictures. '.repeat(20), threadId: thread.id });

    const page = MessageList.parse((await request(app).get(`/api/mailboxes/${me.inbox}/messages`).set('cookie', me.cookie)).body);
    const byId = new Map(page.messages.map((m) => [m.id, m]));
    expect(byId.get(named.id)).toMatchObject({ from: 'linda.demers@example.com', fromName: 'Linda Demers', snippet: 'Photos from Sunday are up — have a look!' });
    expect(byId.get(bare.id)?.fromName).toBeNull();
    const long = byId.get(bare.id)?.snippet ?? '';
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.startsWith('Lovely platypus pictures. Lovely')).toBe(true);
    expect(long.endsWith('…')).toBe(true);

    const threadBody = ThreadDetail.parse((await request(app).get(`/api/threads/${thread.id}`).set('cookie', me.cookie)).body);
    expect(threadBody.messages.map((m) => [m.id, m.fromName, m.snippet])).toEqual(
      expect.arrayContaining([
        [named.id, 'Linda Demers', 'Photos from Sunday are up — have a look!'],
        [bare.id, null, long],
      ]),
    );

    const search = SearchResponse.parse((await request(app).get('/api/search?q=platypus').set('cookie', me.cookie)).body);
    expect(search.messages.map((m) => [m.id, m.fromName, m.snippet])).toEqual([[bare.id, null, long]]);
  });

  it('a message not yet summarised lists with a null snippet; a move keeps the summary', async () => {
    const me = await person();
    const m = await file(me, { subject: 'Moving', from: 'mover@example.com', fromName: 'Mo Ver', body: 'Off to the archive.' });
    const pending = await file(me, { subject: 'Pending', from: 'p@example.com', fromName: null, body: 'x' });
    await db.message.update({ where: { id: pending.id }, data: { snippet: null } });

    const page = MessageList.parse((await request(app).get(`/api/mailboxes/${me.inbox}/messages`).set('cookie', me.cookie)).body);
    expect(page.messages.find((x) => x.id === pending.id)).toMatchObject({ fromName: null, snippet: null });

    const got = await request(app).get(`/api/messages/${m.id}`).set('cookie', me.cookie);
    const etag = got.get('etag') ?? '';
    const moved = await request(app).patch(`/api/messages/${m.id}`).set(CSRF).set('cookie', me.cookie).set('if-match', etag).send({ mailboxId: me.archive });
    expect(moved.status).toBe(200);
    const detail = MessageDetail.parse(moved.body);
    expect(detail).toMatchObject({ mailboxId: me.archive, fromName: 'Mo Ver', snippet: 'Off to the archive.' });
  });
});
