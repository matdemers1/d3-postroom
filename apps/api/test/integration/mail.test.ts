// PST-T-3.9: mailboxes, messages, threads and the SSE stream over HTTP, against a real database and
// a real (encrypted) blob store. Every response is checked against the zod schema the OpenAPI
// document is generated from, so the spec and the wire cannot drift apart unnoticed (PST-REQ-085);
// a message filed by "the worker" appears on /api/events without a reload (PST-REQ-083).
import { randomInt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { MailboxList, MessageBody, MessageDetail, MessageList, ThreadDetail, MailboxChangedEvent, MessageNewEvent } from '../../src/mail/schemas.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

interface Person {
  id: string;
  login: string;
  cookie: string;
  inbox: string;
  archive: string;
}

function rfc5322(opts: { subject: string; from?: string; attachment?: { name: string; body: Buffer } }): Buffer {
  const from = opts.from ?? 'Sender <sender@example.org>';
  const head = [`From: ${from}`, 'To: someone@d3cloud.io', `Subject: ${opts.subject}`, 'Date: Thu, 24 Sep 2026 10:00:00 +0000', `Message-ID: <${randomInt(1e9)}@example.org>`, 'MIME-Version: 1.0'];
  if (opts.attachment === undefined) {
    return Buffer.from([...head, 'Content-Type: text/plain; charset=utf-8', '', `Hello from ${opts.subject}.`, ''].join('\r\n'));
  }
  const b = 'BOUNDARY-xyz';
  const quoted = opts.attachment.name.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const b64 = (opts.attachment.body.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  return Buffer.from(
    [
      ...head,
      `Content-Type: multipart/mixed; boundary="${b}"`,
      '',
      `--${b}`,
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain body.',
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p onclick="x()">HTML body</p>',
      '--alt--',
      `--${b}`,
      `Content-Type: application/pdf; name="${quoted}"`,
      `Content-Disposition: attachment; filename="${quoted}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      `--${b}--`,
      '',
    ].join('\r\n'),
  );
}

describe.skipIf(!baseUrl)('mail API (PST-T-3.9)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
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

  const person = async (): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    const mk = (name: string, specialUse: SpecialUse) =>
      db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    const inbox = await mk('INBOX', SpecialUse.inbox);
    const archive = await mk('Archive', SpecialUse.archive);
    await mk('Trash', SpecialUse.trash);
    return { id, login, cookie: await signIn(login, totpSecret), inbox: inbox.id, archive: archive.id };
  };

  /**
   * What the worker's file + notify stages do: store the blob, take uid = uidnext and
   * modseq = highestModseq + 1 under the mailbox row lock, then pg_notify the mailbox.
   */
  const file = async (mailboxId: string, raw: Buffer, fields: { subject: string; from?: string; flags?: string[]; threadId?: string }) => {
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
          flags: fields.flags ?? [],
          subject: fields.subject,
          fromAddress: fields.from ?? 'sender@example.org',
          sentAt: new Date('2026-09-24T10:00:00Z'),
          ...(fields.threadId !== undefined ? { threadId: fields.threadId } : {}),
        },
      });
      await tx.mailbox.update({ where: { id: mailboxId }, data: { uidnext: mb.uidnext + 1, highestModseq: modseq } });
      return created;
    });
    await db.$executeRaw`SELECT pg_notify('postroom_mailbox', ${mailboxId})`;
    return message;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t39');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t39-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: kekFromBase64(KEK_BASE64) });
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('needs a session', async () => {
    expect((await request(app).get('/api/mailboxes')).status).toBe(401);
    expect((await request(app).get('/api/events')).status).toBe(401);
  });

  it('lists mailboxes with counters, INBOX first', async () => {
    const me = await person();
    await file(me.inbox, rfc5322({ subject: 'one' }), { subject: 'one' });
    await file(me.inbox, rfc5322({ subject: 'two' }), { subject: 'two', flags: ['\\Seen'] });
    const res = await request(app).get('/api/mailboxes').set('cookie', me.cookie);
    expect(res.status).toBe(200);
    const body = MailboxList.parse(res.body);
    expect(body.mailboxes.map((m) => m.name)).toEqual(['INBOX', 'Archive', 'Trash']);
    expect(body.mailboxes[0]).toMatchObject({ id: me.inbox, total: 2, unseen: 1, uidnext: 3, highestModseq: '2' });
  });

  it('pages a mailbox newest first with a cursor', async () => {
    const me = await person();
    for (let i = 1; i <= 5; i++) await file(me.inbox, rfc5322({ subject: `m${i}` }), { subject: `m${i}` });
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/mailboxes/${me.inbox}/messages?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const res = await request(app).get(url).set('cookie', me.cookie);
      expect(res.status).toBe(200);
      const page = MessageList.parse(res.body);
      seen.push(...page.messages.map((m) => m.uid));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual([5, 4, 3, 2, 1]);
    expect((await request(app).get(`/api/mailboxes/${me.inbox}/messages?limit=0`).set('cookie', me.cookie)).status).toBe(400);
    expect((await request(app).get(`/api/mailboxes/${me.inbox}/messages?cursor=abc`).set('cookie', me.cookie)).status).toBe(400);
  });

  it('serves the message, its parsed body, the raw source and an attachment download', async () => {
    const me = await person();
    const pdf = Buffer.from('%PDF-1.4\n% not really a pdf\n\x00\x01\x02\xff');
    const raw = rfc5322({ subject: 'with attachment', attachment: { name: 'report "q3".pdf', body: pdf } });
    const m = await file(me.inbox, raw, { subject: 'with attachment' });

    const got = await request(app).get(`/api/messages/${m.id}`).set('cookie', me.cookie);
    expect(got.status).toBe(200);
    expect(got.headers['etag']).toBe(`"${m.modseq.toString()}"`);
    expect(MessageDetail.parse(got.body)).toMatchObject({ id: m.id, uid: 1, subject: 'with attachment', flags: [] });

    const body = await request(app).get(`/api/messages/${m.id}/body`).set('cookie', me.cookie);
    expect(body.status).toBe(200);
    const parsed = MessageBody.parse(body.body);
    expect(parsed.text?.trim()).toBe('Plain body.');
    expect(parsed.html).toContain('<p onclick="x()">HTML body</p>');
    expect(parsed.headers.find((h) => h.name.toLowerCase() === 'subject')?.value).toBe('with attachment');
    expect(parsed.attachments).toHaveLength(1);
    const att = parsed.attachments[0];
    expect(att).toMatchObject({ contentType: 'application/pdf', filename: 'report "q3".pdf', size: pdf.length });

    const rawRes = await request(app)
      .get(`/api/messages/${m.id}/raw`)
      .set('cookie', me.cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          cb(null, Buffer.concat(chunks));
        });
      });
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers['content-type']).toMatch(/^text\/plain/);
    expect(rawRes.headers['content-disposition']).toMatch(/^attachment;/);
    expect(Buffer.compare(rawRes.body as Buffer, raw)).toBe(0);

    const dl = await request(app)
      .get(`/api/messages/${m.id}/attachments/${att?.partId ?? ''}`)
      .set('cookie', me.cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          cb(null, Buffer.concat(chunks));
        });
      });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['content-disposition']).toMatch(/^attachment; filename="report _q3_.pdf"; filename\*=UTF-8''report%20%22q3%22.pdf$/);
    expect(dl.headers['x-postroom-content-type']).toBe('application/pdf');
    expect(Buffer.compare(dl.body as Buffer, pdf)).toBe(0);

    // A multipart container is not a download, and neither is a part that doesn't exist.
    expect((await request(app).get(`/api/messages/${m.id}/attachments/1`).set('cookie', me.cookie)).status).toBe(404);
    expect((await request(app).get(`/api/messages/${m.id}/attachments/1.9`).set('cookie', me.cookie)).status).toBe(404);
    expect((await request(app).get(`/api/messages/${m.id}/attachments/1.x`).set('cookie', me.cookie)).status).toBe(400);
  });

  it('changes flags only with a current If-Match, audited, bumping MODSEQ', async () => {
    const me = await person();
    const m = await file(me.inbox, rfc5322({ subject: 'flag me' }), { subject: 'flag me' });
    const url = `/api/messages/${m.id}`;
    const patch = { flags: { add: ['\\Seen', '$Important'] } };

    expect((await request(app).patch(url).set('cookie', me.cookie).set('if-match', '"1"').send(patch)).status).toBe(403);
    expect((await request(app).patch(url).set(CSRF).set('cookie', me.cookie).send(patch)).status).toBe(428);
    const stale = await request(app).patch(url).set(CSRF).set('cookie', me.cookie).set('if-match', '"999"').send(patch);
    expect(stale.status).toBe(412);
    expect(stale.headers['etag']).toBe(`"${m.modseq.toString()}"`);
    expect((await request(app).patch(url).set(CSRF).set('cookie', me.cookie).set('if-match', '"1"').send({ flags: { add: ['\\Recent'] } })).status).toBe(400);
    expect((await request(app).patch(url).set(CSRF).set('cookie', me.cookie).set('if-match', '"1"').send({ flags: { add: ['\\Deleted'] } })).status).toBe(400);
    expect((await request(app).patch(url).set(CSRF).set('cookie', me.cookie).set('if-match', '"1"').send({})).status).toBe(400);

    const ok = await request(app).patch(url).set(CSRF).set('cookie', me.cookie).set('if-match', `"${m.modseq.toString()}"`).send(patch);
    expect(ok.status).toBe(200);
    const after = MessageDetail.parse(ok.body);
    expect(after.flags).toEqual(['\\Seen', '$Important']);
    expect(BigInt(after.modseq)).toBe(m.modseq + 1n);
    expect(ok.headers['etag']).toBe(`"${after.modseq}"`);
    expect((await db.mailbox.findUniqueOrThrow({ where: { id: me.inbox } })).highestModseq).toBe(m.modseq + 1n);

    // The old ETag is now stale.
    expect((await request(app).patch(url).set(CSRF).set('cookie', me.cookie).set('if-match', `"${m.modseq.toString()}"`).send({ flags: { remove: ['\\Seen'] } })).status).toBe(412);

    const audit = await db.auditEvent.findMany({ where: { entityId: m.id, action: 'message.flags' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorAccountId).toBe(me.id);
    expect(audit[0]?.after).toMatchObject({ flags: ['\\Seen', '$Important'] });
  });

  it('moves to Archive: a new UID there, gone from INBOX, both MODSEQs bumped, blob untouched, audited', async () => {
    const me = await person();
    await file(me.archive, rfc5322({ subject: 'already archived' }), { subject: 'already archived' });
    const m = await file(me.inbox, rfc5322({ subject: 'archive me' }), { subject: 'archive me', flags: ['\\Seen'] });
    await db.messageSearch.create({ data: { messageId: m.id, accountId: me.id, subject: 'archive me' } });
    await db.messageVerdict.create({ data: { messageId: m.id, bucket: 'people', reasons: ['reply-graph'] } });
    const inboxBefore = await db.mailbox.findUniqueOrThrow({ where: { id: me.inbox } });
    const archiveBefore = await db.mailbox.findUniqueOrThrow({ where: { id: me.archive } });
    const refBefore = (await blobs.stat(m.blobSha256))?.refcount;

    const res = await request(app)
      .patch(`/api/messages/${m.id}`)
      .set(CSRF)
      .set('cookie', me.cookie)
      .set('if-match', `"${m.modseq.toString()}"`)
      .send({ mailboxId: me.archive, flags: { add: ['\\Flagged'] } });
    expect(res.status).toBe(200);
    const moved = MessageDetail.parse(res.body);
    expect(moved.id).not.toBe(m.id);
    expect(moved).toMatchObject({ mailboxId: me.archive, uid: archiveBefore.uidnext, flags: ['\\Seen', '\\Flagged'], bucket: 'people', subject: 'archive me' });
    expect(BigInt(moved.modseq)).toBe(archiveBefore.highestModseq + 1n);

    expect(await db.message.findUnique({ where: { id: m.id } })).toBeNull();
    const inboxAfter = await db.mailbox.findUniqueOrThrow({ where: { id: me.inbox } });
    const archiveAfter = await db.mailbox.findUniqueOrThrow({ where: { id: me.archive } });
    expect(inboxAfter.highestModseq).toBe(inboxBefore.highestModseq + 1n);
    expect(inboxAfter.uidnext).toBe(inboxBefore.uidnext);
    expect(archiveAfter.uidnext).toBe(archiveBefore.uidnext + 1);
    expect(archiveAfter.highestModseq).toBe(archiveBefore.highestModseq + 1n);
    expect((await blobs.stat(m.blobSha256))?.refcount).toBe(refBefore);
    expect(await db.messageSearch.findUnique({ where: { messageId: moved.id } })).not.toBeNull();

    const audit = await db.auditEvent.findMany({ where: { action: 'message.move', actorAccountId: me.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: 'message', entityId: moved.id });
    expect(audit[0]?.before).toMatchObject({ id: m.id, mailboxId: me.inbox, uid: m.uid });
    expect(audit[0]?.after).toMatchObject({ id: moved.id, mailboxId: me.archive, uid: archiveBefore.uidnext });

    const inboxList = MessageList.parse((await request(app).get(`/api/mailboxes/${me.inbox}/messages`).set('cookie', me.cookie)).body);
    expect(inboxList.messages).toEqual([]);
  });

  it('never reaches another account’s mail (404, not 403)', async () => {
    const alice = await person();
    const bob = await person();
    const thread = await db.thread.create({ data: { accountId: alice.id, subject: 'secret', messageCount: 1 } });
    const m = await file(alice.inbox, rfc5322({ subject: 'secret' }), { subject: 'secret', threadId: thread.id });
    const as = (p: Person, url: string) => request(app).get(url).set('cookie', p.cookie);
    for (const url of [`/api/messages/${m.id}`, `/api/messages/${m.id}/body`, `/api/messages/${m.id}/raw`, `/api/messages/${m.id}/attachments/1`, `/api/mailboxes/${alice.inbox}/messages`, `/api/threads/${thread.id}`]) {
      expect((await as(bob, url)).status, url).toBe(404);
    }
    expect((await request(app).patch(`/api/messages/${m.id}`).set(CSRF).set('cookie', bob.cookie).set('if-match', '*').send({ flags: { add: ['\\Seen'] } })).status).toBe(404);
    // Nor into someone else's mailbox.
    expect((await request(app).patch(`/api/messages/${m.id}`).set(CSRF).set('cookie', alice.cookie).set('if-match', '*').send({ mailboxId: bob.inbox })).status).toBe(404);
    expect((await db.message.findUniqueOrThrow({ where: { id: m.id } })).flags).toEqual([]);
    expect(MailboxList.parse((await as(bob, '/api/mailboxes')).body).mailboxes.map((mb) => mb.id)).not.toContain(alice.inbox);
  });

  it('serves a thread oldest first', async () => {
    const me = await person();
    const thread = await db.thread.create({ data: { accountId: me.id, subject: 'plans', messageCount: 2 } });
    const a = await file(me.inbox, rfc5322({ subject: 'plans' }), { subject: 'plans', threadId: thread.id });
    const b = await file(me.archive, rfc5322({ subject: 'Re: plans' }), { subject: 'Re: plans', threadId: thread.id });
    await db.message.update({ where: { id: b.id }, data: { sentAt: new Date('2026-09-25T10:00:00Z') } });
    const res = await request(app).get(`/api/threads/${thread.id}`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    expect(ThreadDetail.parse(res.body).messages.map((x) => x.id)).toEqual([a.id, b.id]);
  });

  it('search validates the query and answers 200 now that @postroom/search is wired (PST-T-3.13)', async () => {
    const me = await person();
    expect((await request(app).get('/api/search?q=hello').set('cookie', me.cookie)).status).toBe(200);
    expect((await request(app).get('/api/search').set('cookie', me.cookie)).status).toBe(400);
  });

  describe('server-sent events (PST-REQ-083)', () => {
    let server: http.Server;
    let port = 0;

    beforeAll(async () => {
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    });

    interface SseEvent {
      event: string;
      data: unknown;
    }

    const open = (cookie: string) =>
      new Promise<{ events: SseEvent[]; status: number; contentType: string; waitFor: (pred: (e: SseEvent) => boolean, ms: number) => Promise<SseEvent>; close: () => void }>(
        (resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie, accept: 'text/event-stream' } }, (res) => {
            const events: SseEvent[] = [];
            const waiters: { pred: (e: SseEvent) => boolean; done: (e: SseEvent) => void }[] = [];
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              buf += chunk;
              let at: number;
              while ((at = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, at);
                buf = buf.slice(at + 2);
                let event = 'message';
                const data: string[] = [];
                for (const line of block.split('\n')) {
                  if (line.startsWith('event: ')) event = line.slice(7);
                  else if (line.startsWith('data: ')) data.push(line.slice(6));
                }
                if (data.length === 0) continue;
                const e = { event, data: JSON.parse(data.join('\n')) as unknown };
                events.push(e);
                for (const w of [...waiters]) {
                  if (w.pred(e)) {
                    waiters.splice(waiters.indexOf(w), 1);
                    w.done(e);
                  }
                }
              }
            });
            resolve({
              events,
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type']),
              waitFor: (pred, ms) => {
                const already = events.find(pred);
                if (already !== undefined) return Promise.resolve(already);
                return new Promise((ok, fail) => {
                  const timer = setTimeout(() => {
                    fail(new Error(`no matching event within ${ms} ms; got ${JSON.stringify(events)}`));
                  }, ms);
                  waiters.push({
                    pred,
                    done: (e) => {
                      clearTimeout(timer);
                      ok(e);
                    },
                  });
                });
              },
              close: () => {
                req.destroy();
              },
            });
          });
          req.on('error', reject);
        },
      );

    it('streams a newly filed message within 2 s, and nothing from another account', async () => {
      const alice = await person();
      const bob = await person();
      const stream = await open(alice.cookie);
      try {
        expect(stream.status).toBe(200);
        expect(stream.contentType).toMatch(/^text\/event-stream/);
        // The connect snapshot: one mailbox.changed per mailbox of hers.
        await stream.waitFor((e) => e.event === 'mailbox.changed' && (e.data as { mailboxId: string }).mailboxId === alice.inbox, 2_000);

        await file(bob.inbox, rfc5322({ subject: 'for bob' }), { subject: 'for bob' });
        const started = Date.now();
        const m = await file(alice.inbox, rfc5322({ subject: 'for alice' }), { subject: 'for alice', from: 'carol@example.org' });
        const got = await stream.waitFor((e) => e.event === 'message.new', 2_000);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(MessageNewEvent.parse(got.data)).toMatchObject({ mailboxId: alice.inbox, messageId: m.id, uid: 1, subject: 'for alice', from: 'carol@example.org' });
        const changed = await stream.waitFor(
          (e) => e.event === 'mailbox.changed' && (e.data as { mailboxId: string; uidnext: number }).mailboxId === alice.inbox && (e.data as { uidnext: number }).uidnext === 2,
          2_000,
        );
        expect(MailboxChangedEvent.parse(changed.data)).toMatchObject({ unseen: 1, total: 1 });

        // A flag change through the API notifies too (other tabs), and counters follow.
        const patched = await request(app).patch(`/api/messages/${m.id}`).set(CSRF).set('cookie', alice.cookie).set('if-match', '*').send({ flags: { add: ['\\Seen'] } });
        expect(patched.status).toBe(200);
        await stream.waitFor((e) => e.event === 'mailbox.changed' && (e.data as { mailboxId: string; unseen: number }).mailboxId === alice.inbox && (e.data as { unseen: number }).unseen === 0, 2_000);

        // Bob's filing went through the same channel before hers; give it every chance to leak.
        await new Promise((r) => setTimeout(r, 300));
        const foreign = [bob.inbox, bob.archive];
        expect(stream.events.filter((e) => foreign.includes((e.data as { mailboxId: string }).mailboxId))).toEqual([]);
        expect(stream.events.filter((e) => e.event === 'message.new')).toHaveLength(1);
      } finally {
        stream.close();
      }
    });

    it('a second message in a second tab arrives in both', async () => {
      const me = await person();
      const [one, two] = await Promise.all([open(me.cookie), open(me.cookie)]);
      try {
        await one.waitFor((e) => e.event === 'mailbox.changed', 2_000);
        await two.waitFor((e) => e.event === 'mailbox.changed', 2_000);
        const m = await file(me.archive, rfc5322({ subject: 'both' }), { subject: 'both' });
        for (const s of [one, two]) {
          const e = await s.waitFor((x) => x.event === 'message.new', 2_000);
          expect((e.data as { messageId: string }).messageId).toBe(m.id);
        }
      } finally {
        one.close();
        two.close();
      }
    });
  });
});
