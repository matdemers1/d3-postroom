// PST-T-6.7 (PST-REQ-119): GET /api/messages/:id/outbound — a mailbox message's own OutboundMessage
// id, found by an indexed lookup on (account_id, message_id), not a scan of recent sends. Proven
// against a real database: the account's original send still resolves once 150 later sends exist,
// and the query plan the server actually runs is an index scan.
import { randomInt, randomUUID } from 'node:crypto';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { request } from '../loopback.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!baseUrl)('GET /api/messages/:id/outbound (PST-T-6.7, PST-REQ-119)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
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

  const person = async (): Promise<{ id: string; cookie: string; sentMailboxId: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    const sent = await db.mailbox.create({ data: { accountId: id, name: 'Sent', specialUse: SpecialUse.sent, uidvalidity: randomUidValidity(randomInt) } });
    return { id, cookie: await signIn(login, totpSecret), sentMailboxId: sent.id };
  };

  const fakeBlob = async (): Promise<string> => {
    const sha256 = randomUUID().replace(/-/g, '').padEnd(64, '0');
    await db.blob.create({ data: { sha256, size: 1, wrappedDek: Buffer.alloc(32, 1), kekId: 'test', aead: 'aes-256-gcm', nonce: Buffer.alloc(12, 2) } });
    return sha256;
  };

  /** A mailbox message with a given Message-ID header (stored without brackets, PST-T-3.8's normalizeMsgId). */
  const sentMessage = async (mailboxId: string, messageIdHeader: string, uid: number): Promise<string> => {
    const sha256 = await fakeBlob();
    const message = await db.message.create({
      data: { mailboxId, uid, modseq: BigInt(uid), blobSha256: sha256, size: 1, internalDate: new Date(), messageIdHeader, subject: 'A sent message', fromAddress: 'operator@d3cloud.io' },
    });
    return message.id;
  };

  /** An OutboundMessage row, angle-bracketed messageId the way apps/submission stores it. */
  const outboundRow = async (accountId: string, messageIdHeader: string | null, createdAt: Date): Promise<string> => {
    const row = await db.outboundMessage.create({
      data: {
        accountId,
        envelopeFrom: `${accountId}@d3cloud.io`,
        headerFrom: 'Operator <operator@d3cloud.io>',
        messageId: messageIdHeader === null ? null : `<${messageIdHeader}>`,
        subject: 'A sent message',
        blobSha256: await fakeBlob(),
        size: 1,
        submittedVia: 'smtp',
        createdAt,
      },
    });
    return row.id;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t67');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('needs a session', async () => {
    expect((await request(app).get('/api/messages/00000000-0000-0000-0000-000000000000/outbound')).status).toBe(401);
  });

  it('rejects a malformed id with 400', async () => {
    const me = await person();
    expect((await request(app).get('/api/messages/not-a-uuid/outbound').set('cookie', me.cookie)).status).toBe(400);
  });

  it('answers 404, never 403, for another account’s message', async () => {
    const owner = await person();
    const other = await person();
    const msgId = await sentMessage(owner.sentMailboxId, `${randomUUID()}@d3cloud.io`, 1);
    expect((await request(app).get(`/api/messages/${msgId}/outbound`).set('cookie', other.cookie)).status).toBe(404);
  });

  it('is null for a message with no Message-ID header', async () => {
    const me = await person();
    const sha256 = await fakeBlob();
    const message = await db.message.create({
      data: { mailboxId: me.sentMailboxId, uid: 1, modseq: 1n, blobSha256: sha256, size: 1, internalDate: new Date(), messageIdHeader: null },
    });
    const res = await request(app).get(`/api/messages/${message.id}/outbound`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outboundId: null });
  });

  it('is null when this account has no matching outbound row (a Sent copy filed by another client)', async () => {
    const me = await person();
    const msgId = await sentMessage(me.sentMailboxId, `${randomUUID()}@d3cloud.io`, 1);
    const res = await request(app).get(`/api/messages/${msgId}/outbound`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outboundId: null });
  });

  it('finds the caller’s own outbound row by Message-ID header, and its original send still resolves once 150 later sends exist', async () => {
    const me = await person();
    const header = `${randomUUID()}@d3cloud.io`;
    const msgId = await sentMessage(me.sentMailboxId, header, 1);
    const now = clock.now();
    const outboundId = await outboundRow(me.id, header, now);

    // 150 later, unrelated sends from the same account — the old client-side scan (the account's
    // most recent 100 OutboundMessage rows) would have pushed the original one off the page.
    for (let i = 0; i < 150; i += 1) {
      await outboundRow(me.id, `${randomUUID()}@d3cloud.io`, new Date(now.getTime() + (i + 1) * 1000));
    }

    const res = await request(app).get(`/api/messages/${msgId}/outbound`).set('cookie', me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ outboundId });
  });

  it('the lookup query plans an index scan on (account_id, message_id), not a sequential scan', async () => {
    const me = await person();
    const header = `${randomUUID()}@d3cloud.io`;
    // A realistically busy account: enough OutboundMessage rows that the planner's cost estimate
    // has to choose, and it chooses the (account_id, message_id) index over (account_id, created_at)
    // + a filter — the whole point of PST-T-6.7 over the old client-side scan.
    const now = clock.now();
    for (let i = 0; i < 2000; i += 1) await outboundRow(me.id, `${randomUUID()}@d3cloud.io`, new Date(now.getTime() - i * 1000));
    await outboundRow(me.id, header, new Date(now.getTime() - 2_100_000));
    await db.$executeRaw`ANALYZE outbound_message`;

    const rows = await db.$queryRaw<Record<string, string>[]>`
      EXPLAIN (FORMAT TEXT)
      SELECT id FROM outbound_message WHERE account_id = ${me.id}::uuid AND message_id = ${`<${header}>`} ORDER BY created_at DESC, id DESC LIMIT 1`;
    const plan = rows.map((r) => Object.values(r)[0]).join('\n');
    expect(plan).toMatch(/Index (Scan|Only Scan).*outbound_message_account_id_message_id_idx/);
    expect(plan).not.toMatch(/Seq Scan on outbound_message/);
  }, 30_000);

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
