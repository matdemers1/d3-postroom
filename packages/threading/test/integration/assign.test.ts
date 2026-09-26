// Proves PST-T-3.8's doneWhen against a real PostgreSQL 16: assignThread over messages arriving in
// different orders (parent-first, child-first, a bridging message merging two threads) lands on
// the same thread membership the pure JWZ algorithm would produce for the same set, and concurrent
// assignment of replies to one root produces exactly one thread with the right message count.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assignThread, type AssignThreadInput } from '../../src/index.js';

const baseUrl = process.env['DATABASE_URL'];

async function makeAccount(db: Db, displayName = 'test'): Promise<string> {
  const account = await db.account.create({ data: { displayName } });
  return account.id;
}

async function makeMailbox(db: Db, accountId: string): Promise<string> {
  const mailbox = await db.mailbox.create({ data: { accountId, name: 'INBOX', uidvalidity: 1 } });
  return mailbox.id;
}

let uidCounter = 1;

async function makeMessage(db: Db, mailboxId: string): Promise<string> {
  const sha256 = randomBytes(32).toString('hex');
  await db.blob.create({
    data: { sha256, size: 10, wrappedDek: randomBytes(16), kekId: 'test-kek', aead: 'aes-256-gcm', nonce: randomBytes(12) },
  });
  const message = await db.message.create({
    data: {
      mailboxId,
      uid: uidCounter++,
      modseq: 1n,
      blobSha256: sha256,
      size: 10,
      internalDate: new Date(),
    },
  });
  return message.id;
}

