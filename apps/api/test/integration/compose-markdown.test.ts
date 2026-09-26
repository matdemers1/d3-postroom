// PST-T-9.2 (PST-REQ-145/146/174): Markdown sends multipart/alternative with sanitized HTML and the
// Markdown as text/plain; "Request read receipt" adds Disposition-Notification-To; sending an MDN for
// a message that asked for one produces an RFC 8098 multipart/report, only once.
import { randomInt } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { SendResponse } from '../../src/compose/schemas.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!baseUrl)('Markdown compose and MDNs (PST-T-9.2)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  const clock = new TestClock();
  let guardMissesBefore = 0;

  interface Person {
    id: string;
    address: string;
    cookie: string;
    inbox: string;
    sent: string;
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

  const person = async (): Promise<Person> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, displayName: `Person ${login}` });
    const mk = (name: string, specialUse: SpecialUse) => db.mailbox.create({ data: { accountId: id, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    const inbox = await mk('INBOX', SpecialUse.inbox);
    const sent = await mk('Sent', SpecialUse.sent);
    await mk('Drafts', SpecialUse.drafts);
    return { id, address: `${login}@d3cloud.io`, cookie: await signIn(login, totpSecret), inbox: inbox.id, sent: sent.id };
  };

  /** Inbound mail as the worker would file it, optionally asking for a read receipt. */
  const inbound = async (me: Person, opts: { messageId: string; subject: string; requestReceipt: boolean; replyTo?: string }) => {
    const lines = [
      'From: Alice Example <alice@example.org>',
      `To: ${me.address}`,
      `Subject: ${opts.subject}`,
      'Date: Thu, 24 Sep 2026 10:00:00 +0000',
      `Message-ID: <${opts.messageId}>`,
    ];
    if (opts.requestReceipt) lines.push(`Disposition-Notification-To: ${opts.replyTo ?? 'alice@example.org'}`);
    lines.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'Please confirm you read this.', '');
    const raw = Buffer.from(lines.join('\r\n'));
    const put = await blobs.put(raw);
    const filed = await db.$transaction((tx) => fileLocalMessage(tx, { accountId: me.id, mailbox: 'INBOX', blobSha256: put.sha256, size: put.size, internalDate: new Date() }));
    await db.message.update({ where: { id: filed.id }, data: { messageIdHeader: `<${opts.messageId}>`, subject: opts.subject, fromAddress: 'alice@example.org', sentAt: new Date('2026-09-24T10:00:00Z') } });
    return filed;
  };

  const send = (who: Person, body: Record<string, unknown>) => request(app).post('/api/compose/send').set(CSRF).set('cookie', who.cookie).send({ from: who.address, ...body });

  const rawOf = async (messageId: string, who: Person): Promise<Buffer> => {
    const res = await request(app).get(`/api/messages/${messageId}/raw`).set('cookie', who.cookie).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => { cb(null, Buffer.concat(chunks)); });
    });
    expect(res.status).toBe(200);
    return res.body as Buffer;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t92_compose');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t92-blobs-'));
    const kek = kekFromBase64(KEK_BASE64);
    blobs = createBlobStore({ root: blobRoot, db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 120_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('a Markdown send is multipart/alternative: text/plain has the Markdown, text/html the sanitized rendering — no image or link the user did not write', async () => {
    const me = await person();
    const markdown = 'Hi **there** - see [my site](https://example.com/) and `code`.';
    const res = await send(me, {
      to: ['bob@example.org'],
      subject: 'Markdown test',
      text: markdown,
      format: 'markdown',
    });
    expect(res.status).toBe(201);
    const sent = SendResponse.parse(res.body);

    const raw = (await rawOf(sent.sentMessageId, me)).toString('latin1');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    // Both parts present, in order: plain, then html.
    const plainIdx = raw.indexOf('Content-Type: text/plain; charset=utf-8');
    const htmlIdx = raw.indexOf('Content-Type: text/html; charset=utf-8');
    expect(plainIdx).toBeGreaterThan(-1);
    expect(htmlIdx).toBeGreaterThan(plainIdx);

    // The text/plain part carries the Markdown source verbatim.
    expect(raw).toContain('Hi **there**');
    // The text/html part is the sanitized rendering: a real anchor to what was written, nothing else.
    expect(raw).toContain('<strong>there</strong>');
    expect(raw).toContain('<a href="https://example.com/">my site</a>');
    expect(raw).not.toMatch(/<img/i);
    // No tracking pixel, no rewritten link, no third-party origin (PST-REQ-174): the only href in the
    // rendered HTML is exactly the one the user wrote.
    const hrefs = [...raw.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['https://example.com/']);
  });

  it('a plain send stays single-part text/plain, unaffected', async () => {
    const me = await person();
    const res = await send(me, { to: ['bob@example.org'], subject: 'Plain test', text: 'Just text.' });
    expect(res.status).toBe(201);
    const sent = SendResponse.parse(res.body);
    const raw = (await rawOf(sent.sentMessageId, me)).toString('latin1');
    expect(raw).not.toContain('multipart/alternative');
    expect(raw).toContain('Content-Type: text/plain; charset=utf-8');
  });

  it('"Request read receipt" adds Disposition-Notification-To: the sender\'s own address', async () => {
    const me = await person();
    const res = await send(me, { to: ['bob@example.org'], subject: 'Receipt please', text: 'Confirm receipt.', requestReceipt: true });
    expect(res.status).toBe(201);
    const sent = SendResponse.parse(res.body);
    const raw = (await rawOf(sent.sentMessageId, me)).toString('latin1');
    expect(raw).toContain(`Disposition-Notification-To: ${me.address}`);
  });

  it('without requestReceipt, no Disposition-Notification-To header is added', async () => {
    const me = await person();
    const res = await send(me, { to: ['bob@example.org'], subject: 'No receipt', text: 'Nothing to see.' });
    expect(res.status).toBe(201);
    const sent = SendResponse.parse(res.body);
    const raw = (await rawOf(sent.sentMessageId, me)).toString('latin1');
    expect(raw).not.toContain('Disposition-Notification-To');
  });

  it('sends an RFC 8098 MDN for a message that asked for one, exactly once, and marks it $MDNSent', async () => {
    const me = await person();
    const original = await inbound(me, { messageId: 'ask-receipt@example.org', subject: 'Please confirm', requestReceipt: true, replyTo: 'alice@example.org' });

    const first = await request(app).post(`/api/messages/${original.id}/mdn`).set(CSRF).set('cookie', me.cookie);
    expect(first.status).toBe(201);
    const body = first.body as { messageId: string; sentMessageId: string };
    expect(body.sentMessageId).toBeDefined();

    const raw = (await rawOf(body.sentMessageId, me)).toString('latin1');
    expect(raw).toContain('Content-Type: multipart/report;');
    expect(raw).toContain('report-type=disposition-notification');
    expect(raw).toContain('Content-Type: message/disposition-notification');
    expect(raw).toContain('Disposition: manual-action/MDN-sent-manually; displayed');
    expect(raw).toContain('Original-Message-ID: <ask-receipt@example.org>');

    const updated = await db.message.findUniqueOrThrow({ where: { id: original.id } });
    expect(updated.flags).toContain('$MDNSent');

    // Sending it again is refused: at most one MDN per message.
    const second = await request(app).post(`/api/messages/${original.id}/mdn`).set(CSRF).set('cookie', me.cookie);
    expect(second.status).toBe(409);
  });

  it('refuses an MDN for a message that never asked for one', async () => {
    const me = await person();
    const plain = await inbound(me, { messageId: 'plain@example.org', subject: 'Just fyi', requestReceipt: false });
    const res = await request(app).post(`/api/messages/${plain.id}/mdn`).set(CSRF).set('cookie', me.cookie);
    expect(res.status).toBe(409);
  });

  it('one account never sends an MDN for another\'s message', async () => {
    const alice = await person();
    const bob = await person();
    const original = await inbound(alice, { messageId: 'private@example.org', subject: 'For Alice only', requestReceipt: true });
    const res = await request(app).post(`/api/messages/${original.id}/mdn`).set(CSRF).set('cookie', bob.cookie);
    expect(res.status).toBe(404);
  });

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
