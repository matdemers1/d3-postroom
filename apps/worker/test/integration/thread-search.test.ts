// PST-T-3.13: the file stage threads and indexes what it files (PST-REQ-078, PST-REQ-080), and a
// replay of the stage changes nothing (PST-REQ-061). A reply joins its parent's thread by
// Message-ID/References/In-Reply-To across mailboxes — including a Sent copy filed directly,
// standing in for the composer's own filing until PST-T-3.11 lands.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { parseQuery, searchMessages } from '@postroom/search';
import { assignThread } from '@postroom/threading';
import { createInboundPipeline, INBOUND_QUEUE, replayInbound } from '../../src/pipeline.js';
import { readPipeline } from '../../src/stages/state.js';
import { Clock, spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

/** A message with full control over the threading headers, for building a parent/reply pair. */
function threadMessage(opts: { from: string; to: string; subject: string; messageId: string; inReplyTo?: string; references?: string[]; body: string }): Buffer {
  const refs = opts.references === undefined || opts.references.length === 0 ? '' : `References: ${opts.references.map((r) => `<${r}>`).join(' ')}\r\n`;
  const irt = opts.inReplyTo === undefined ? '' : `In-Reply-To: <${opts.inReplyTo}>\r\n`;
  return Buffer.from(
    `From: ${opts.from}\r\n` +
      `To: ${opts.to}\r\n` +
      `Subject: ${opts.subject}\r\n` +
      'Date: Fri, 25 Sep 2026 12:00:00 +0000\r\n' +
      `Message-ID: <${opts.messageId}>\r\n` +
      refs +
      irt +
      '\r\n' +
      `${opts.body}\r\n`,
    'utf8',
  );
}

describe.skipIf(baseUrl === undefined)('file stage: threading and search indexing (PST-T-3.13)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  const clock = new Clock();
  let youId = '';
  let worker: RunningWorker;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t313');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    youId = (await db.account.create({ data: { displayName: 'You' } })).id;
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t313-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    worker = await startWorker({
      db,
      databaseUrl: t.url,
      queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs, now: clock.now }).handle },
      manual: true,
      now: clock.now,
    });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  const you = (): TestRecipient => ({ rcpt: 'you@d3cloud.io', address: 'you@d3cloud.io', accountIds: [youId], kind: 'mailbox' });

  const copyOf = (inboundMessageId: string) =>
    db.message.findFirstOrThrow({
      where: { inboundMessageId, mailbox: { accountId: youId } },
      include: { mailbox: { select: { id: true, name: true } } },
    });

  it('a reply joins its parent thread by References/In-Reply-To, across mailboxes, and both are searchable by a body word', async () => {
    const parentMid = `parent-${randomUUID()}@example.org`;
    const parent = await spool(db, blobs, {
      recipients: [you()],
      message: threadMessage({ from: 'alice@example.org', to: 'you@d3cloud.io', subject: 'Trip planning', messageId: parentMid, body: 'let us discuss the itinerary' }),
    });
    await worker.drain();
    const parentCopy = await copyOf(parent.id);
    expect(parentCopy.threadId).not.toBeNull();

    const replyMid = `reply-${randomUUID()}@example.org`;
    const reply = await spool(db, blobs, {
      recipients: [you()],
      envelopeFrom: 'bob@example.org',
      message: threadMessage({
        from: 'bob@example.org',
        to: 'you@d3cloud.io',
        subject: 'Re: Trip planning',
        messageId: replyMid,
        inReplyTo: parentMid,
        references: [parentMid],
        body: 'the giraffe safari sounds great',
      }),
    });
    await worker.drain();
    const replyCopy = await copyOf(reply.id);
    expect(replyCopy.threadId).toBe(parentCopy.threadId);

    // A body-only word is found by the generated tsvector (PST-REQ-080).
    const { ast } = parseQuery('giraffe');
    const rows = await searchMessages(db, ast, { accountId: youId });
    expect(rows.map((r) => r.messageId)).toContain(replyCopy.id);
    expect(rows.find((r) => r.messageId === replyCopy.id)?.snippet.toLowerCase()).toContain('giraffe');

    // Subject and from words are indexed too.
    const bySubject = await searchMessages(db, parseQuery('itinerary').ast, { accountId: youId });
    expect(bySubject.map((r) => r.messageId)).toContain(parentCopy.id);

    // A second reply, filed straight into Sent (standing in for the composer's own copy — the
    // filing step this app performs today, per the T-3.13 investigation, does not put a copy in
    // Sent, so PST-T-3.11 owns that; this exercises "across INBOX and Sent" directly), joins the
    // same thread too.
    const sentMid = `sent-reply-${randomUUID()}@example.org`;
    const sentBuffer = threadMessage({
      from: 'you@d3cloud.io',
      to: 'alice@example.org',
      subject: 'Re: Trip planning',
      messageId: sentMid,
      inReplyTo: parentMid,
      references: [parentMid],
      body: 'sending the confirmed dates now',
    });
    const sentBlob = await db.$transaction((tx) => blobs.put(sentBuffer, { tx }));
    const filed = await db.$transaction((tx) =>
      fileLocalMessage(tx, { accountId: youId, mailbox: 'Sent', blobSha256: sentBlob.sha256, size: sentBlob.size, internalDate: clock.now() }),
    );
    const sentThreadId = await assignThread(db, {
      accountId: youId,
      messageId: filed.id,
      messageIdHeader: sentMid,
      inReplyTo: parentMid,
      references: [parentMid],
      subject: 'Re: Trip planning',
      from: 'you@d3cloud.io',
      to: 'alice@example.org',
      date: clock.now(),
    });
    expect(sentThreadId).toBe(parentCopy.threadId);
    const sentRow = await db.message.findUniqueOrThrow({ where: { id: filed.id }, include: { mailbox: { select: { name: true } } } });
    expect(sentRow.mailbox.name).toBe('Sent');
    expect(sentRow.threadId).toBe(parentCopy.threadId);
  });

  it('replaying the file stage twice files nothing new and leaves the thread and search row unchanged (doneWhen)', async () => {
    const parentMid = `replay-parent-${randomUUID()}@example.org`;
    await spool(db, blobs, {
      recipients: [you()],
      message: threadMessage({ from: 'carol@example.org', to: 'you@d3cloud.io', subject: 'Replay check', messageId: parentMid, body: 'a lone kangaroo appears here' }),
    });
    await worker.drain();

    const replyMid = `replay-reply-${randomUUID()}@example.org`;
    const reply = await spool(db, blobs, {
      recipients: [you()],
      envelopeFrom: 'dave@example.org',
      message: threadMessage({
        from: 'dave@example.org',
        to: 'you@d3cloud.io',
        subject: 'Re: Replay check',
        messageId: replyMid,
        inReplyTo: parentMid,
        references: [parentMid],
        body: 'another kangaroo joins the reply',
      }),
    });
    await worker.drain();

    const snapshot = async () => {
      const copy = await copyOf(reply.id);
      const search = await db.messageSearch.findUniqueOrThrow({ where: { messageId: copy.id } });
      const threadCount = await db.thread.count({ where: { accountId: youId } });
      const inbound = await db.inboundMessage.findUniqueOrThrow({ where: { id: reply.id } });
      const fileResult = readPipeline(inbound.verdicts).stages.file?.result as { copies: { messageId: string; mailboxId: string }[] } | undefined;
      return {
        threadId: copy.threadId,
        modseq: copy.modseq,
        search: { subject: search.subject, fromText: search.fromText, bodyText: search.bodyText, hasAttachment: search.hasAttachment },
        threadCount,
        // "created" flips to false on a replay (the copy is found, not made again); everything the
        // copy actually files to is unchanged, which is what doneWhen asks for.
        filedCopies: fileResult?.copies.map((c) => [c.messageId, c.mailboxId]),
      };
    };
    const before = await snapshot();
    expect(before.threadId).not.toBeNull();

    for (let i = 0; i < 2; i++) {
      await replayInbound(db, reply.id, { fromStage: 'file' });
      expect(await worker.drain()).toBe(1);
      expect(await snapshot()).toEqual(before);
    }
  });
});
