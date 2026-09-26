// PST-T-2.7 and PST-T-2.11 against a real database and blob store: spooled messages file to the
// right mailboxes with their verdicts; aliases fan out, plus addresses are tagged; quarantine and
// dangerous attachments land in Junk with reasons; and replaying any stage — or the whole job, or
// crashing inside the file stage — never produces a second copy.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { InboundState, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { replay as replayJob, startWorker, type RunningWorker } from '@postroom/queue';
import { mzExecutable, zipWithNestedArchiveAndExecutable } from '../../../../packages/attachments/test/unit/fixtures.js';
import { createInboundPipeline, INBOUND_QUEUE, replayInbound } from '../../src/pipeline.js';
import { readPipeline } from '../../src/stages/state.js';
import { STAGES, type PipelineFaults } from '../../src/stages/types.js';
import { Clock, messageWithAttachment, plainMessage, spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('inbound pipeline (PST-T-2.7, PST-T-2.11)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  const clock = new Clock();
  let operatorId = '';
  let youId = '';
  let otherId = '';
  let worker: RunningWorker;

  const startPipeline = (faults?: PipelineFaults): Promise<RunningWorker> =>
    startWorker({
      db,
      databaseUrl: t.url,
      queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs, now: clock.now, ...(faults === undefined ? {} : { faults }) }).handle },
      manual: true,
      now: clock.now,
    });

  const copiesOf = (inboundMessageId: string) =>
    db.message.findMany({
      where: { inboundMessageId },
      include: { mailbox: { select: { accountId: true, name: true, specialUse: true } }, verdict: true },
      orderBy: { id: 'asc' },
    });

  const refcount = async (sha256: string): Promise<number> => (await db.blob.findUniqueOrThrow({ where: { sha256 } })).refcount;

  const to = {
    matt: (): TestRecipient => ({ rcpt: 'matt@d3cloud.io', address: 'matt@d3cloud.io', accountIds: [operatorId], kind: 'mailbox' }),
    team: (): TestRecipient => ({ rcpt: 'team@d3cloud.io', address: 'team@d3cloud.io', accountIds: [youId, otherId], kind: 'alias' }),
    youGithub: (): TestRecipient => ({ rcpt: 'you+github@d3cloud.io', address: 'you@d3cloud.io', accountIds: [youId], kind: 'plus', tag: 'github' }),
  };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t27');
    db = t.db;
    const seeded = await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    operatorId = seeded.operatorId;
    // Accounts made outside seed(): no mailboxes yet, so filing creates INBOX (race-safely).
    youId = (await db.account.create({ data: { displayName: 'You' } })).id;
    otherId = (await db.account.create({ data: { displayName: 'Other' } })).id;
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t27-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    worker = await startPipeline();
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('files a plain message to the operator INBOX with its verdict and reasons', async () => {
    const { id, sha256 } = await spool(db, blobs, { recipients: [to.matt()], message: plainMessage({ subject: 'Plain one' }) });
    expect(await worker.drain()).toBe(1);

    const copies = await copiesOf(id);
    expect(copies).toHaveLength(1);
    const [copy] = copies;
    expect(copy?.mailbox).toMatchObject({ accountId: operatorId, name: 'INBOX', specialUse: 'inbox' });
    expect(copy).toMatchObject({ subject: 'Plain one', fromAddress: 'alice@example.org', blobSha256: sha256, flags: ['$NewSender', '$People'] });
    expect(copy?.messageIdHeader).toMatch(/@example\.org$/);
    expect(copy?.sentAt?.toISOString()).toBe('2026-09-25T12:00:00.000Z');
    expect(copy?.verdict?.bucket).toBe('people');
    expect(copy?.verdict?.auth).toMatchObject({ spf: { result: 'pass' }, dmarc: { result: 'pass' } });
    expect(copy?.verdict?.reasons).toEqual(
      expect.arrayContaining(['delivered to matt@d3cloud.io', 'no sieve script (Sieve arrives in PST-P-6)', 'filed to INBOX']),
    );
    // The spool row keeps its reference; the copy took its own.
    expect(await refcount(sha256)).toBe(2);

    const inbound = await db.inboundMessage.findUniqueOrThrow({ where: { id } });
    expect(inbound.state).toBe(InboundState.filed);
    expect(inbound.filedAt).not.toBeNull();
    const pipeline = readPipeline(inbound.verdicts);
    expect(Object.keys(pipeline.stages)).toEqual([...STAGES]);
    expect(pipeline.stages.parse?.result).toMatchObject({ references: ['a@example.org', 'b@example.org'], inReplyTo: ['b@example.org'], attachments: [] });
    // smtp-in's verdicts are untouched beside the pipeline record.
    expect(inbound.verdicts).toMatchObject({ spf: { result: 'pass' }, decision: { action: 'accept' } });
  });

  it('team@ reaches two mailboxes: one copy in each member account (PST-REQ-067)', async () => {
    const { id, sha256 } = await spool(db, blobs, { recipients: [to.team()] });
    await worker.drain();
    const copies = await copiesOf(id);
    expect(copies.map((c) => c.mailbox.accountId).sort()).toEqual([youId, otherId].sort());
    for (const c of copies) {
      expect(c.mailbox.name).toBe('INBOX');
      expect(c.verdict?.reasons).toContain('delivered via alias team@d3cloud.io (one copy per member account)');
    }
    expect(await refcount(sha256)).toBe(3);
  });

  it('you+github@ lands in your INBOX tagged github (PST-REQ-066)', async () => {
    const { id } = await spool(db, blobs, { recipients: [to.youGithub()] });
    await worker.drain();
    const copies = await copiesOf(id);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.mailbox).toMatchObject({ accountId: youId, name: 'INBOX' });
    expect(copies[0]?.flags).toEqual(['$People', '$Postroom.tag.github']);
    expect(copies[0]?.verdict?.reasons).toEqual(
      expect.arrayContaining([
        'delivered to you@d3cloud.io via plus address you+github@d3cloud.io',
        'tag "github" from you+github@d3cloud.io: keyword $Postroom.tag.github',
      ]),
    );
  });

  it('an account reached twice (plus address and alias) still gets one copy, with the tag', async () => {
    const { id, sha256 } = await spool(db, blobs, { recipients: [to.youGithub(), to.team()] });
    await worker.drain();
    const copies = await copiesOf(id);
    expect(copies).toHaveLength(2);
    expect(copies.find((c) => c.mailbox.accountId === youId)?.flags).toEqual(['$People', '$Postroom.tag.github']);
    expect(copies.find((c) => c.mailbox.accountId === otherId)?.flags).toEqual(['$People']);
    expect(await refcount(sha256)).toBe(3);
  });

  it('a quarantined disposition files to Junk, and says why', async () => {
    const { id } = await spool(db, blobs, { recipients: [to.matt()], disposition: 'quarantine' });
    await worker.drain();
    const [copy] = await copiesOf(id);
    expect(copy?.mailbox).toMatchObject({ accountId: operatorId, name: 'Junk', specialUse: 'junk' });
    expect(copy?.verdict?.bucket).toBe('junk');
    expect(copy?.verdict?.reasons).toContain('junk: smtp-in quarantined it (DMARC p=quarantine)');
  });

  it('an .exe from a first-time sender goes to Junk with the attachment reasons (PST-REQ-065)', async () => {
    const message = messageWithAttachment({ from: 'stranger@example.net', filename: 'setup.exe', contentType: 'application/octet-stream', data: mzExecutable() });
    const { id } = await spool(db, blobs, { recipients: [to.matt()], message });
    await worker.drain();
    const [copy] = await copiesOf(id);
    expect(copy?.mailbox.name).toBe('Junk');
    expect(copy?.verdict?.bucket).toBe('junk');
    expect(copy?.verdict?.attachments).toEqual([expect.objectContaining({ filename: 'setup.exe', verdict: 'quarantine', kind: 'pe-executable' })]);
    const reasons = copy?.verdict?.reasons ?? [];
    expect(reasons.some((r) => r.startsWith('junk: attachment setup.exe quarantined'))).toBe(true);
    expect(reasons).toContain('attachment policy: sender has no prior history with the recipient');
  });

  it('an archive hiding an executable is opened (deep scan through the blob) and quarantined', async () => {
    const message = messageWithAttachment({ from: 'stranger2@example.net', filename: 'docs.zip', contentType: 'application/zip', data: zipWithNestedArchiveAndExecutable() });
    const { id } = await spool(db, blobs, { recipients: [to.matt()], message });
    await worker.drain();
    const [copy] = await copiesOf(id);
    expect(copy?.mailbox.name).toBe('Junk');
    expect(copy?.verdict?.attachments).toEqual([expect.objectContaining({ filename: 'docs.zip', verdict: 'quarantine' })]);
  });

  it('replaying the job and every stage, twice each, files nothing new and changes nothing (doneWhen)', async () => {
    const { id, sha256, jobId } = await spool(db, blobs, { recipients: [to.youGithub(), to.team(), to.matt()] });
    await worker.drain();

    const snapshot = async () => {
      const copies = await copiesOf(id);
      const inbound = await db.inboundMessage.findUniqueOrThrow({ where: { id } });
      const stages = readPipeline(inbound.verdicts).stages;
      const mailboxes = await db.mailbox.findMany({ where: { id: { in: copies.map((c) => c.mailboxId) } }, select: { id: true, uidnext: true }, orderBy: { id: 'asc' } });
      return {
        copies: copies.map((c) => ({ id: c.id, mailboxId: c.mailboxId, uid: c.uid, modseq: c.modseq, flags: c.flags, verdict: c.verdict })),
        mailboxes,
        refcount: await refcount(sha256),
        state: inbound.state,
        filedAt: inbound.filedAt,
        results: {
          verify: stages.verify?.result,
          parse: stages.parse?.result,
          classify: stages.classify?.result,
          sieve: stages.sieve?.result,
          notify: stages.notify?.result,
        },
        filedCopies: (stages.file?.result as { copies: { messageId: string; mailboxId: string }[] } | undefined)?.copies.map((c) => [c.messageId, c.mailboxId]),
      };
    };
    const before = await snapshot();
    expect(before.copies).toHaveLength(3);
    expect(before.refcount).toBe(4);

    // The done job again: every marker is there, so nothing runs.
    for (let i = 0; i < 2; i++) {
      await replayJob(db, jobId);
      expect(await worker.drain()).toBe(1);
      expect(await snapshot()).toEqual(before);
    }

    // Each stage, twice, through replayInbound (the admin path enqueues the same payload).
    for (const fromStage of STAGES) {
      for (let i = 0; i < 2; i++) {
        await replayInbound(db, id, { fromStage });
        expect(await worker.drain()).toBe(1);
        const after = await snapshot();
        expect(after).toEqual(before);
        const inbound = await db.inboundMessage.findUniqueOrThrow({ where: { id } });
        const pipeline = readPipeline(inbound.verdicts);
        // The replayed stages really ran again: their markers are newer than the replay request.
        const last = pipeline.replays[pipeline.replays.length - 1];
        expect(last?.fromStage).toBe(fromStage);
        expect((pipeline.stages[fromStage]?.at ?? '') >= (last?.at ?? '~')).toBe(true);
        expect(Object.keys(pipeline.stages)).toEqual([...STAGES]);
      }
    }
    const inbound = await db.inboundMessage.findUniqueOrThrow({ where: { id } });
    expect(readPipeline(inbound.verdicts).replays).toHaveLength(STAGES.length * 2);
    expect(await db.job.count({ where: { queue: INBOUND_QUEUE, status: { not: 'done' } } })).toBe(0);
  });

  it('a crash inside the file stage rolls back, retries, and files exactly once', async () => {
    let armed = true;
    const faulty = await startPipeline({
      inFileTransaction: () => {
        if (!armed) return Promise.resolve();
        armed = false;
        return Promise.reject(new Error('injected crash inside the file transaction'));
      },
    });
    try {
      const { id, sha256, jobId } = await spool(db, blobs, { recipients: [to.team()] });
      expect(await faulty.drain()).toBe(1);
      const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe('pending');
      expect(job.lastError).toMatch(/injected crash/);
      expect(await copiesOf(id)).toHaveLength(0);
      expect(await refcount(sha256)).toBe(1);
      const mid = await db.inboundMessage.findUniqueOrThrow({ where: { id } });
      expect(mid.state).toBe(InboundState.processing);
      expect(mid.lastError).toMatch(/injected crash/);
      const stagesBefore = readPipeline(mid.verdicts).stages;
      expect(Object.keys(stagesBefore)).toEqual(['verify', 'parse', 'classify', 'sieve']);

      clock.advance(2 * 3_600_000);
      expect(await faulty.drain()).toBe(1);
      const copies = await copiesOf(id);
      expect(copies).toHaveLength(2);
      expect(await refcount(sha256)).toBe(3);
      const done = await db.inboundMessage.findUniqueOrThrow({ where: { id } });
      expect(done.state).toBe(InboundState.filed);
      expect(done.lastError).toBeNull();
      // Resumed at the file stage: the earlier markers were not rewritten.
      const stagesAfter = readPipeline(done.verdicts).stages;
      expect(stagesAfter.verify).toEqual(stagesBefore.verify);
      expect(stagesAfter.classify).toEqual(stagesBefore.classify);
      expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('done');
    } finally {
      await faulty.stop();
    }
  });

  it('a message that cannot be filed goes failed, visibly, once its attempts are spent', async () => {
    const { id, sha256, jobId } = await spool(db, blobs, { recipients: [to.matt()], maxAttempts: 2 });
    // The blob row disappears (it never should): verify refuses to go on.
    await db.blob.delete({ where: { sha256 } });
    await worker.drain();
    expect((await db.job.findUniqueOrThrow({ where: { id: jobId } })).status).toBe('pending');
    clock.advance(2 * 3_600_000);
    await worker.drain();
    const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe('dead');
    expect(job.lastError).toMatch(/is missing/);
    const inbound = await db.inboundMessage.findUniqueOrThrow({ where: { id } });
    expect(inbound.state).toBe(InboundState.failed);
    expect(inbound.lastError).toMatch(/is missing/);
    expect(await copiesOf(id)).toHaveLength(0);
  });
});
