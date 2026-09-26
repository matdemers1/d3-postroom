// PST-T-3.12: HTML mail renders only on the usercontent origin — sanitised, under a CSP with no
// script-src and `sandbox`, framable only by the mail origin — and remote images reach the sender's
// host only through the proxy, only after the reader asks (PST-REQ-081, PST-REQ-082). Against a real
// database and blob store, with a local listener standing in for the sender's server.
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
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
import { RenderTicket } from '../../src/mail/schemas.js';
import { PROXY_USER_AGENT } from '../../src/usercontent/proxy.js';
import { KEK_BASE64, TestClock, WEB_ORIGIN, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const UC_ORIGIN = 'http://usercontent.test:3399';
const UC_HOST = 'usercontent.test:3399';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 3)]);

function htmlMessage(html: string, inline?: { cid: string; png: Buffer }): Buffer {
  const head = ['From: Sender <sender@example.org>', 'To: someone@d3cloud.io', 'Subject: html', 'Date: Thu, 24 Sep 2026 10:00:00 +0000', `Message-ID: <${String(randomInt(1e9))}@example.org>`, 'MIME-Version: 1.0'];
  const htmlPart = ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', ...(Buffer.from(html).toString('base64').match(/.{1,76}/g) ?? [])];
  const body =
    inline === undefined
      ? htmlPart
      : [
          'Content-Type: multipart/related; boundary="rel"',
          '',
          '--rel',
          ...htmlPart,
          '--rel',
          'Content-Type: image/png',
          `Content-ID: <${inline.cid}>`,
          'Content-Disposition: inline',
          'Content-Transfer-Encoding: base64',
          '',
          inline.png.toString('base64'),
          '--rel--',
        ];
  return Buffer.from(`${[...head, ...body].join('\r\n')}\r\n`);
}