describe.skipIf(!baseUrl)('assignThread (PST-T-3.8)', () => {
  let tdb: TestDatabase;
  let db: Db;
  let accountId: string;
  let mailboxId: string;

  beforeAll(async () => {
    tdb = await createTestDatabase(baseUrl ?? '', 'pst_t38');
    db = tdb.db;
  }, 60_000);

  afterAll(async () => {
    await tdb.drop();
  });

  beforeEach(async () => {
    accountId = await makeAccount(db);
    mailboxId = await makeMailbox(db, accountId);
  });

  async function fileMessage(input: Omit<AssignThreadInput, 'accountId' | 'messageId'>): Promise<{ dbId: string; threadId: string }> {
    const dbId = await makeMessage(db, mailboxId);
    const threadId = await assignThread(db, { accountId, messageId: dbId, ...input });
    return { dbId, threadId };
  }

  it('threads a chain parent-first: reply joins the root thread', async () => {
    const root = await fileMessage({ subject: 'foo', from: 'a@x', to: 'b@x', date: new Date(2026, 0, 1), messageIdHeader: '<root@x>', references: [] });
    const reply = await fileMessage({
      subject: 'Re: foo',
      from: 'b@x',
      to: 'a@x',
      date: new Date(2026, 0, 2),
      messageIdHeader: '<reply@x>',
      inReplyTo: '<root@x>',
      references: ['<root@x>'],
    });

    expect(reply.threadId).toBe(root.threadId);
    const thread = await db.thread.findUniqueOrThrow({ where: { id: root.threadId } });
    expect(thread.messageCount).toBe(2);
  });

  it('threads a chain child-first: the parent arriving later joins the child\'s thread', async () => {
    const child = await fileMessage({
      subject: 'Re: foo',
      from: 'b@x',
      to: 'a@x',
      date: new Date(2026, 0, 2),
      messageIdHeader: '<child@x>',
      inReplyTo: '<root2@x>',
      references: ['<root2@x>'],
    });
    const parent = await fileMessage({
      subject: 'foo',
      from: 'a@x',
      to: 'b@x',
      date: new Date(2026, 0, 1),
      messageIdHeader: '<root2@x>',
      references: [],
    });

    expect(parent.threadId).toBe(child.threadId);
    const thread = await db.thread.findUniqueOrThrow({ where: { id: parent.threadId } });
    expect(thread.messageCount).toBe(2);
    const childRow = await db.message.findUniqueOrThrow({ where: { id: child.dbId } });
    expect(childRow.threadId).toBe(parent.threadId);
  });

  it('a bridging message merges two threads: older thread wins, newer is deleted, counts stay right', async () => {
    const t1msg = await fileMessage({
      subject: 'topic one',
      from: 'a@x',
      to: 'b@x',
      date: new Date(2026, 0, 1),
      messageIdHeader: '<t1@x>',
      references: [],
    });
    const t2msg = await fileMessage({
      subject: 'topic two',
      from: 'c@x',
      to: 'd@x',
      date: new Date(2026, 0, 5),
      messageIdHeader: '<t2@x>',
      references: [],
    });
    expect(t1msg.threadId).not.toBe(t2msg.threadId);

    const bridge = await fileMessage({
      subject: 'Re: topic one',
      from: 'b@x',
      to: 'a@x',
      date: new Date(2026, 0, 10),
      messageIdHeader: '<bridge@x>',
      references: ['<t1@x>', '<t2@x>'],
    });

    // The older thread (t1) wins; t2 is merged into it and deleted.
    expect(bridge.threadId).toBe(t1msg.threadId);
    const t2Still = await db.thread.findUnique({ where: { id: t2msg.threadId } });
    expect(t2Still).toBeNull();

    const merged = await db.thread.findUniqueOrThrow({ where: { id: t1msg.threadId } });
    expect(merged.messageCount).toBe(3);

    const t2MessageRow = await db.message.findUniqueOrThrow({ where: { id: t2msg.dbId } });
    expect(t2MessageRow.threadId).toBe(t1msg.threadId);
  });

  it('falls back to base subject + participants within 14 days only when References/In-Reply-To are absent', async () => {
    const first = await fileMessage({ subject: 'lunch plans', from: 'a@x', to: 'b@x', date: new Date(2026, 0, 1), references: [] });
    const second = await fileMessage({ subject: 'Re: lunch plans', from: 'b@x', to: 'a@x', date: new Date(2026, 0, 5), references: [] });

    expect(second.threadId).toBe(first.threadId);
    const thread = await db.thread.findUniqueOrThrow({ where: { id: first.threadId } });
    expect(thread.messageCount).toBe(2);
  });

  it('does not fall back across 14 days or across unrelated participants', async () => {
    const first = await fileMessage({ subject: 'weekly sync', from: 'a@x', to: 'b@x', date: new Date(2026, 0, 1), references: [] });
    const tooLate = await fileMessage({ subject: 'Re: weekly sync', from: 'b@x', to: 'a@x', date: new Date(2026, 1, 1), references: [] });
    expect(tooLate.threadId).not.toBe(first.threadId);

    const unrelated = await fileMessage({ subject: 'Re: weekly sync', from: 'z@x', to: 'y@x', date: new Date(2026, 0, 2), references: [] });
    expect(unrelated.threadId).not.toBe(first.threadId);
  });

  it('never falls back to subject when References/In-Reply-To are present, even with no match', async () => {
    const unrelatedRoot = await fileMessage({
      subject: 'shared subject',
      from: 'a@x',
      to: 'b@x',
      date: new Date(2026, 0, 1),
      messageIdHeader: '<unrelated-root@x>',
      references: [],
    });
    const withReferences = await fileMessage({
      subject: 'shared subject',
      from: 'a@x',
      to: 'b@x',
      date: new Date(2026, 0, 1, 1),
      references: ['<does-not-exist@x>'],
    });
    expect(withReferences.threadId).not.toBe(unrelatedRoot.threadId);
  });

  it('concurrent assignment of 10 replies to the same root produces one thread with messageCount 11', async () => {
    const root = await fileMessage({
      subject: 'concurrent thread',
      from: 'root@x',
      to: 'everyone@x',
      date: new Date(2026, 0, 1),
      messageIdHeader: '<concurrent-root@x>',
      references: [],
    });

    const replies = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const dbId = await makeMessage(db, mailboxId);
        return assignThread(db, {
          accountId,
          messageId: dbId,
          subject: 'Re: concurrent thread',
          from: `replier${String(i)}@x`,
          to: 'root@x',
          date: new Date(2026, 0, 2 + i),
          messageIdHeader: `<concurrent-reply-${String(i)}-${randomUUID()}@x>`,
          inReplyTo: '<concurrent-root@x>',
          references: ['<concurrent-root@x>'],
        });
      }),
    );

    for (const threadId of replies) expect(threadId).toBe(root.threadId);

    const thread = await db.thread.findUniqueOrThrow({ where: { id: root.threadId } });
    expect(thread.messageCount).toBe(11);
    const memberCount = await db.message.count({ where: { threadId: root.threadId } });
    expect(memberCount).toBe(11);
  }, 30_000);
});
