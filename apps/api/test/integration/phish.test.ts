// PST-T-6.5, PST-REQ-120: GET /api/messages/:id surfaces phishing/lookalike warnings, each with a
// stated reason, computed on read from the stored auth verdicts, the message's headers/HTML and
// the account's own correspondence history — against a real database and a real blob store.
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
import { MessageDetail } from '../../src/mail/schemas.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

function rfc5322(opts: { subject: string; from: string; html?: string }): Buffer {
  const head = [`From: ${opts.from}`, 'To: someone@d3cloud.io', `Subject: ${opts.subject}`, 'Date: Thu, 24 Sep 2026 10:00:00 +0000', `Message-ID: <${randomInt(1e9)}@example.org>`, 'MIME-Version: 1.0'];
  if (opts.html === undefined) {
    return Buffer.from([...head, 'Content-Type: text/plain; charset=utf-8', '', `Hello from ${opts.subject}.`, ''].join('\r\n'));
  }
  return Buffer.from([...head, 'Content-Type: text/html; charset=utf-8', '', opts.html, ''].join('\r\n'));
}

describe.skipIf(!baseUrl)('phishing/lookalike warnings (PST-T-6.5, PST-REQ-120)', () => {
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

  const person = async (): Promise<{ id: string; cookie: string; inbox: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    const inbox = await db.mailbox.create({ data: { accountId: id, name: 'INBOX', specialUse: SpecialUse.inbox, uidvalidity: randomUidValidity(randomInt) } });
    return { id, cookie: await signIn(login, totpSecret), inbox: inbox.id };
  };

  /** What the worker's file stage does: store the blob, take the next uid/modseq, write the verdict. */
  const file = async (
    mailboxId: string,
    raw: Buffer,
    fields: { subject: string; from: string; auth?: unknown },
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
          fromAddress: fields.from.replace(/^.*<([^>]+)>\s*$/, '$1'),
          sentAt: new Date('2026-09-24T10:00:00Z'),
        },
      });
      await tx.mailbox.update({ where: { id: mailboxId }, data: { uidnext: mb.uidnext + 1, highestModseq: modseq } });
      if (fields.auth !== undefined) {
        await tx.messageVerdict.create({ data: { messageId: created.id, auth: fields.auth as never, bucket: 'people', reasons: ['test fixture'] } });
      }
      return created;
    });
    return message;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t65');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t65-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: kekFromBase64(KEK_BASE64) });
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('states the reason for a DMARC failure against a reject policy', async () => {
    const me = await person();
    const raw = rfc5322({ subject: 'Your account', from: 'Billing <billing@evil-domain.example>' });
    const m = await file(me.inbox, raw, {
      subject: 'Your account',
      from: 'Billing <billing@evil-domain.example>',
      auth: { spf: { result: 'fail' }, dkim: [], dmarc: { result: 'fail', policy: 'reject' }, arc: { result: 'none' } },
    });

    const res = await request(app).get(`/api/messages/${m.id}`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    const body = MessageDetail.parse(res.body);
    expect(body.phish).not.toBeNull();
    const authWarning = body.phish?.warnings.find((w) => w.kind === 'auth-failure');
    expect(authWarning).toBeDefined();
    expect(authWarning?.reason).toContain('DMARC failed');
    const spfWarning = body.phish?.warnings.find((w) => w.kind === 'auth-failure' && w.reason.includes('SPF'));
    expect(spfWarning).toBeDefined();
  });

  it('states the reason for a first-time sender naming a known brand', async () => {
    const me = await person();
    const raw = rfc5322({ subject: 'Payment received', from: 'PayPal Security <security@not-paypal.example>' });
    const m = await file(me.inbox, raw, {
      subject: 'Payment received',
      from: 'PayPal Security <security@not-paypal.example>',
      auth: { spf: { result: 'pass' }, dkim: [{ result: 'pass' }], dmarc: { result: 'pass', policy: 'reject' }, arc: { result: 'none' } },
    });

    const res = await request(app).get(`/api/messages/${m.id}`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    const body = MessageDetail.parse(res.body);
    const w = body.phish?.warnings.find((x) => x.kind === 'first-time-brand-sender');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('paypal');
    expect(w?.reason).toContain('not-paypal.example');
  });

  it('states the reason for a link that goes somewhere other than its text', async () => {
    const me = await person();
    const raw = rfc5322({
      subject: 'Verify your account',
      from: 'notice@example.com',
      html: '<p><a href="https://evil-domain.example/steal">https://example.com/verify</a></p>',
    });
    const m = await file(me.inbox, raw, {
      subject: 'Verify your account',
      from: 'notice@example.com',
      auth: { spf: { result: 'pass' }, dkim: [{ result: 'pass' }], dmarc: { result: 'pass', policy: 'reject' }, arc: { result: 'none' } },
    });

    const res = await request(app).get(`/api/messages/${m.id}`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    const body = MessageDetail.parse(res.body);
    const w = body.phish?.warnings.find((x) => x.kind === 'link-mismatch');
    expect(w).toBeDefined();
    expect(w?.reason).toContain('example.com');
    expect(w?.reason).toContain('evil-domain.example');
  });

  it('is null for a message with no stored verdict', async () => {
    const me = await person();
    const raw = rfc5322({ subject: 'plain', from: 'sender@example.org' });
    const m = await file(me.inbox, raw, { subject: 'plain', from: 'sender@example.org' });

    const res = await request(app).get(`/api/messages/${m.id}`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    const body = MessageDetail.parse(res.body);
    expect(body.phish).toBeNull();
  });

  it('produces no warnings for an authenticated, known, on-brand sender', async () => {
    const me = await person();
    const first = await file(me.inbox, rfc5322({ subject: 'Welcome', from: 'news@example.com' }), {
      subject: 'Welcome',
      from: 'news@example.com',
      auth: { spf: { result: 'pass' }, dkim: [{ result: 'pass' }], dmarc: { result: 'pass', policy: 'reject' }, arc: { result: 'none' } },
    });
    expect(first.id).toBeTruthy();

    const raw = rfc5322({ subject: 'Your weekly digest', from: 'Example News <news@example.com>', html: '<p><a href="https://example.com/digest">Read more</a></p>' });
    const m = await file(me.inbox, raw, {
      subject: 'Your weekly digest',
      from: 'Example News <news@example.com>',
      auth: { spf: { result: 'pass' }, dkim: [{ result: 'pass' }], dmarc: { result: 'pass', policy: 'reject' }, arc: { result: 'none' } },
    });

    const res = await request(app).get(`/api/messages/${m.id}`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    const body = MessageDetail.parse(res.body);
    expect(body.phish?.warnings).toEqual([]);
  });
});
