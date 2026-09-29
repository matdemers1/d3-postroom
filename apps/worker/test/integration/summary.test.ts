// PST-T-14.2: a Message row carries its list summary — the From display name (RFC 2047 decoded)
// and a one-line snippet — written by the file stage at filing time, and filled by the summary
// sweep (the backfill) for rows filed before the columns existed or by a path that left it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { createInboundPipeline, INBOUND_QUEUE } from '../../src/pipeline.js';
import { createSummarySweeper, drainSummaries, sweepUnsummarised } from '../../src/sweep/summary-sweep.js';
import { Clock, spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

function message(opts: { from: string; subject: string; body: string }): Buffer {
  return Buffer.from(
    `From: ${opts.from}\r\n` +
      'To: you@d3cloud.io\r\n' +
      `Subject: ${opts.subject}\r\n` +
      'Date: Sun, 28 Sep 2026 12:00:00 +0000\r\n' +
      `Message-ID: <${opts.subject.replace(/\W+/g, '-')}-${String(Date.now())}-${String(Math.random()).slice(2)}@example.com>\r\n` +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      '\r\n' +
      opts.body.replace(/\n/g, '\r\n') +
      '\r\n',
    'utf8',
  );
}

const QUOTED_BODY = 'Photos from Sunday are up,\nhave a look!\n\nOn Sun, 28 Sep 2026 at 09:00, Mat <mat@d3cloud.io> wrote:\n> Did you get the photos?\n';

describe.skipIf(baseUrl === undefined)('message list summaries (PST-T-14.2)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  const clock = new Clock();
  let youId = '';
  let worker: RunningWorker;
  const deps = (): Parameters<typeof sweepUnsummarised>[0] => ({ db, blobs, log: () => undefined, now: clock.now });

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t142_summary');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    youId = (await db.account.create({ data: { displayName: 'You' } })).id;
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t142-blobs-'));
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

  /** A row filed the way mail was filed before PST-T-14.2: headers denormalised, no summary. */
  async function fileUnsummarised(opts: { from: string; subject: string; body: string }): Promise<string> {
    const blob = await db.$transaction((tx) => blobs.put(message(opts), { tx }));
    const filed = await db.$transaction(async (tx) => {
      const m = await fileLocalMessage(tx, { accountId: youId, mailbox: 'INBOX', blobSha256: blob.sha256, size: blob.size, internalDate: clock.now() });
      await tx.message.update({ where: { id: m.id }, data: { subject: opts.subject, fromAddress: 'x@example.com' } });
      return m;
    });
    return filed.id;
  }

  it('the file stage stores the decoded display name and a snippet without the quoted history', async () => {
    const inbound = await spool(db, blobs, {
      recipients: [you()],
      message: message({ from: '=?UTF-8?Q?Linda_D=C3=A9mers?= <linda.demers@example.com>', subject: 'Photos from Sunday', body: QUOTED_BODY }),
    });
    await worker.drain();
    const row = await db.message.findFirstOrThrow({ where: { inboundMessageId: inbound.id } });
    expect(row.fromName).toBe('Linda Démers');
    expect(row.snippet).toBe('Photos from Sunday are up, have a look!');
  });

  it('files a null name, and still a snippet, when From has no display name', async () => {
    const inbound = await spool(db, blobs, { recipients: [you()], message: message({ from: 'bare@example.com', subject: 'Bare', body: 'Just the address.' }) });
    await worker.drain();
    const row = await db.message.findFirstOrThrow({ where: { inboundMessageId: inbound.id } });
    expect(row.fromName).toBeNull();
    expect(row.snippet).toBe('Just the address.');
  });

  it('the sweep backfills rows filed without a summary, audits the batch, and is idempotent', async () => {
    const a = await fileUnsummarised({ from: '"Demers, Linda" <linda@example.com>', subject: 'Backfill A', body: QUOTED_BODY });
    const b = await fileUnsummarised({ from: 'no-name@example.com', subject: 'Backfill B', body: '' });
    expect(await db.message.count({ where: { id: { in: [a, b] }, snippet: null } })).toBe(2);

    const first = await sweepUnsummarised(deps(), { graceMs: 0 });
    expect(first).toMatchObject({ scanned: 2, summarised: 2, skipped: 0, failed: 0 });
    const rowA = await db.message.findUniqueOrThrow({ where: { id: a } });
    expect(rowA).toMatchObject({ fromName: 'Demers, Linda', snippet: 'Photos from Sunday are up, have a look!' });
    const rowB = await db.message.findUniqueOrThrow({ where: { id: b } });
    // An empty body is summarised as an empty snippet, so the row is never picked up again.
    expect(rowB).toMatchObject({ fromName: null, snippet: '' });

    const audit = await db.auditEvent.findMany({ where: { action: 'message.summary-backfill' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorKind).toBe('system');
    expect((audit[0]?.after as { count: number; messageIds: string[] }).messageIds.sort()).toEqual([a, b].sort());

    const second = await sweepUnsummarised(deps(), { graceMs: 0 });
    expect(second).toMatchObject({ scanned: 0, summarised: 0 });
    expect(await db.auditEvent.count({ where: { action: 'message.summary-backfill' } })).toBe(1);
  });

  it('never overwrites a summary a filing path wrote, and leaves rows inside the grace period', async () => {
    const id = await fileUnsummarised({ from: 'Late <late@example.com>', subject: 'Grace', body: 'Recent.' });
    const held = await sweepUnsummarised(deps(), { graceMs: 3_600_000 });
    expect(held.scanned).toBe(0);
    await db.message.update({ where: { id }, data: { snippet: 'written live', fromName: 'Live' } });
    const after = await sweepUnsummarised(deps(), { graceMs: 0 });
    expect(after.scanned).toBe(0);
    expect(await db.message.findUniqueOrThrow({ where: { id } })).toMatchObject({ snippet: 'written live', fromName: 'Live' });
  });

  it('drains a backlog larger than one batch', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await fileUnsummarised({ from: `Sender ${String(i)} <s${String(i)}@example.com>`, subject: `Batch ${String(i)}`, body: `Body ${String(i)}` }));
    const sweep = createSummarySweeper(deps(), { graceMs: 0, limit: 2 });
    expect(await drainSummaries(sweep, 2)).toBe(5);
    const rows = await db.message.findMany({ where: { id: { in: ids } }, orderBy: { subject: 'asc' } });
    expect(rows.map((r) => [r.fromName, r.snippet])).toEqual([0, 1, 2, 3, 4].map((i) => [`Sender ${String(i)}`, `Body ${String(i)}`]));
  });
});
