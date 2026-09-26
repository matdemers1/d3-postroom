// PST-T-5.3: the training consumer against a real database, and the model it builds feeding the
// Bayes pass — "reasons show the Bayes contribution" (PST-REQ-103) from counts trained by moves
// (PST-REQ-104). The IMAP side (MOVE / UID MOVE / COPY+EXPUNGE writing the events) is covered by
// apps/imap/test/integration/training.test.ts.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { decideWithBayes, extractSignals, tokenize, type SignalInput, type SortBucket } from '@postroom/classifier';
import { generateKek } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { blobHeaderReader, createTrainingConsumer, loadBayesModel, type TrainingConsumer } from '../../src/training/index.js';

const baseUrl = process.env['DATABASE_URL'];

function newsletter(i: number): Buffer {
  return Buffer.from(
    'From: Shop Weekly <news@mail.shop.example>\r\n' +
      'To: you@d3cloud.io\r\n' +
      `Subject: Weekly digest ${i}\r\n` +
      `Message-ID: <${randomUUID()}@shop.example>\r\n` +
      'List-Unsubscribe: <mailto:unsubscribe@shop.example>\r\n' +
      '\r\n' +
      `Sale this week, item ${i}.\r\n`,
    'utf8',
  );
}

function personal(i: number): Buffer {
  return Buffer.from(
    'From: Jane <jane@example.org>\r\n' +
      'To: you@d3cloud.io\r\n' +
      `Subject: lunch plans ${i}\r\n` +
      `Message-ID: <${randomUUID()}@example.org>\r\n` +
      '\r\n' +
      `See you tomorrow ${i}.\r\n`,
    'utf8',
  );
}

describe.skipIf(baseUrl === undefined)('Bayes training consumer (PST-T-5.3)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let consumer: TrainingConsumer;
  let accountId = '';

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t53w');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    accountId = (await db.account.create({ data: { displayName: 'You' } })).id;
    for (const [name, specialUse] of [['INBOX', SpecialUse.inbox], ['Newsletters', null]] as const) {
      await db.mailbox.create({ data: { accountId, name, specialUse, uidvalidity: randomUidValidity(randomInt) } });
    }
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t53-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    consumer = createTrainingConsumer({ db, readHeaders: blobHeaderReader(blobs), batchSize: 7 });
  }, 120_000);

  afterAll(async () => {
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  async function file(mailbox: string, raw: Buffer): Promise<{ id: string; sha: string }> {
    const put = await blobs.put(raw);
    const filed = await db.$transaction((tx) =>
      fileLocalMessage(tx, { accountId, mailbox, blobSha256: put.sha256, size: put.size, internalDate: new Date(), flags: [] }),
    );
    return { id: filed.id, sha: put.sha256 };
  }

  async function event(messageId: string, blobSha256: string, fromBucket: SortBucket, toBucket: SortBucket): Promise<void> {
    await db.bayesTrainingEvent.create({ data: { accountId, messageId, blobSha256, fromBucket, toBucket, via: 'web' } });
  }

  it('trains from the blob when the event names a row that has since moved on (a webmail move gives a new id)', async () => {
    const m = await file('Newsletters', newsletter(0));
    await event(randomUUID(), m.sha, 'inbox', 'newsletters');
    expect(await consumer.drain()).toBe(1);
    const row = await db.bayesToken.findUnique({ where: { accountId_bucket_token: { accountId, bucket: 'newsletters', token: 'h:list-unsubscribe' } } });
    expect(row?.count).toBe(1);
  });

  it('skips, and stamps, an event whose message is gone and was never trained', async () => {
    await event(randomUUID(), randomBytes(32).toString('hex'), 'inbox', 'newsletters');
    expect(await consumer.drain()).toBe(1);
    const last = await db.bayesTrainingEvent.findFirstOrThrow({ where: { accountId }, orderBy: { id: 'desc' } });
    expect(last.outcome).toBe('skipped: message gone');
    expect(last.processedAt).not.toBeNull();
  });

  it('a trained model puts its contribution in the reasons of an Other decision', async () => {
    // 20 more moves: 11 newsletters out of INBOX, 12 personal messages back into it. Drained in
    // batches of 7, so the batch boundary is crossed.
    for (let i = 1; i <= 11; i++) {
      const m = await file('Newsletters', newsletter(i));
      await event(m.id, m.sha, 'inbox', 'newsletters');
    }
    for (let i = 0; i < 12; i++) {
      const m = await file('INBOX', personal(i));
      await event(m.id, m.sha, 'newsletters', 'inbox');
    }
    expect(await consumer.drain()).toBe(23);
    const totals = await db.bayesBucketTotal.findMany({ where: { accountId }, orderBy: { bucket: 'asc' } });
    expect(totals.map((x) => [x.bucket, x.docs])).toEqual([
      ['inbox', 12],
      ['newsletters', 12],
    ]);

    const input: SignalInput = {
      headers: [
        { name: 'From', value: 'Shop Weekly <news@mail.shop.example>' },
        { name: 'To', value: 'you@d3cloud.io' },
        { name: 'Subject', value: 'Weekly digest 99' },
        { name: 'List-Unsubscribe', value: '<mailto:unsubscribe@shop.example>' },
      ],
      envelopeFrom: 'bounce@mail.shop.example',
      authVerdicts: {},
      account: { addresses: ['you@d3cloud.io'], replyGraph: [], contacts: [], pins: { vip: [] } },
    };
    const tokens = tokenize({ headers: input.headers, bodyText: 'Sale this week.' });
    const model = await loadBayesModel(db, accountId, tokens);
    expect(model?.vocabulary).toBeGreaterThan(0);
    const d = decideWithBayes(extractSignals(input), { model, tokens });
    expect(d.bucket).toBe('other');
    expect(d.refined).toBe('newsletters');
    expect(d.reasons.find((r) => r.startsWith('bayes: '))).toMatch(/^bayes: newsletters \d\.\d\d \(tokens: .+\)/);
    expect(d.scores['bayes:newsletters']).toBeGreaterThan(0.9);
  });

  it('one consumer at a time: a second one finds the lock held and does nothing', async () => {
    const m = await file('INBOX', personal(100));
    await event(m.id, m.sha, 'newsletters', 'inbox');
    let inner: Awaited<ReturnType<TrainingConsumer['runOnce']>> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('postroom-bayes-training', 0))`;
      inner = await createTrainingConsumer({ db }).runOnce();
    });
    expect(inner).toEqual({ processed: 0, busy: true, outcomes: [] });
    expect(await consumer.drain()).toBe(1);
  });
});
