// PST-T-5.6: one-click unsubscribe (RFC 8058, PST-REQ-110) and the sender profile (PST-REQ-113),
// against a real database and a real (encrypted) blob store — and a real local HTTP listener
// standing in for the sender's List-Unsubscribe endpoint.
//
// The listener is plain http on loopback, accepted only because the test app runs with
// POSTROOM_E2E_SEED=1 and IMAGE_PROXY_ALLOW_PRIVATE=1 (the same test-only escape the image proxy
// uses): standing up a TLS certificate a Node http client trusts, just for this test, buys nothing
// over exercising the exact same guarded-lookup code path with a plain listener.
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from '../loopback.js';
import { createApp } from '../../src/app.js';
import { SenderProfile, UnsubscribeResult } from '../../src/senders/schemas.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!baseUrl)('one-click unsubscribe and the sender profile (PST-T-5.6)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  const clock = new TestClock();
  let guardMissesBefore = 0;

  // The fake newsletter sender's own HTTP listener: records every POST it receives.
  let listener: http.Server;
  let listenerPort: number;
  const received: { path: string; body: string; contentType: string | undefined }[] = [];

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  interface Person {
    id: string;
    login: string;
    cookie: string;
    inbox: string;
    newsletters: string;
  }

  const person = async (): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    const mk = (name: string, specialUse: SpecialUse | null) =>
      db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    const inbox = await mk('INBOX', SpecialUse.inbox);
    const newsletters = await mk('Newsletters', null);
    return { id, login, cookie: await signIn(login, totpSecret), inbox: inbox.id, newsletters: newsletters.id };
  };

  const file = async (
    mailboxId: string,
    raw: Buffer,
    fields: { subject: string; from: string; dmarc: 'pass' | 'fail' },
  ) => {
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
      await tx.messageVerdict.create({
        data: {
          messageId: created.id,
          bucket: 'newsletters',
          reasons: ['List-Id present'],
          auth: {
            spf: { result: fields.dmarc === 'pass' ? 'pass' : 'fail' },
            dkim: [{ result: fields.dmarc === 'pass' ? 'pass' : 'fail', domain: fields.from.split('@')[1] }],
            dmarc: { result: fields.dmarc },
          },
        },
      });
      return created;
    });
    return message;
  };

  const rfc5322Newsletter = (opts: { subject: string; from: string; unsubscribeUrl: string; oneClick: boolean }): Buffer => {
    const head = [
      `From: ${opts.from}`,
      'To: someone@d3cloud.io',
      `Subject: ${opts.subject}`,
      'Date: Thu, 24 Sep 2026 10:00:00 +0000',
      `Message-ID: <${String(randomInt(1e9))}@example.org>`,
      'MIME-Version: 1.0',
      `List-Unsubscribe: <${opts.unsubscribeUrl}>`,
      ...(opts.oneClick ? ['List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
    ];
    return Buffer.from([...head, 'Content-Type: text/plain; charset=utf-8', '', `Hello from ${opts.subject}.`, ''].join('\r\n'));
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t56');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t56-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: kekFromBase64(KEK_BASE64) });
    app = createApp({
      db,
      env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot, POSTROOM_E2E_SEED: '1', IMAGE_PROXY_ALLOW_PRIVATE: '1' },
      config: baseConfig(clock),
    });
    guardMissesBefore = missingAuditCount.value;

    listener = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: Buffer.concat(chunks).toString('utf8'), contentType: req.headers['content-type'] });
        res.writeHead(202, { 'content-type': 'text/plain' }).end('ok');
      });
    });
    listener.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => listener.once('listening', resolve));
    listenerPort = (listener.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await new Promise<void>((resolve) => listener.close(() => { resolve(); }));
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('needs a session', async () => {
    expect((await request(app).post('/api/messages/00000000-0000-0000-0000-000000000000/unsubscribe').set(CSRF)).status).toBe(401);
  });

  it('one-click unsubscribes a message whose DMARC passed, and records it on the sender', async () => {
    const me = await person();
    const from = `deals@example-${String(randomInt(1e6))}.test`;
    const url = `http://127.0.0.1:${String(listenerPort)}/unsub/${from}`;
    const msg = await file(me.newsletters, rfc5322Newsletter({ subject: 'Big Sale', from, unsubscribeUrl: url, oneClick: true }), { subject: 'Big Sale', from, dmarc: 'pass' });

    const before = received.length;
    const res = await request(app).post(`/api/messages/${msg.id}/unsubscribe`).set('cookie', me.cookie).set(CSRF);
    expect(res.status).toBe(200);
    const body = UnsubscribeResult.parse(res.body);
    expect(body).toMatchObject({ ok: true, offered: true });

    // The listener really received the POST, with the RFC 8058 body.
    expect(received.length).toBe(before + 1);
    const hit = received[received.length - 1];
    expect(hit?.path).toBe(`/unsub/${from}`);
    expect(hit?.body).toBe('List-Unsubscribe=One-Click');
    expect(hit?.contentType).toBe('application/x-www-form-urlencoded');

    // Recorded on the sender profile.
    const profileRes = await request(app).get(`/api/senders/${encodeURIComponent(from)}/profile`).set('cookie', me.cookie);
    expect(profileRes.status).toBe(200);
    const profile = SenderProfile.parse(profileRes.body);
    expect(profile.unsubscribe).toMatchObject({ attempted: true, result: 'sent', method: 'one-click' });
    expect(profile.messageCount).toBe(1);
    expect(profile.buckets).toEqual([{ bucket: 'newsletters', count: 1 }]);
    expect(profile.recentMessages[0]).toMatchObject({ id: msg.id, subject: 'Big Sale' });
    expect(profile.auth.dmarcPassRate).toBe(1);
  });

  it('refuses one-click when DMARC did not pass, and audits the refusal', async () => {
    const me = await person();
    const from = `phish-${String(randomInt(1e6))}@example.test`;
    const url = `http://127.0.0.1:${String(listenerPort)}/unsub2`;
    const msg = await file(me.newsletters, rfc5322Newsletter({ subject: 'Spoofed', from, unsubscribeUrl: url, oneClick: true }), { subject: 'Spoofed', from, dmarc: 'fail' });

    const before = received.length;
    const res = await request(app).post(`/api/messages/${msg.id}/unsubscribe`).set('cookie', me.cookie).set(CSRF);
    expect(res.status).toBe(200);
    const body = UnsubscribeResult.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.offered).toBe(true);
    // Never reached the network: DMARC failed before any HTTP call was attempted.
    expect(received.length).toBe(before);

    const profileRes = await request(app).get(`/api/senders/${encodeURIComponent(from)}/profile`).set('cookie', me.cookie);
    const profile = SenderProfile.parse(profileRes.body);
    expect(profile.unsubscribe).toMatchObject({ attempted: true, result: 'failed' });
  });

  it('answers offered: false for a message without RFC 8058 headers, and renders an empty profile for an unseen sender', async () => {
    const me = await person();
    const from = `plain-${String(randomInt(1e6))}@example.test`;
    const msg = await file(
      me.inbox,
      Buffer.from(['From: someone@example.org', 'To: someone@d3cloud.io', 'Subject: hi', 'Date: Thu, 24 Sep 2026 10:00:00 +0000', 'MIME-Version: 1.0', 'Content-Type: text/plain', '', 'hi', ''].join('\r\n')),
      { subject: 'hi', from, dmarc: 'pass' },
    );
    const res = await request(app).post(`/api/messages/${msg.id}/unsubscribe`).set('cookie', me.cookie).set(CSRF);
    expect(res.status).toBe(200);
    expect(UnsubscribeResult.parse(res.body)).toMatchObject({ offered: false });

    const empty = await request(app).get('/api/senders/never-seen-sender%40example.test/profile').set('cookie', me.cookie);
    expect(empty.status).toBe(200);
    const profile = SenderProfile.parse(empty.body);
    expect(profile).toMatchObject({ messageCount: 0, firstSeenAt: null, lastSeenAt: null, pin: null, screen: null, unsubscribe: { attempted: false } });
  });
});
