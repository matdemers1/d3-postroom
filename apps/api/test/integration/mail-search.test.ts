// PST-T-3.13: GET /api/search over @postroom/search, scoped to the caller's own account, with the
// query operators (from:, in:) working end to end. Every response is checked against the zod
// schema the OpenAPI document is generated from (PST-REQ-085).
import { randomInt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SearchResponse } from '../../src/mail/schemas.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const PASSWORD = 'correct horse battery staple';

interface Person {
  id: string;
  login: string;
  cookie: string;
  inbox: string;
  archive: string;
}

function rfc5322(opts: { subject: string; from?: string; body?: string }): Buffer {
  const from = opts.from ?? 'Sender <sender@example.org>';
  return Buffer.from(
    [
      `From: ${from}`,
      'To: someone@d3cloud.io',
      `Subject: ${opts.subject}`,
      'Date: Thu, 24 Sep 2026 10:00:00 +0000',
      `Message-ID: <${randomInt(1e9)}@example.org>`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      opts.body ?? `Hello from ${opts.subject}.`,
      '',
    ].join('\r\n'),
  );
}

describe.skipIf(!baseUrl)('GET /api/search (PST-T-3.13)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  const clock = new TestClock();

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set({ 'x-postroom-csrf': '1' }).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set({ 'x-postroom-csrf': '1' }).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    const mk = (name: string, specialUse: SpecialUse) => db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    const inbox = await mk('INBOX', SpecialUse.inbox);
    const archive = await mk('Archive', SpecialUse.archive);
    return { id, login, cookie: await signIn(login, totpSecret), inbox: inbox.id, archive: archive.id };
  };

  /** Files a message and indexes it exactly as the worker's file stage does (PST-T-3.13). */
  const file = async (accountId: string, mailboxId: string, raw: Buffer, fields: { subject: string; from: string; body: string }) => {
    const put = await blobs.put(raw);
    const message = await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ uidnext: number; highest_modseq: bigint }[]>`
        SELECT uidnext, highest_modseq FROM mailbox WHERE id = ${mailboxId}::uuid FOR UPDATE`;
      const mb = rows[0];
      if (mb === undefined) throw new Error('no mailbox');
      const modseq = mb.highest_modseq + 1n;
      const created = await tx.message.create({
        data: {
          mailboxId,
          uid: mb.uidnext,
          modseq,
          blobSha256: put.sha256,
          size: put.size,
          internalDate: new Date(),
          flags: [],
          subject: fields.subject,
          fromAddress: fields.from,
          sentAt: new Date('2026-09-24T10:00:00Z'),
        },
      });
      await tx.mailbox.update({ where: { id: mailboxId }, data: { uidnext: mb.uidnext + 1, highestModseq: modseq } });
      return created;
    });
    await db.messageSearch.create({
      data: { messageId: message.id, accountId, subject: fields.subject, fromText: fields.from, bodyText: fields.body },
    });
    return message;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t313_api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t313-api-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: kekFromBase64(KEK_BASE64) });
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('finds a body word for the owner, not for another account', async () => {
    const alice = await person();
    const bob = await person();
    const raw = rfc5322({ subject: 'quarterly numbers', from: 'finance@example.org', body: 'the platypus budget is attached' });
    const m = await file(alice.id, alice.inbox, raw, { subject: 'quarterly numbers', from: 'finance@example.org', body: 'the platypus budget is attached' });

    const asAlice = await request(app).get('/api/search?q=platypus').set('cookie', alice.cookie);
    expect(asAlice.status).toBe(200);
    const parsed = SearchResponse.parse(asAlice.body);
    expect(parsed.results.map((r) => r.messageId)).toContain(m.id);
    const hit = parsed.results.find((r) => r.messageId === m.id);
    expect(hit).toMatchObject({ mailboxId: alice.inbox, subject: 'quarterly numbers', from: 'finance@example.org' });
    expect(hit?.snippet.toLowerCase()).toContain('platypus');

    const asBob = await request(app).get('/api/search?q=platypus').set('cookie', bob.cookie);
    expect(asBob.status).toBe(200);
    expect(SearchResponse.parse(asBob.body).results).toEqual([]);
  });

  it('supports operators end to end: from: and in:', async () => {
    const me = await person();
    const inboxMsg = await file(me.id, me.inbox, rfc5322({ subject: 'from carol', from: 'carol@example.org', body: 'lunch tomorrow' }), {
      subject: 'from carol',
      from: 'carol@example.org',
      body: 'lunch tomorrow',
    });
    await file(me.id, me.archive, rfc5322({ subject: 'from dave', from: 'dave@example.org', body: 'lunch next week' }), {
      subject: 'from dave',
      from: 'dave@example.org',
      body: 'lunch next week',
    });

    const byFrom = SearchResponse.parse((await request(app).get('/api/search?q=' + encodeURIComponent('from:carol@example.org')).set('cookie', me.cookie)).body);
    expect(byFrom.results.map((r) => r.messageId)).toEqual([inboxMsg.id]);

    const byMailbox = SearchResponse.parse((await request(app).get('/api/search?q=' + encodeURIComponent('lunch in:inbox')).set('cookie', me.cookie)).body);
    expect(byMailbox.results.map((r) => r.messageId)).toEqual([inboxMsg.id]);

    const scoped = SearchResponse.parse((await request(app).get(`/api/search?q=lunch&mailboxId=${me.archive}`).set('cookie', me.cookie)).body);
    expect(scoped.results.map((r) => r.mailboxId)).toEqual([me.archive]);
  });

  it('validates the query and scopes mailboxId to the caller', async () => {
    const alice = await person();
    const bob = await person();
    expect((await request(app).get('/api/search').set('cookie', alice.cookie)).status).toBe(400);
    expect((await request(app).get('/api/search?q=hello&mailboxId=not-a-uuid').set('cookie', alice.cookie)).status).toBe(400);
    expect((await request(app).get(`/api/search?q=hello&mailboxId=${bob.inbox}`).set('cookie', alice.cookie)).status).toBe(404);
    expect((await request(app).get('/api/search?q=hello')).status).toBe(401);
  });
});
