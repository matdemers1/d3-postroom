// PST-T-5.4 against a real database: a sender pin overrides the classifier entirely, even a Bayes
// model that strongly disagrees (PST-REQ-105); Block routes a sender's future mail to Junk and Allow
// treats them as a known contact (PST-REQ-106); a pin into INBOX still requires authentication,
// exactly like the VIP rule.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { tokenize } from '@postroom/classifier';
import { generateKek } from '@postroom/crypto';
import { AddressKind, DEFAULT_MAILBOXES, randomUidValidity, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { createInboundPipeline, INBOUND_QUEUE } from '../../src/pipeline.js';
import { PASS_VERDICTS, spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

function message(opts: { from: string; to: string; subject: string; headers?: string[]; body?: string }): Buffer {
  return Buffer.from(
    `From: ${opts.from}\r\n` +
      `To: ${opts.to}\r\n` +
      `Subject: ${opts.subject}\r\n` +
      'Date: Fri, 25 Sep 2026 12:00:00 +0000\r\n' +
      `Message-ID: <${randomUUID()}@example.org>\r\n` +
      (opts.headers ?? []).map((h) => `${h}\r\n`).join('') +
      '\r\n' +
      `${opts.body ?? 'hello'}\r\n`,
    'utf8',
  );
}

const DMARC_FAIL = { ...PASS_VERDICTS, dmarc: { ...PASS_VERDICTS.dmarc, result: 'fail' } };

describe.skipIf(baseUrl === undefined)('sender pins and the new-sender screen (PST-T-5.4, PST-REQ-105, PST-REQ-106)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let worker: RunningWorker;
  let meId = '';

  const makeAccount = async (login: string): Promise<string> => {
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io', isPrimary: true } });
    const account = await db.account.create({ data: { displayName: login } });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    for (const m of DEFAULT_MAILBOXES) {
      await db.mailbox.create({ data: { accountId: account.id, name: m.name, specialUse: m.specialUse, uidvalidity: randomUidValidity(randomInt) } });
    }
    return account.id;
  };

  const rcpt = (login: string, accountId: string): TestRecipient => ({ rcpt: `${login}@d3cloud.io`, address: `${login}@d3cloud.io`, accountIds: [accountId], kind: 'mailbox' });

  const copiesOf = (inboundMessageId: string) =>
    db.message.findMany({
      where: { inboundMessageId },
      include: { mailbox: { select: { accountId: true, name: true, specialUse: true } }, verdict: true },
      orderBy: { id: 'asc' },
    });

  const deliver = async (opts: { message: Buffer; recipients: TestRecipient[]; envelopeFrom?: string; verdicts?: Record<string, unknown> }) => {
    const { id } = await spool(db, blobs, opts);
    await worker.drain();
    return { id, copies: await copiesOf(id) };
  };

  /** A trained model that strongly says `winner` for this sender's tokens, across two buckets. */
  const trainBayes = async (accountId: string, tokens: readonly string[], winner: string, other: string) => {
    await db.bayesBucketTotal.createMany({ data: [{ accountId, bucket: winner, docs: 25, tokens: 500 }, { accountId, bucket: other, docs: 10, tokens: 500 }] });
    await db.bayesToken.createMany({ data: [...new Set(tokens)].map((token) => ({ accountId, bucket: winner, token, count: 50 })) });
  };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t54');
    db = t.db;
    meId = await makeAccount('me');
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t54-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    worker = await startWorker({ db, databaseUrl: t.url, queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs }).handle }, manual: true });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('a pin to receipts wins over a Bayes model that strongly says newsletters', async () => {
    const from = 'weekly@news.example.com';
    const msg = message({ from: `The Weekly <${from}>`, to: 'me@d3cloud.io', subject: 'digest', headers: ['List-Id: <weekly.news.example.com>'] });
    const headers = [{ name: 'From', value: `The Weekly <${from}>` }, { name: 'List-Id', value: '<weekly.news.example.com>' }];
    const tokens = tokenize({ headers, from, subject: 'digest' });
    await trainBayes(meId, tokens, 'newsletters', 'receipts');
    await db.senderPin.create({ data: { accountId: meId, address: from, bucket: 'receipts' } });

    const { copies } = await deliver({ recipients: [rcpt('me', meId)], envelopeFrom: from, message: msg });
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ mailbox: { name: 'Receipts' }, verdict: { bucket: 'receipts' } });
    expect(copies[0]?.verdict?.reasons).toContain(`pinned: ${from} → receipts`);
    expect(copies[0]?.verdict?.reasons.some((r) => r.startsWith('bayes:'))).toBe(false);
  });

  it('a Block screen routes this sender\'s next message to Junk', async () => {
    const from = 'pest@spammer.example';
    await db.senderPin.create({ data: { accountId: meId, address: from, screen: 'block' } });
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: from,
      message: message({ from: `Pest <${from}>`, to: 'me@d3cloud.io', subject: 'buy now' }),
    });
    expect(copies[0]).toMatchObject({ flags: [], mailbox: { name: 'Junk', specialUse: 'junk' }, verdict: { bucket: 'junk' } });
    expect(copies[0]?.verdict?.reasons.some((r) => r.includes('blocked'))).toBe(true);
  });

  it('an Allow screen makes a direct first-time human Priority', async () => {
    const from = 'newfriend@example.net';
    await db.senderPin.create({ data: { accountId: meId, address: from, screen: 'allow' } });
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: from,
      message: message({ from: `New Friend <${from}>`, to: 'me@d3cloud.io', subject: 'hi' }),
    });
    expect(copies[0]).toMatchObject({ flags: ['$Priority'], mailbox: { name: 'INBOX' }, verdict: { bucket: 'priority' } });
  });

  it('a DMARC-failing message with a pinned From does not ride the pin into INBOX', async () => {
    const from = 'spoofed@example.org';
    await db.senderPin.create({ data: { accountId: meId, address: from, bucket: 'priority' } });
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: from,
      verdicts: DMARC_FAIL,
      message: message({ from: `Someone <${from}>`, to: 'me@d3cloud.io', subject: 'urgent, click now' }),
    });
    // A first-time human, directly addressed, still lands in INBOX as People — the rule pass, not
    // the pin, decided that; the point is that the *pin* did not put it there as Priority.
    expect(copies[0]?.verdict?.bucket).toBe('people');
    expect(copies[0]?.verdict?.reasons.some((r) => r.includes('pinned') && r.includes('unauthenticated'))).toBe(true);
    expect(copies[0]?.verdict?.reasons.some((r) => r.startsWith('pinned:') && !r.includes('unauthenticated'))).toBe(false);
  });

  it('a first-time human gets $People and the new-sender badge in its scores', async () => {
    const from = 'stranger@example.net';
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: from,
      message: message({ from: `Stranger <${from}>`, to: 'me@d3cloud.io', subject: 'hello there' }),
    });
    expect(copies[0]).toMatchObject({ flags: ['$People'], mailbox: { name: 'INBOX' }, verdict: { bucket: 'people' } });
    expect(copies[0]?.verdict?.scores).toMatchObject({ newSender: 1 });
    expect(copies[0]?.verdict?.reasons.some((r) => r.startsWith('new-sender:'))).toBe(true);
  });

  it('a second message from that same sender is no longer a new sender', async () => {
    const from = 'stranger@example.net';
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: from,
      message: message({ from: `Stranger <${from}>`, to: 'me@d3cloud.io', subject: 'me again' }),
    });
    expect((copies[0]?.verdict?.scores as Record<string, number> | undefined)?.['newSender'] ?? 0).toBe(0);
  });
});
