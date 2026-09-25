// PST-T-1.7's doneWhen against a real PostgreSQL 16 and a real (encrypted) blob store: a fixture MX
// that always 451s yields exactly one delay DSN at 4h and a failure DSN at 5 days; a 550 yields one
// failure DSN immediately; both land in the sender's INBOX with a parseable RFC 3464 structure.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { generateKek, type Kek } from '@postroom/crypto';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDsnHook } from '../../src/dsn.js';
import { enqueueOutbound, OUTBOUND_QUEUE } from '../../src/enqueue.js';
import { DELAY_DSN_AFTER_MS, MAX_QUEUE_AGE_MS } from '../../src/state.js';
import { FakeTransport, reply, type FakeScript } from '../../src/transports/fake.js';
import { createDeliveryWorker } from '../../src/worker.js';

const baseUrl = process.env['DATABASE_URL'];
const T0 = new Date('2026-09-25T12:00:00Z');
const BODY = 'Subject: hi there\r\nFrom: sender@d3cloud.io\r\nTo: grey@greylist.test\r\n\r\nbody\r\n';

/** A crude but sufficient RFC 3464 sanity check: report-type, three parts, CRLF only. */
function assertParseableDsn(text: string, expectAction: 'delayed' | 'failed'): void {
  expect(text).not.toMatch(/\r(?!\n)/);
  expect(text).not.toMatch(/(?<!\r)\n/);
  expect(text).toContain('Content-Type: multipart/report; report-type=delivery-status;');
  expect(text).toContain('Content-Type: message/delivery-status');
  expect(text).toContain('Content-Type: text/rfc822-headers');
  expect(text).toContain(`Action: ${expectAction}`);
  expect(text).toContain('Reporting-MTA: dns; mx.d3cloud.io');
}

