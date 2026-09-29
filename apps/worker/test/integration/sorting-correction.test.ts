// PST-T-14.9 against a real database: the sorter honours the sender preferences a sorting correction
// records, for NEW mail. A correction writes a sender_pin on the From address, or on "@domain" for
// "Always put github.com in Notifications"; the classify stage reads the address first, then the
// domain, and the stored reasons name which one decided (PST-ADR-007: every decision keeps its why).
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { AddressKind, DEFAULT_MAILBOXES, randomUidValidity, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { createInboundPipeline, INBOUND_QUEUE } from '../../src/pipeline.js';
import { spool, type TestRecipient } from './helpers.js';

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


describe.skipIf(baseUrl === undefined)('sorting corrections steer new mail (PST-T-14.9)', () => {
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

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t149w');
    db = t.db;
    meId = await makeAccount('me');
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t149-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    worker = await startWorker({ db, databaseUrl: t.url, queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs }).handle }, manual: true });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  /** What POST /api/sorting/corrections records (apps/api/src/sorting/store.ts): the pin and its row. */
  const recordCorrection = async (accountId: string, target: string, scope: 'sender' | 'domain', toBucket: string) => {
    await db.senderPin.upsert({ where: { accountId_address: { accountId, address: target } }, create: { accountId, address: target, bucket: toBucket }, update: { bucket: toBucket } });
    await db.sortingCorrection.create({ data: { accountId, scope, target, toBucket, fromBucket: 'updates', reason: `corrected: ${target} → ${toBucket}` } });
  };

  it('a domain preference files a DIFFERENT address at that domain into the chosen bucket, and says so', async () => {
    await recordCorrection(meId, '@github.example', 'domain', 'notifications');
    const from = 'noreply@github.example';
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: from,
      message: message({ from: `GitHub <${from}>`, to: 'me@d3cloud.io', subject: 'Your weekly digest', headers: ['List-Id: <digest.github.example>', 'List-Unsubscribe: <https://github.example/u>'] }),
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ mailbox: { name: 'Notifications' }, verdict: { bucket: 'notifications' } });
    expect(copies[0]?.verdict?.reasons).toContain('pinned: @github.example → notifications');
  });

  it('an address preference beats a domain preference', async () => {
    await recordCorrection(meId, '@shop.example', 'domain', 'newsletters');
    await recordCorrection(meId, 'orders@shop.example', 'sender', 'receipts');
    const from = 'orders@shop.example';
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: from,
      message: message({ from: `Shop <${from}>`, to: 'me@d3cloud.io', subject: 'Big sale this weekend', headers: ['List-Id: <deals.shop.example>'] }),
    });
    expect(copies[0]).toMatchObject({ mailbox: { name: 'Receipts' }, verdict: { bucket: 'receipts' } });
    expect(copies[0]?.verdict?.reasons).toContain(`pinned: ${from} → receipts`);
  });

  it('a correction that moved a sender to Priority brings their next authenticated message to INBOX as Priority', async () => {
    await recordCorrection(meId, 'jonah@elsewhere.example', 'sender', 'priority');
    const from = 'jonah@elsewhere.example';
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: from,
      message: message({ from: `Jonah <${from}>`, to: 'me@d3cloud.io', subject: 'lunch?' }),
    });
    expect(copies[0]).toMatchObject({ flags: ['$Priority'], mailbox: { name: 'INBOX' }, verdict: { bucket: 'priority' } });
    expect(copies[0]?.verdict?.reasons).toContain(`pinned: ${from} → priority`);
  });

  it('once the preference is undone (its pin cleared), new mail is sorted as before', async () => {
    await db.senderPin.deleteMany({ where: { accountId: meId, address: '@github.example' } });
    const from = 'noreply@github.example';
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: from,
      message: message({ from: `GitHub <${from}>`, to: 'me@d3cloud.io', subject: 'Another digest', headers: ['List-Id: <digest.github.example>'] }),
    });
    expect(copies[0]?.verdict?.reasons.some((r) => r.startsWith('pinned:'))).toBe(false);
  });
});
