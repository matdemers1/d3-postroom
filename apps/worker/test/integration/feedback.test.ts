// PST-T-11.15 / PST-REQ-176 through the real inbound pipeline: the hand-made RFC 3464 and RFC 5965
// fixtures (packages/dsn/test/fixtures), spooled as smtp-in would, are filed to the user's INBOX
// like any mail (wherever the classifier sorts them) and then read by the feedback stage. A null-sender 5.1.1 DSN about a delivered
// message bounces its recipient and suppresses the address; a 5.2.2 DSN correlated by ENVID
// bounces without suppressing; a forged DSN (a real sender, no MAILER-DAEMON From) or one delivered
// to another account changes nothing; an ARF report is recorded against its message and raises
// exactly one alert, however often the stage is replayed.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlertMessage } from '@postroom/alerts';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { RecipientState, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { createInboundPipeline, INBOUND_QUEUE, replayInbound } from '../../src/pipeline.js';
import { readPipeline } from '../../src/stages/state.js';
import { Clock, plainMessage, spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const fixtures = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'dsn', 'test', 'fixtures');
const DSN_511 = { file: 'dsn-5.1.1-full.eml', mid: '6f1d2c3b-4a5e-4f60-9b7a-8c9d0e1f2a3b@d3cloud.io' };
const DSN_522 = { file: 'dsn-5.2.2-headers-envid.eml', mid: '0a1b2c3d-5e6f-4a70-8b91-a2b3c4d5e6f7@d3cloud.io' };
const ARF = { file: 'arf-abuse.eml', mid: '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7@d3cloud.io' };

/** A fixture with its original's Message-ID swapped for `mid`, so each test has its own original. */
function fixture(f: { file: string; mid: string }, mid: string, edit: (s: string) => string = (s) => s): Buffer {
  return Buffer.from(edit(readFileSync(join(fixtures, f.file), 'latin1').replaceAll(f.mid, mid)), 'latin1');
}