describe.skipIf(baseUrl === undefined)('DSN generation (PST-T-1.7)', () => {
  let t: TestDatabase;
  let kek: Kek;
  let root = '';
  let blobs: BlobStore;
  let clock: Date;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t17');
    kek = generateKek();
  }, 120_000);
  afterAll(async () => { await t.drop(); if (root !== '') await rm(root, { recursive: true, force: true }); });

  beforeEach(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), 'pst-t17-blobs-'));
    blobs = createBlobStore({ root, db: t.db, kek });
  });

  function setup(script: FakeScript, leaseMs = 300_000): { worker: Promise<RunningWorker>; fake: FakeTransport } {
    const fake = new FakeTransport({ script, readMessage: true });
    const delivery = createDeliveryWorker({
      db: t.db,
      transports: { direct: fake },
      openMessage: () => Promise.resolve(Readable.from([Buffer.from(BODY)])),
      onDsn: createDsnHook({ db: t.db, blobstore: blobs, now: () => clock }),
      now: () => clock,
      leaseMs,
      attemptTimeoutMs: leaseMs - 1,
    });
    const worker = startWorker({ db: t.db, databaseUrl: t.url, manual: true, now: () => clock, leaseMs, queues: { [OUTBOUND_QUEUE]: delivery.handle } });
    return { worker, fake };
  }

  async function newSender(): Promise<string> {
    return (await t.db.account.create({ data: { displayName: 'Sender' } })).id;
  }

  async function submit(accountId: string, recipients: string[], envelopeFrom = 'sender@d3cloud.io'): Promise<{ messageId: string; recipientId: string }> {
    // Each test's fixture body is unique (the blob store's rows are content-addressed by sha256,
    // and every test gets its own directory, so a shared root file would collide across tests).
    const body = `X-Test-Account: ${accountId}\r\n${BODY}`;
    const blob = await blobs.put(Buffer.from(body));
    const { message } = await t.db.$transaction((tx) => enqueueOutbound(tx, {
      accountId,
      envelopeFrom,
      headerFrom: envelopeFrom,
      blobSha256: blob.sha256,
      size: body.length,
      submittedVia: 'test',
      recipients: recipients.map((address) => ({ address })),
    }, { now: clock }));
    const recipient = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: message.id } });
    return { messageId: message.id, recipientId: recipient.id };
  }

  async function inboxMessages(accountId: string): Promise<{ id: string; uid: number; modseq: bigint; blobSha256: string }[]> {
    const inbox = await t.db.mailbox.findFirst({ where: { accountId, name: 'INBOX' } });
    if (inbox === null) return [];
    return t.db.message.findMany({ where: { mailboxId: inbox.id }, orderBy: { uid: 'asc' } });
  }

  it('an always-451 MX yields exactly one delay DSN at >=4h (none before) and a failure DSN at 5 days, both parseable in the sender INBOX', async () => {
    clock = new Date(T0);
    const accountId = await newSender();
    const { worker: w, fake } = setup(() => reply.tempfail('greylisted'));
    const worker = await w;
    const { messageId } = await submit(accountId, ['grey@greylist.test']);

    let recipient = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: messageId } });
    for (let i = 0; i < 200; i++) {
      const ran = await worker.drain();
      expect(ran).toBeGreaterThan(0);
      const msgsSoFar = await inboxMessages(accountId);
      // Never more than one delay DSN before the bounce.
      expect(msgsSoFar.length).toBeLessThanOrEqual(2);
      recipient = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: messageId } });
      if (recipient.state === 'bounced') break;
      clock = new Date(recipient.nextAttemptAt.getTime() - 1);
      expect(await worker.drain()).toBe(0);
      clock = new Date(recipient.nextAttemptAt);
    }
    expect(recipient.state).toBe('bounced');
    expect(clock.getTime()).toBe(T0.getTime() + MAX_QUEUE_AGE_MS);
    expect(fake.calls.length).toBeGreaterThan(1);

    const msgs = await inboxMessages(accountId);
    expect(msgs).toHaveLength(2);
    expect(msgs.map((m) => m.uid)).toEqual([1, 2]);
    expect(msgs.map((m) => m.modseq)).toEqual([1n, 2n]);

    const delayBuf = await blobs.getBuffer(msgs[0]?.blobSha256 ?? '');
    assertParseableDsn(delayBuf.toString('binary'), 'delayed');
    expect(delayBuf.toString('binary')).toContain('Will-Retry-Until:');

    const failureBuf = await blobs.getBuffer(msgs[1]?.blobSha256 ?? '');
    assertParseableDsn(failureBuf.toString('binary'), 'failed');
    expect(failureBuf.toString('binary')).toContain('Diagnostic-Code: smtp; 451 4.3.0 greylisted');

    const inbox = await t.db.mailbox.findFirstOrThrow({ where: { accountId, name: 'INBOX' } });
    expect(inbox.uidnext).toBe(3);
    expect(inbox.highestModseq).toBe(2n);

    expect(recipient.delayDsnSentAt).not.toBeNull();
    expect(recipient.failureDsnSentAt).not.toBeNull();

    const auditEvents = await t.db.auditEvent.findMany({ where: { entityType: 'outbound_recipient', entityId: recipient.id }, orderBy: { at: 'asc' } });
    expect(auditEvents.map((e) => e.action)).toEqual(['dsn.delay', 'dsn.failure']);
    expect(auditEvents.every((e) => e.actorKind === 'system')).toBe(true);

    await worker.stop();
  });

  it('a delay is filed only at or after the 4h mark, never before', async () => {
    clock = new Date(T0);
    const accountId = await newSender();
    const { worker: w } = setup(() => reply.tempfail());
    const worker = await w;
    const { messageId } = await submit(accountId, ['stilltrying@greylist.test']);

    // Drain repeatedly while advancing the clock to just before 4h: never a DSN yet.
    for (let i = 0; i < 50; i++) {
      const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: messageId } });
      if (r.state === 'bounced' || clock.getTime() - T0.getTime() >= DELAY_DSN_AFTER_MS) break;
      await worker.drain();
      const msgs = await inboxMessages(accountId);
      expect(msgs).toHaveLength(0);
      const after = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: messageId } });
      clock = new Date(Math.min(after.nextAttemptAt.getTime(), T0.getTime() + DELAY_DSN_AFTER_MS - 1));
    }
    // This test stops before the recipient reaches a terminal state; leave nothing runnable behind.
    await t.db.job.deleteMany({ where: { idempotencyKey: { startsWith: `outbound:${messageId}:` } } });
    await t.db.outboundRecipient.updateMany({ where: { outboundMessageId: messageId }, data: { state: 'cancelled' } });
    await worker.stop();
  });

  it('a 550 yields one failure DSN immediately, with the 550 text in Diagnostic-Code', async () => {
    clock = new Date(T0);
    const accountId = await newSender();
    const { worker: w } = setup(() => reply.reject('No such user'));
    const worker = await w;
    const { messageId } = await submit(accountId, ['gone@bounce.test']);
    expect(await worker.drain()).toBe(1);

    const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: messageId } });
    expect(r.state).toBe('bounced');
    expect(r.failureDsnSentAt).not.toBeNull();
    expect(r.delayDsnSentAt).toBeNull();

    const msgs = await inboxMessages(accountId);
    expect(msgs).toHaveLength(1);
    const buf = await blobs.getBuffer(msgs[0]?.blobSha256 ?? '');
    const text = buf.toString('binary');
    assertParseableDsn(text, 'failed');
    expect(text).toContain('Diagnostic-Code: smtp; 550 5.1.1 No such user');

    await worker.stop();
  });

  it('never generates a DSN for a bounce whose envelope sender was the null sender', async () => {
    clock = new Date(T0);
    const accountId = await newSender();
    const { worker: w } = setup(() => reply.reject());
    const worker = await w;
    const { messageId } = await submit(accountId, ['gone@nullsender.test'], '');
    expect(await worker.drain()).toBe(1);

    const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: messageId } });
    expect(r.state).toBe('bounced');
    // The hook resolves without filing anything (there is no sender to send to), and the worker
    // marks the intent handled anyway — a null-sender bounce must never be retried by sweep().
    expect(r.failureDsnSentAt).not.toBeNull();

    const msgs = await inboxMessages(accountId);
    expect(msgs).toHaveLength(0);

    await worker.stop();
  });

  it('is idempotent per (recipient, kind): calling the hook again for an already-sent DSN files nothing new', async () => {
    clock = new Date(T0);
    const accountId = await newSender();
    const { worker: w } = setup(() => reply.reject());
    const worker = await w;
    const { messageId, recipientId } = await submit(accountId, ['twice@bounce.test']);
    expect(await worker.drain()).toBe(1);
    const before = await inboxMessages(accountId);
    expect(before).toHaveLength(1);

    const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: messageId } });
    expect(r.id).toBe(recipientId);
    const hook = createDsnHook({ db: t.db, blobstore: blobs, now: () => clock });
    await hook({
      kind: 'failure',
      recipientId: r.id,
      outboundMessageId: r.outboundMessageId,
      address: r.address,
      code: 550,
      enhanced: '5.1.1',
      text: 'No such user',
      queuedAt: r.createdAt,
      at: clock,
    });

    const after = await inboxMessages(accountId);
    expect(after).toHaveLength(1);
    await worker.stop();
  });
});
