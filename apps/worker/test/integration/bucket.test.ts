// PST-T-5.1 against a real database and blob store: each accepted message is filed into exactly one
// of INBOX ($Priority / $People), Newsletters, Updates, Receipts, Notifications or Junk
// (PST-REQ-101), per recipient account, and every filed copy's verdict stores its bucket, reasons
// and scores (PST-REQ-103). A replay changes nothing.
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

describe.skipIf(baseUrl === undefined)('bucket filing (PST-T-5.1, PST-REQ-101, PST-REQ-103)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let worker: RunningWorker;
  let meId = '';
  let youId = '';

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

  const deliver = async (opts: { message: Buffer; recipients: TestRecipient[]; disposition?: 'accept' | 'quarantine'; envelopeFrom?: string }) => {
    const { id } = await spool(db, blobs, opts);
    await worker.drain();
    const copies = await copiesOf(id);
    for (const c of copies) {
      // PST-REQ-103: every filed copy's decision stores its reasons and scores.
      expect(c.verdict?.reasons.length ?? 0).toBeGreaterThan(0);
      expect(c.verdict?.scores).toBeTypeOf('object');
    }
    return { id, copies };
  };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t51');
    db = t.db;
    meId = await makeAccount('me');
    youId = await makeAccount('you');
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t51-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    worker = await startWorker({ db, databaseUrl: t.url, queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs }).handle }, manual: true });

    // `me` wrote to bob@example.org earlier (the reply graph, from the outbound queue).
    const sent = await db.outboundMessage.create({
      data: { accountId: meId, envelopeFrom: 'me@d3cloud.io', headerFrom: 'me@d3cloud.io', blobSha256: 'f'.repeat(64), size: 1, submittedVia: 'submission', createdAt: new Date(Date.now() - 60_000) },
    });
    await db.outboundRecipient.create({ data: { outboundMessageId: sent.id, address: 'bob@example.org', domain: 'example.org' } });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('a fixture newsletter (List-Id + List-Unsubscribe) lands in Newsletters with its reasons', async () => {
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      message: message({
        from: 'The Weekly <weekly@news.example.com>',
        to: 'me@d3cloud.io',
        subject: 'This week in widgets',
        headers: ['List-Id: The Weekly <weekly.news.example.com>', 'List-Unsubscribe: <https://news.example.com/u>, <mailto:u@news.example.com>'],
      }),
    });
    expect(copies).toHaveLength(1);
    const [c] = copies;
    expect(c?.mailbox).toMatchObject({ accountId: meId, name: 'Newsletters', specialUse: null });
    expect(c?.flags).toEqual([]);
    expect(c?.verdict?.bucket).toBe('newsletters');
    expect(c?.verdict?.reasons).toEqual(
      expect.arrayContaining([
        'List-Id present ("The Weekly <weekly.news.example.com>") → bulk',
        'bayes: not enough training yet (0 of 20 moves)',
        'newsletters: List-Id/List-Unsubscribe present (mailing list)',
        'filed to Newsletters',
      ]),
    );
    expect(c?.verdict?.scores).toMatchObject({ bulk: 1, 'bucket:newsletters': 1, 'heuristic:newsletters': 1 });
  });

  it('a reply from someone the account wrote to lands in INBOX with $Priority; a first-time human with $People', async () => {
    const reply = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: 'bob@example.org',
      message: message({ from: 'Bob <bob@example.org>', to: 'me@d3cloud.io', subject: 'Re: lunch', headers: ['In-Reply-To: <x@d3cloud.io>'] }),
    });
    expect(reply.copies[0]?.mailbox.name).toBe('INBOX');
    expect(reply.copies[0]?.flags).toEqual(['$Priority']);
    expect(reply.copies[0]?.verdict?.bucket).toBe('priority');
    expect(reply.copies[0]?.verdict?.reasons).toContain('sender in reply graph');

    const stranger = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: 'carol@example.net',
      message: message({ from: 'Carol <carol@example.net>', to: 'me@d3cloud.io', subject: 'hi there' }),
    });
    expect(stranger.copies[0]?.mailbox.name).toBe('INBOX');
    expect(stranger.copies[0]?.flags).toEqual(['$People']);
    expect(stranger.copies[0]?.verdict?.bucket).toBe('people');
  });

  it('each recipient account decides for itself: Bob is Priority for me and People for you', async () => {
    const { copies } = await deliver({
      recipients: [
        { rcpt: 'me@d3cloud.io', address: 'me@d3cloud.io', accountIds: [meId], kind: 'mailbox' },
        { rcpt: 'you@d3cloud.io', address: 'you@d3cloud.io', accountIds: [youId], kind: 'mailbox' },
      ],
      envelopeFrom: 'bob@example.org',
      message: message({ from: 'Bob <bob@example.org>', to: 'me@d3cloud.io, you@d3cloud.io', subject: 'both of you' }),
    });
    const mine = copies.find((c) => c.mailbox.accountId === meId);
    const yours = copies.find((c) => c.mailbox.accountId === youId);
    expect(mine).toMatchObject({ flags: ['$Priority'], mailbox: { name: 'INBOX' }, verdict: { bucket: 'priority' } });
    expect(yours).toMatchObject({ flags: ['$People'], mailbox: { name: 'INBOX' }, verdict: { bucket: 'people' } });
  });

  it('the reply graph also comes from the Sent mailbox', async () => {
    const sentBox = await db.mailbox.findFirstOrThrow({ where: { accountId: youId, specialUse: 'sent' } });
    const blob = await blobs.put(message({ from: 'you@d3cloud.io', to: 'Dave <dave@example.com>', subject: 'ping' }));
    const m = await db.message.create({
      data: { mailboxId: sentBox.id, uid: sentBox.uidnext, modseq: 1n, blobSha256: blob.sha256, size: blob.size, internalDate: new Date(Date.now() - 60_000) },
    });
    await db.messageSearch.create({ data: { messageId: m.id, accountId: youId, toText: 'Dave <dave@example.com>' } });
    const { copies } = await deliver({
      recipients: [rcpt('you', youId)],
      envelopeFrom: 'dave@example.com',
      message: message({ from: 'Dave <dave@example.com>', to: 'you@d3cloud.io', subject: 'pong' }),
    });
    expect(copies[0]).toMatchObject({ flags: ['$Priority'], verdict: { bucket: 'priority' } });
  });

  it('a receipt lands in Receipts', async () => {
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: 'bounce@mail.shop.example',
      message: message({ from: 'Shop <no-reply@shop.example>', to: 'me@d3cloud.io', subject: 'Your receipt from Shop (order 1234)', headers: ['List-Unsubscribe: <mailto:u@shop.example>'] }),
    });
    expect(copies[0]).toMatchObject({ flags: [], mailbox: { name: 'Receipts' }, verdict: { bucket: 'receipts' } });
    expect(copies[0]?.verdict?.reasons).toContain('receipts: subject mentions "receipt"');
  });

  it('a GitHub-style notification lands in Notifications', async () => {
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: 'noreply@github.com',
      message: message({
        from: 'Octo Cat <notifications@github.com>',
        to: 'org/repo <repo@noreply.github.com>',
        subject: 'Re: [org/repo] Fix the thing (#12)',
        headers: ['List-Id: org/repo <repo.org.github.com>', 'List-Unsubscribe: <mailto:unsub@github.com>', 'X-GitHub-Reason: mention', 'X-GitHub-Sender: octocat'],
      }),
    });
    expect(copies[0]).toMatchObject({ mailbox: { name: 'Notifications' }, verdict: { bucket: 'notifications' } });
  });

  it('transactional account mail lands in Updates', async () => {
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      envelopeFrom: 'noreply@bank.example',
      message: message({ from: 'Bank <noreply@bank.example>', to: 'me@d3cloud.io', subject: 'New sign-in to your account' }),
    });
    expect(copies[0]).toMatchObject({ mailbox: { name: 'Updates' }, verdict: { bucket: 'updates' } });
  });

  it('quarantine still goes to Junk, whatever the classifier would say', async () => {
    const { copies } = await deliver({
      recipients: [rcpt('me', meId)],
      disposition: 'quarantine',
      envelopeFrom: 'bob@example.org',
      message: message({ from: 'Bob <bob@example.org>', to: 'me@d3cloud.io', subject: 'Re: lunch' }),
    });
    expect(copies[0]).toMatchObject({ flags: [], mailbox: { name: 'Junk', specialUse: 'junk' }, verdict: { bucket: 'junk' } });
    expect(copies[0]?.verdict?.reasons.some((r) => r.startsWith('junk: smtp-in quarantined it'))).toBe(true);
  });

  it('replaying classify and file changes nothing', async () => {
    const { id, copies } = await deliver({
      recipients: [rcpt('me', meId), rcpt('you', youId)],
      message: message({ from: 'The Weekly <weekly@news.example.com>', to: 'me@d3cloud.io', subject: 'Issue 2', headers: ['List-Id: <weekly.news.example.com>'] }),
    });
    const pipeline = createInboundPipeline({ db, blobs });
    for (const stage of ['classify', 'file'] as const) {
      const r = await pipeline.run(id, { replayFrom: stage });
      expect(r.ran[0]).toBe(stage);
      const again = await copiesOf(id);
      expect(again.map((c) => ({ id: c.id, mailbox: c.mailbox.name, flags: c.flags, verdict: c.verdict }))).toEqual(
        copies.map((c) => ({ id: c.id, mailbox: c.mailbox.name, flags: c.flags, verdict: c.verdict })),
      );
    }
  });
});
