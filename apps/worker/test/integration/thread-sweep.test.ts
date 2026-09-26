// PST-T-3.14: a copy left with threadId NULL by a crash between the file stage's commit and its
// post-commit assignThread call is threaded by the next sweep. Simulated directly, the way the
// crash actually leaves the row: fileLocalMessage + the same denorm fields the file stage writes
// inside its transaction (PST-REQ-078), with assignThread never called — no thread, no In-Reply-To
// or References column (those are only ever written by assignThread itself).
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
import { sweepUnthreaded } from '../../src/sweep/thread-sweep.js';
import { createInboundPipeline, INBOUND_QUEUE } from '../../src/pipeline.js';
import { Clock, spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

/** A message with full control over the threading headers, mirroring thread-search.test.ts. */
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

describe.skipIf(baseUrl === undefined)('thread sweep (PST-T-3.14, PST-REQ-078)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  const clock = new Clock();
  let youId = '';
  let worker: RunningWorker;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t314');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    youId = (await db.account.create({ data: { displayName: 'You' } })).id;
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t314-blobs-'));
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

  /**
   * Files a copy exactly the way the file stage's own transaction does (fileLocalMessage plus the
   * same denorm update), then stops — the crash this task is about, simulated at the point it
   * actually happens: after commit, before assignThread ever runs. Returns the crashed row's id.
   */
  async function fileWithoutThreading(opts: { subject: string; from: string; messageId: string; inReplyTo?: string; references?: string[] }): Promise<string> {
    const buffer = threadMessage({
      from: opts.from,
      to: 'you@d3cloud.io',
      subject: opts.subject,
      messageId: opts.messageId,
      body: 'body text',
      ...(opts.inReplyTo === undefined ? {} : { inReplyTo: opts.inReplyTo }),
      ...(opts.references === undefined ? {} : { references: opts.references }),
    });
    const blob = await db.$transaction((tx) => blobs.put(buffer, { tx }));
    const filed = await db.$transaction(async (tx) => {
      const message = await fileLocalMessage(tx, { accountId: youId, mailbox: 'INBOX', blobSha256: blob.sha256, size: blob.size, internalDate: clock.now() });
      await tx.message.update({
        where: { id: message.id },
        data: { messageIdHeader: opts.messageId, subject: opts.subject, fromAddress: opts.from, sentAt: clock.now() },
      });
      return message;
    });
    return filed.id;
  }

  it('threads a crashed copy on the next sweep, joining the thread its References name', async () => {
    const parentMid = `parent-${randomUUID()}@example.org`;
    const parent = await spool(db, blobs, {
      recipients: [you()],
      message: threadMessage({ from: 'alice@example.org', to: 'you@d3cloud.io', subject: 'Trip planning', messageId: parentMid, body: 'lets discuss' }),
    });
    await worker.drain();
    const parentCopy = await db.message.findFirstOrThrow({ where: { inboundMessageId: parent.id } });
    expect(parentCopy.threadId).not.toBeNull();

    const replyMid = `reply-${randomUUID()}@example.org`;
    const crashedId = await fileWithoutThreading({ subject: 'Re: Trip planning', from: 'bob@example.org', messageId: replyMid, inReplyTo: parentMid, references: [parentMid] });
    // Confirm the crash left exactly what a real one would: no thread, no threading headers at all
    // (those are only ever written by assignThread), even though subject/from/messageIdHeader made
    // it into the commit.
    const crashed = await db.message.findUniqueOrThrow({ where: { id: crashedId } });
    expect(crashed).toMatchObject({ threadId: null, inReplyTo: null, references: [], messageIdHeader: replyMid, subject: 'Re: Trip planning' });

    // The reply's blob carries In-Reply-To/References the row itself doesn't — the sweep must
    // re-derive them from the stored message, not from denormalised columns.
    const first = await sweepUnthreaded({ db, blobs, log: () => undefined, now: clock.now }, { graceMs: 0 });
    expect(first).toEqual({ scanned: 1, threaded: 1, skipped: 0 });

    const threaded = await db.message.findUniqueOrThrow({ where: { id: crashedId } });
    expect(threaded.threadId).toBe(parentCopy.threadId);
    expect(threaded.inReplyTo).toBe(parentMid);
    expect(threaded.references).toEqual([parentMid]);

    // Idempotent: running again finds nothing left to do.
    const second = await sweepUnthreaded({ db, blobs, log: () => undefined, now: clock.now }, { graceMs: 0 });
    expect(second).toEqual({ scanned: 0, threaded: 0, skipped: 0 });
    const again = await db.message.findUniqueOrThrow({ where: { id: crashedId } });
    expect(again.threadId).toBe(threaded.threadId);
  });

  it('respects a grace period so a freshly filed row is left for the live path', async () => {
    const mid = `grace-${randomUUID()}@example.org`;
    const id = await fileWithoutThreading({ subject: 'Grace check', from: 'carol@example.org', messageId: mid });

    const result = await sweepUnthreaded({ db, blobs, log: () => undefined, now: clock.now }, { graceMs: 3_600_000 });
    expect(result).toEqual({ scanned: 0, threaded: 0, skipped: 0 });

    // Left unthreaded on purpose (still inside its grace window) — clean it up so it doesn't
    // become a stray candidate for the tests below, which sweep with graceMs: 0.
    await db.message.delete({ where: { id } });
  });

  it('is bounded per run: a limit smaller than the backlog leaves the rest for the next sweep', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await fileWithoutThreading({ subject: `Bounded ${i}`, from: `dave${i}@example.org`, messageId: `bounded-${i}-${randomUUID()}@example.org` }));
    }

    const first = await sweepUnthreaded({ db, blobs, log: () => undefined, now: clock.now }, { graceMs: 0, limit: 2 });
    expect(first).toEqual({ scanned: 2, threaded: 2, skipped: 0 });
    const remaining = await db.message.count({ where: { id: { in: ids }, threadId: null } });
    expect(remaining).toBe(1);

    const second = await sweepUnthreaded({ db, blobs, log: () => undefined, now: clock.now }, { graceMs: 0, limit: 2 });
    expect(second).toEqual({ scanned: 1, threaded: 1, skipped: 0 });
    expect(await db.message.count({ where: { id: { in: ids }, threadId: null } })).toBe(0);
  });
});
