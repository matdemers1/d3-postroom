// Regression for the fleet verifier's finding on PST-T-1.7: two callers racing to create the SAME
// brand-new mailbox must never throw a unique-constraint error, and must serialize onto one row.
import { createHash, randomBytes } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileLocalMessage } from '../../src/file-local-message.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('fileLocalMessage concurrency', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t17dsn');
  }, 120_000);
  afterAll(async () => { await t.drop(); });

  /** A Message row's blob FK must resolve to a real Blob row; content doesn't matter here. */
  async function fakeBlob(): Promise<{ sha256: string; size: number }> {
    const bytes = randomBytes(32);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await t.db.blob.create({
      data: {
        sha256,
        size: bytes.length,
        wrappedDek: randomBytes(48),
        kekId: 'test-kek',
        aead: 'aes-256-gcm-stream-v1',
        nonce: randomBytes(12),
      },
    });
    return { sha256, size: bytes.length };
  }

  it('N concurrent fileLocalMessage calls into a brand-new mailbox all succeed with distinct sequential UIDs and modseq, one mailbox row', async () => {
    const account = await t.db.account.create({ data: { displayName: 'Racer' } });
    const N = 8;
    const blobs = await Promise.all(Array.from({ length: N }, () => fakeBlob()));

    const results = await Promise.all(blobs.map((blob) => t.db.$transaction((tx) => fileLocalMessage(tx, {
      accountId: account.id,
      mailbox: 'INBOX',
      blobSha256: blob.sha256,
      size: blob.size,
      internalDate: new Date(),
    }))));

    const mailboxIds = new Set(results.map((r) => r.mailboxId));
    expect(mailboxIds.size).toBe(1);

    const uids = results.map((r) => r.uid).sort((a, b) => a - b);
    expect(uids).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    const modseqs = results.map((r) => r.modseq).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(modseqs).toEqual(Array.from({ length: N }, (_, i) => BigInt(i + 1)));

    const mailboxRows = await t.db.mailbox.findMany({ where: { accountId: account.id, name: 'INBOX' } });
    expect(mailboxRows).toHaveLength(1);
    const mailbox = mailboxRows[0];
    if (mailbox === undefined) throw new Error('mailbox row missing');
    expect(mailbox.uidnext).toBe(N + 1);
    expect(mailbox.highestModseq).toBe(BigInt(N));

    const messages = await t.db.message.findMany({ where: { mailboxId: mailbox.id } });
    expect(messages).toHaveLength(N);
  });

  it('creating two different brand-new mailboxes for the same account concurrently never collides', async () => {
    const account = await t.db.account.create({ data: { displayName: 'Racer2' } });
    const [inboxBlob, sentBlob] = await Promise.all([fakeBlob(), fakeBlob()]);

    const [inboxMsg, sentMsg] = await Promise.all([
      t.db.$transaction((tx) => fileLocalMessage(tx, { accountId: account.id, mailbox: 'INBOX', blobSha256: inboxBlob.sha256, size: inboxBlob.size, internalDate: new Date() })),
      t.db.$transaction((tx) => fileLocalMessage(tx, { accountId: account.id, mailbox: 'Sent', blobSha256: sentBlob.sha256, size: sentBlob.size, internalDate: new Date() })),
    ]);

    expect(inboxMsg.mailboxId).not.toBe(sentMsg.mailboxId);
    const mailboxes = await t.db.mailbox.findMany({ where: { accountId: account.id } });
    expect(mailboxes.map((m) => m.name).sort()).toEqual(['INBOX', 'Sent']);
  });
});
