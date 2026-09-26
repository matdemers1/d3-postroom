// PST-T-6.1, PST-REQ-114: GET /api/messages/:id/inspect shows every section for a fixture — a
// message that arrived over SMTP (spool row + session), with Received hops carrying TLS, stored
// SPF/DKIM/DMARC/ARC/DNSBL verdicts with their reasons, a bucket decision with scores and a Bayes
// reason, a read-receipt request and a tracking pixel. Against a real database and blob store.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { kekFromBase64 } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { MessageInspect } from '../../src/mail/inspect.js';
import { request } from '../loopback.js';
import { KEK_BASE64, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

const RAW = [
  'Received: from relay.example.net (relay.example.net [203.0.113.5]) by mx.d3cloud.io (Postroom) with ESMTPS id tx-1 for <me@d3cloud.io>; Thu, 24 Sep 2026 10:00:07 +0000',
  'Authentication-Results: mx.d3cloud.io; spf=pass smtp.mailfrom=bounce.example.org; dkim=pass header.d=example.org header.s=s1; dmarc=pass header.from=example.org',
  'Received: from mail-out.example.org (mail-out.example.org [192.0.2.10])',
  '\t(using TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits))',
  '\tby relay.example.net (Postfix) with ESMTPS id 4F1B2C3D; Thu, 24 Sep 2026 10:00:05 +0000',
  'Received: from origin.example.org ([198.51.100.7]) by mail-out.example.org with ESMTP id abc123',
  '\t(version=TLS1.2 cipher=ECDHE-RSA-AES256-GCM-SHA384 bits=256); Thu, 24 Sep 2026 10:00:00 +0000',
  'Return-Path: <news@example.org>',
  'DKIM-Signature: v=1; a=rsa-sha256; d=example.org; s=s1; h=from:subject; bh=AAAA; b=BBBB',
  'From: Example News <news@example.org>',
  'To: me@d3cloud.io',
  'Subject: =?utf-8?q?Weekly_digest?=',
  'Date: Thu, 24 Sep 2026 09:59:58 +0000',
  `Message-ID: <${String(randomInt(1e9))}@example.org>`,
  'Disposition-Notification-To: News <news@example.org>',
  'List-Unsubscribe: <https://example.org/u>',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello</p><img src="https://www.google-analytics.com/collect?v=1&tid=UA-1" width="1" height="1"><a href="https://example.org/a?utm_source=news">read</a>',
  '',
].join('\r\n');

const AUTH = {
  spf: { result: 'pass', domain: 'bounce.example.org', scope: 'mfrom', mechanism: 'ip4:192.0.2.0/24', reasons: ['matched ip4:192.0.2.0/24'] },
  dkim: [{ result: 'pass', domain: 'example.org', selector: 's1', algorithm: 'rsa-sha256', testing: false, reasons: ['signature verified'] }],
  dmarc: {
    result: 'pass',
    disposition: 'none',
    fromDomain: 'example.org',
    policy: 'reject',
    policySource: 'p',
    recordDomain: 'example.org',
    sampled: true,
    reasons: ['SPF pass for bounce.example.org, relaxedly aligned with example.org', 'DKIM pass for d=example.org, relaxedly aligned with example.org'],
  },
  arc: { result: 'none', instances: 0, sealerDomains: [], temporary: false, reasons: ['no ARC sets'] },
  dnsbl: { listed: false, zone: 'zen.spamhaus.org' },
};

describe.skipIf(!baseUrl)('GET /api/messages/:id/inspect (PST-T-6.1, PST-REQ-114)', () => {
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

  /** What smtp-in and the worker's file stage leave behind: session, spool row, message, verdict. */
  const fileInbound = async (mailboxId: string, raw: string, withVerdict = true) => {
    const put = await blobs.put(Buffer.from(raw));
    const session = await db.inboundSession.create({ data: { clientIp: '203.0.113.5', proxied: true, helo: 'relay.example.net', rdns: 'relay.example.net', tls: 'STARTTLS' } });
    const inbound = await db.inboundMessage.create({
      data: {
        id: randomUUID(),
        sessionId: session.id,
        envelopeFrom: 'bounce@bounce.example.org',
        recipients: [],
        blobSha256: put.sha256,
        size: put.size,
        verdicts: { ...AUTH, decision: { action: 'accept', rule: 'dmarc-pass', disposition: 'accept', reasons: ['DMARC pass'] } },
        disposition: 'accept',
        dispositionReason: 'DMARC pass',
        smtpReply: '250 2.0.0 Queued as tx-1',
      },
    });
    const rows = await db.$queryRaw<{ uidnext: number; highest_modseq: bigint }[]>`SELECT uidnext, highest_modseq FROM mailbox WHERE id = ${mailboxId}::uuid`;
    const mb = rows[0];
    if (mb === undefined) throw new Error('no mailbox');
    const message = await db.message.create({
      data: {
        mailboxId,
        uid: mb.uidnext,
        modseq: mb.highest_modseq + 1n,
        blobSha256: put.sha256,
        size: put.size,
        internalDate: new Date(),
        inboundMessageId: inbound.id,
        subject: 'Weekly digest',
        fromAddress: 'news@example.org',
      },
    });
    await db.mailbox.update({ where: { id: mailboxId }, data: { uidnext: mb.uidnext + 1, highestModseq: mb.highest_modseq + 1n } });
    if (withVerdict) {
      await db.messageVerdict.create({
        data: {
          messageId: message.id,
          auth: AUTH,
          attachments: [],
          bucket: 'newsletters',
          reasons: ['bulk: List-Unsubscribe present', 'bayes: newsletters 0.87 (tokens: h:list-unsubscribe, weekly, digest); then receipts 0.10', 'filed to Newsletters'],
          scores: { bulk: 1, human: 0, 'bayes:newsletters': 0.87, 'bayes:receipts': 0.1, 'bayes:trainingDocs': 42, 'bucket:newsletters': 1 },
        },
      });
    }
    return message;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t61');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t61-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: kekFromBase64(KEK_BASE64) });
    app = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('populates every section for the fixture', async () => {
    const me = await person();
    const m = await fileInbound(me.inbox, RAW);
    const res = await request(app).get(`/api/messages/${m.id}/inspect`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const body = MessageInspect.parse(res.body);

    // Authentication, with evidence and DMARC-stated alignment.
    expect(body.auth.source).toBe('verdict');
    expect(body.auth.spf).toMatchObject({ result: 'pass', domain: 'bounce.example.org', alignment: { aligned: true, mode: 'relaxed' } });
    expect(body.auth.dkim[0]).toMatchObject({ result: 'pass', domain: 'example.org', selector: 's1', alignment: { aligned: true, mode: 'relaxed' } });
    expect(body.auth.dmarc).toMatchObject({ result: 'pass', policy: 'reject', fromDomain: 'example.org' });
    expect(body.auth.arc?.reasons).toEqual(['no ARC sets']);
    expect(body.auth.dnsbl).toEqual({ listed: false, zone: 'zen.spamhaus.org', reason: null });
    expect(body.auth.authenticationResults[0]).toContain('dmarc=pass');

    // Received path, oldest first, TLS per hop, delays, ours marked; and our own session.
    expect(body.received.map((h) => h.by)).toEqual(['mail-out.example.org', 'relay.example.net', 'mx.d3cloud.io']);
    expect(body.received.map((h) => h.tls.version)).toEqual(['TLS1.2', 'TLSv1.3', null]);
    expect(body.received.map((h) => h.tls.encrypted)).toEqual([true, true, true]);
    expect(body.received.map((h) => h.delaySeconds)).toEqual([null, 5, 2]);
    expect(body.received[2]?.ours).toBe(true);
    expect(body.receipt).toMatchObject({ clientIp: '203.0.113.5', proxied: true, tls: 'STARTTLS', smtpReply: '250 2.0.0 Queued as tx-1', decision: { rule: 'dmarc-pass' } });

    // Why this bucket, and the spam-score breakdown.
    expect(body.bucket?.bucket).toBe('newsletters');
    expect(body.bucket?.reasons).toContain('filed to Newsletters');
    expect(body.bucket?.scores).toContainEqual({ name: 'bucket:newsletters', value: 1 });
    expect(body.spam.signals).toContainEqual({ name: 'bulk', value: 1 });
    expect(body.spam.bayes?.topTokens).toEqual(['h:list-unsubscribe', 'weekly', 'digest']);
    expect(body.spam.bayes?.trainingDocs).toBe(42);

    // Trackers removed (the usercontent sanitiser's counts for this message).
    expect(body.trackers.html).toBe(true);
    expect(body.trackers.trackersBlocked).toBeGreaterThanOrEqual(1);
    expect(body.trackers.linksCleaned).toBeGreaterThanOrEqual(1);

    // MDN request: shown, never sent.
    expect(body.mdn).toMatchObject({ requested: true, to: ['news@example.org'], returnPathMatches: true, sent: false });

    // Headers, decoded, and the raw source link.
    expect(body.headers.find((h) => h.name === 'Subject')?.value).toBe('Weekly digest');
    expect(body.headers.filter((h) => h.name === 'Received')).toHaveLength(3);
    expect(body.raw).toEqual({ url: `/api/messages/${m.id}/raw`, size: m.size });
    const raw = await request(app).get(body.raw.url).set('cookie', me.cookie);
    expect(raw.status).toBe(200);
  });

  it('falls back to the spool row\'s verdicts when the message has none of its own', async () => {
    const me = await person();
    const m = await fileInbound(me.inbox, RAW, false);
    const res = await request(app).get(`/api/messages/${m.id}/inspect`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    const body = MessageInspect.parse(res.body);
    expect(body.auth.source).toBe('inbound');
    expect(body.auth.spf?.result).toBe('pass');
    expect(body.bucket).toBeNull();
  });

  it('is 404 for someone else\'s message and 401 without a session', async () => {
    const owner = await person();
    const other = await person();
    const m = await fileInbound(owner.inbox, RAW);
    expect((await request(app).get(`/api/messages/${m.id}/inspect`).set('cookie', other.cookie)).status).toBe(404);
    expect((await request(app).get(`/api/messages/${m.id}/inspect`)).status).toBe(401);
    expect((await request(app).get('/api/messages/not-a-uuid/inspect').set('cookie', owner.cookie)).status).toBe(400);
  });
});