describe.skipIf(baseUrl === undefined)('feedback stage: async DSNs and ARF reports (PST-T-11.15)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  const clock = new Clock();
  let worker: RunningWorker;
  let operatorId = '';
  let otherId = '';
  const alerts: AlertMessage[] = [];

  const toMatt = (): TestRecipient => ({ rcpt: 'matt@d3cloud.io', address: 'matt@d3cloud.io', accountIds: [operatorId], kind: 'mailbox' });
  const toOther = (): TestRecipient => ({ rcpt: 'other@d3cloud.io', address: 'other@d3cloud.io', accountIds: [otherId], kind: 'mailbox' });

  /** Outbound mail the remote accepted (SES said 250): recipients `delivered`. */
  async function sent(addresses: string[], opts: { accountId?: string; envid?: string } = {}): Promise<{ id: string; mid: string; rcpt: Record<string, string> }> {
    const mid = `${randomUUID()}@d3cloud.io`;
    const m = await db.outboundMessage.create({
      data: {
        accountId: opts.accountId ?? operatorId,
        envelopeFrom: 'matt@d3cloud.io',
        headerFrom: 'matt@d3cloud.io',
        messageId: `<${mid}>`,
        blobSha256: 'b'.repeat(64),
        size: 10,
        submittedVia: 'test',
        ...(opts.envid === undefined ? {} : { dsnEnvid: opts.envid }),
        recipients: { create: addresses.map((address) => ({ address, domain: address.split('@')[1] ?? '', state: RecipientState.delivered, deliveredAt: clock.now(), transport: 'ses' })) },
      },
      include: { recipients: true },
    });
    return { id: m.id, mid, rcpt: Object.fromEntries(m.recipients.map((r) => [r.address, r.id])) };
  }

  const stateOf = async (id: string | undefined): Promise<string> => (await db.outboundRecipient.findUniqueOrThrow({ where: { id: id ?? '' } })).state;
  const feedbackMarker = async (inboundId: string): Promise<{ kind: string; reasons: string[]; events: { action: string; duplicate: boolean }[] }> =>
    readPipeline((await db.inboundMessage.findUniqueOrThrow({ where: { id: inboundId } })).verdicts).stages.feedback?.result as never;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1115_worker');
    db = t.db;
    operatorId = (await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' })).operatorId;
    otherId = (await db.account.create({ data: { displayName: 'Other' } })).id;
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t1115-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    const sendAlert = (m: AlertMessage): Promise<{ sent: boolean }> => {
      alerts.push(m);
      return Promise.resolve({ sent: true });
    };
    worker = await startWorker({ db, databaseUrl: t.url, queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs, now: clock.now, sendAlert }).handle }, manual: true, now: clock.now });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('a null-sender 5.1.1 DSN is filed, bounces the delivered recipient and suppresses the address', async () => {
    const out = await sent(['nobody@example.net', 'someone@example.net']);
    const { id } = await spool(db, blobs, { recipients: [toMatt()], envelopeFrom: '', message: fixture(DSN_511, out.mid) });
    expect(await worker.drain()).toBe(1);

    // Filed like any other mail first, wherever the classifier sorts it (never dropped).
    const copies = await db.message.findMany({ where: { inboundMessageId: id }, include: { mailbox: true } });
    expect(copies.map((c) => c.mailbox.accountId)).toEqual([operatorId]);

    expect(await stateOf(out.rcpt['nobody@example.net'])).toBe('bounced');
    expect(await stateOf(out.rcpt['someone@example.net'])).toBe('delivered');
    const rcpt = await db.outboundRecipient.findUniqueOrThrow({ where: { id: out.rcpt['nobody@example.net'] ?? '' }, include: { attemptsLog: true } });
    expect(rcpt).toMatchObject({ lastCode: 550, lastEnhanced: '5.1.1' });
    expect(rcpt.attemptsLog).toEqual([expect.objectContaining({ transport: 'async-dsn', outcome: 'bounced', mxHost: 'mailstore.example.net', remoteEnhanced: '5.1.1' })]);
    expect(await db.suppressedRecipient.findUnique({ where: { address: 'nobody@example.net' } })).toMatchObject({ reason: 'hard-bounce', enhanced: '5.1.1', code: 550, sourceRecipientId: out.rcpt['nobody@example.net'] });
    const marker = await feedbackMarker(id);
    expect(marker).toMatchObject({ kind: 'dsn', events: [expect.objectContaining({ action: 'bounced-suppressed', duplicate: false })] });
    expect(await db.auditEvent.count({ where: { requestId: `inbound:${id}` } })).toBe(2);

    // A replay of the stage records nothing twice.
    await replayInbound(db, id, { fromStage: 'feedback' });
    await worker.drain();
    expect((await feedbackMarker(id)).events).toEqual([expect.objectContaining({ duplicate: true })]);
    expect((await db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'nobody@example.net' } })).bounceCount).toBe(1);
    expect(await db.deliveryFeedback.count({ where: { inboundMessageId: id } })).toBe(1);
  });

  it('a 5.2.2 DSN with RET=HDRS, correlated by ENVID, bounces without suppressing and skips the delayed recipient', async () => {
    const out = await sent(['full@example.com', 'later@example.com'], { envid: 'pst-env-0042' });
    // The ENVID is the correlation here: the returned headers name a Message-ID we never sent.
    const { id } = await spool(db, blobs, { recipients: [toMatt()], envelopeFrom: '', message: fixture(DSN_522, `${randomUUID()}@elsewhere.example`) });
    await worker.drain();
    expect(await stateOf(out.rcpt['full@example.com'])).toBe('bounced');
    expect(await stateOf(out.rcpt['later@example.com'])).toBe('delivered');
    expect(await db.suppressedRecipient.findUnique({ where: { address: 'full@example.com' } })).toBeNull();
    const marker = await feedbackMarker(id);
    expect(marker.events).toEqual([expect.objectContaining({ action: 'bounced' })]);
    expect(marker.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/action delayed is not a failure/)]));
  });

  it('a forged DSN — a real reverse-path and a non-daemon From — is recorded as ignored and changes nothing', async () => {
    const out = await sent(['nobody@example.net']);
    const forged = fixture(DSN_511, out.mid, (s) => s.replace('From: Mail Delivery Subsystem <MAILER-DAEMON@mx.example.net>', 'From: Mallory <mallory@example.org>'));
    const { id } = await spool(db, blobs, { recipients: [toMatt()], envelopeFrom: 'mallory@example.org', message: forged });
    await worker.drain();
    expect(await stateOf(out.rcpt['nobody@example.net'])).toBe('delivered');
    const marker = await feedbackMarker(id);
    expect(marker.events).toEqual([expect.objectContaining({ action: 'ignored' })]);
    const row = await db.deliveryFeedback.findFirstOrThrow({ where: { inboundMessageId: id } });
    expect(JSON.stringify(row.reasons)).toMatch(/a DSN anyone could have sent/);
  });

  it("a DSN delivered to another account never touches the sender account's mail", async () => {
    const out = await sent(['nobody@example.net']);
    const { id } = await spool(db, blobs, { recipients: [toOther()], envelopeFrom: '', message: fixture(DSN_511, out.mid) });
    await worker.drain();
    expect(await stateOf(out.rcpt['nobody@example.net'])).toBe('delivered');
    expect((await feedbackMarker(id)).events).toEqual([expect.objectContaining({ action: 'recorded' })]);
  });

  it('an ARF report is recorded against its message and raises exactly one alert, even when replayed', async () => {
    const out = await sent(['user@example.com']);
    const before = alerts.length;
    const { id } = await spool(db, blobs, { recipients: [toMatt()], envelopeFrom: 'abusedesk@example.com', message: fixture(ARF, out.mid) });
    await worker.drain();
    const row = await db.deliveryFeedback.findFirstOrThrow({ where: { inboundMessageId: id } });
    expect(row).toMatchObject({ kind: 'complaint', source: 'arf', feedbackType: 'abuse', address: 'user@example.com', outboundMessageId: out.id, outboundRecipientId: out.rcpt['user@example.com'] });
    expect(row.alertedAt).not.toBeNull();
    expect(row.detail).toMatchObject({ sourceIp: '192.0.2.1', reportingMta: 'mail.example.com', userAgent: 'SomeGenerator/1.0' });
    expect(alerts.slice(before)).toEqual([expect.objectContaining({ key: `complaint:${row.id}`, subject: expect.stringMatching(/complaint \(abuse\)/) as unknown })]);
    // Nothing about the mail changes on a complaint.
    expect(await stateOf(out.rcpt['user@example.com'])).toBe('delivered');

    await replayInbound(db, id, { fromStage: 'feedback' });
    await worker.drain();
    expect(alerts.length).toBe(before + 1);
    expect(await db.deliveryFeedback.count({ where: { inboundMessageId: id } })).toBe(1);
  });

  it('ordinary mail passes the stage untouched', async () => {
    const { id } = await spool(db, blobs, { recipients: [toMatt()], message: plainMessage() });
    await worker.drain();
    expect(await feedbackMarker(id)).toMatchObject({ kind: 'none', events: [] });
  });
});