describe.skipIf(!baseUrl)('usercontent origin (PST-T-3.12)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobs: BlobStore;
  let blobRoot: string;
  let sender: http.Server;
  let senderPort = 0;
  const senderHits: http.IncomingMessage[] = [];
  const clock = new TestClock();
  let guardMissesBefore = 0;

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
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

  const file = async (mailboxId: string, raw: Buffer): Promise<string> => {
    const put = await blobs.put(raw);
    const mb = await db.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
    const m = await db.message.create({
      data: { mailboxId, uid: mb.uidnext, modseq: mb.highestModseq + 1n, blobSha256: put.sha256, size: put.size, internalDate: new Date(), flags: [], subject: 'html', fromAddress: 'sender@example.org' },
    });
    await db.mailbox.update({ where: { id: mailboxId }, data: { uidnext: mb.uidnext + 1, highestModseq: mb.highestModseq + 1n } });
    return m.id;
  };

  const ticket = async (cookie: string, id: string, images = false) => {
    const res = await request(app).get(`/api/messages/${id}/render${images ? '?images=1' : ''}`).set('cookie', cookie);
    expect(res.status).toBe(200);
    return RenderTicket.parse(res.body);
  };

  /** GET a usercontent URL through the app, with the usercontent Host. */
  const uc = (url: string) => {
    const u = new URL(url.replaceAll('&amp;', '&'));
    expect(u.origin).toBe(UC_ORIGIN);
    return request(app).get(`${u.pathname}${u.search}`).set('host', UC_HOST);
  };

  const payload = (): string =>
    '<p id="hello">Hello</p><script>fetch("http://127.0.0.1:PORT/script")</script>' +
    '<img src=x onerror="fetch(\'http://127.0.0.1:PORT/onerror\')">' +
    '<svg onload="alert(1)"><circle r=1 /></svg>' +
    '<a href="javascript:alert(1)">js link</a> <a href="https://example.com/">ok link</a>' +
    '<img src="http://127.0.0.1:PORT/pixel.png" alt="remote">' +
    '<div style="background:url(http://127.0.0.1:PORT/bg.png);color:red">css</div>' +
    '<style>@import url(http://127.0.0.1:PORT/x.css); p{color:blue}</style>';

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t312');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t312-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: kekFromBase64(KEK_BASE64) });
    sender = http.createServer((req, res) => {
      senderHits.push(req);
      if (req.url === '/pixel.png') res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      else res.writeHead(404).end();
    });
    sender.listen(0, '127.0.0.1');
    await once(sender, 'listening');
    senderPort = (sender.address() as AddressInfo).port;
    app = createApp({
      db,
      env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot, USERCONTENT_ORIGIN: UC_ORIGIN, IMAGE_PROXY_ALLOW_PRIVATE: '1', POSTROOM_E2E_SEED: '1' },
      config: baseConfig(clock),
    });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    sender.close();
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('mints a ticket only for a signed-in owner, and only when configured', async () => {
    const me = await person();
    const other = await person();
    const id = await file(me.inbox, htmlMessage(payload().replaceAll('PORT', String(senderPort))));
    expect((await request(app).get(`/api/messages/${id}/render`)).status).toBe(401);
    expect((await request(app).get(`/api/messages/${id}/render`).set('cookie', other.cookie)).status).toBe(404);
    expect((await request(app).get(`/api/messages/${id}/render?images=2`).set('cookie', me.cookie)).status).toBe(400);
    const t = await ticket(me.cookie, id);
    expect(t.url.startsWith(`${UC_ORIGIN}/m/`)).toBe(true);
    expect(t).toMatchObject({ images: false, remoteImages: 1 });

    const off = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    const res = await request(off).get(`/api/messages/${id}/render`).set('cookie', me.cookie);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'usercontent_not_configured' });
  });

  it('renders sanitised HTML under the strict CSP, and nothing reaches the sender', async () => {
    const me = await person();
    const id = await file(me.inbox, htmlMessage(payload().replaceAll('PORT', String(senderPort))));
    const before = senderHits.length;
    const res = await uc((await ticket(me.cookie, id)).url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).toMatch(/(^|; )sandbox( |;|$)/);
    expect(csp).not.toContain('allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain(`frame-ancestors ${WEB_ORIGIN}`);
    expect(csp).toContain(`img-src data: cid: ${UC_ORIGIN}`);
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['set-cookie']).toBeUndefined();
    const html = res.text;
    expect(html).toContain('<p id="hello">Hello</p>');
    expect(html).not.toMatch(/<script|on\w+=|javascript:|url\(|<svg|@import/i);
    expect(html).not.toMatch(/[^-]src="https?:\/\/127\.0\.0\.1/);
    expect(html).toContain(`data-src="http://127.0.0.1:${String(senderPort)}/pixel.png"`);
    expect(html).toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer">ok link</a>');
    expect(senderHits.length).toBe(before);
  });

  it('loads remote images only through the proxy, only when asked, only as signed', async () => {
    const me = await person();
    const id = await file(me.inbox, htmlMessage(payload().replaceAll('PORT', String(senderPort))));
    const t = await ticket(me.cookie, id, true);
    expect(t.images).toBe(true);
    const html = (await uc(t.url)).text;
    const src = /<img src="([^"]*\/img\?[^"]*)"/.exec(html)?.[1];
    expect(src).toBeDefined();
    const proxied = (src ?? '').replaceAll('&#61;', '=');
    expect(proxied.startsWith(`${UC_ORIGIN}/img?u=`)).toBe(true);

    const before = senderHits.length;
    const img = await uc(proxied);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.from(img.body as Buffer).equals(PNG)).toBe(true);
    expect(senderHits.length).toBe(before + 1);
    const hit = senderHits.at(-1);
    expect(hit?.headers['user-agent']).toBe(PROXY_USER_AGENT);
    expect(hit?.headers['cookie']).toBeUndefined();
    expect(hit?.headers['referer']).toBeUndefined();

    // Another URL under the same token, a forged signature, or a no-images token: refused.
    const u = new URL(proxied);
    u.searchParams.set('u', `http://127.0.0.1:${String(senderPort)}/other.png`);
    expect((await uc(u.href)).status).toBe(403);
    const plain = await ticket(me.cookie, id, false);
    const noImages = new URL(proxied);
    const tok = plain.url.split('/m/')[1] ?? '';
    noImages.searchParams.set('t', tok);
    expect((await uc(noImages.href)).status).toBe(403);
    expect(senderHits.length).toBe(before + 1);
  });

  it('serves cid: images from the same message only', async () => {
    const me = await person();
    const id = await file(me.inbox, htmlMessage('<p>logo</p><img src="cid:logo@example.org">', { cid: 'logo@example.org', png: PNG }));
    const html = (await uc((await ticket(me.cookie, id)).url)).text;
    const src = /<img src="([^"]*\/cid\/[^"]*)"/.exec(html)?.[1];
    expect(src).toBeDefined();
    const img = await uc(src ?? '');
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.from(img.body as Buffer).equals(PNG)).toBe(true);
    expect((await uc((src ?? '').replace(/cid\/.*$/, 'cid/nothing%40here'))).status).toBe(404);
  });

  it('refuses a tampered, expired or signed-out token', async () => {
    const me = await person();
    const id = await file(me.inbox, htmlMessage('<p>secret</p>'));
    const { url } = await ticket(me.cookie, id);
    expect((await uc(`${url.slice(0, -2)}xx`)).status).toBe(404);
    clock.advance(16 * 60 * 1000);
    expect((await uc(url)).status).toBe(404);
    const fresh = (await ticket(me.cookie, id)).url;
    expect((await uc(fresh)).status).toBe(200);
    expect((await request(app).post('/api/auth/signout').set(CSRF).set('cookie', me.cookie)).status).toBe(200);
    expect((await uc(fresh)).status).toBe(404);
  });

  it('keeps the two origins apart', async () => {
    const me = await person();
    const id = await file(me.inbox, htmlMessage('<p>x</p>'));
    const { url } = await ticket(me.cookie, id);
    // The render is not served on the mail origin…
    const path = new URL(url).pathname;
    const onMail = await request(app).get(path).set('cookie', me.cookie);
    expect(onMail.status).not.toBe(200);
    expect(onMail.text).not.toContain('<p>x</p>');
    // …and the mail app is not served on the usercontent origin, cookie or not.
    for (const p of ['/api/mailboxes', '/api/auth/state', '/health', '/', '/setup']) {
      const res = await request(app).get(p).set('host', UC_HOST).set('cookie', me.cookie);
      expect(res.status, p).toBe(404);
      expect(res.headers['content-type'], p).toMatch(/^text\/plain/);
    }
    // The mail origin may frame the usercontent origin and nothing else.
    const csp = String((await request(app).get('/api/auth/state')).headers['content-security-policy']);
    expect(csp).toContain(`frame-src ${UC_ORIGIN}`);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('logs a CSP report and answers 204', async () => {
    const res = await request(app)
      .post('/csp-report')
      .set('host', UC_HOST)
      .set('content-type', 'application/csp-report')
      .send(JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src' } }));
    expect(res.status).toBe(204);
  });
});
