// PST-T-11.10 / PST-REQ-176, PST-REQ-181: the delivery worker, run for real against the fake
// transport, adds a 5.1.x hard bounce to the suppression list in the outcome transaction — with the
// remote reply, the source recipient, a count and first/last time, and a system audit row — and
// never a 5.7.x refusal, a 4xx, or an expiry bounce.
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { enqueueOutbound, OUTBOUND_QUEUE } from '../../src/enqueue.js';
import { MAX_QUEUE_AGE_MS } from '../../src/state.js';
import { findSuppressed } from '../../src/suppression.js';
import { FakeTransport, reply, type FakeScript } from '../../src/transports/fake.js';
import { createDeliveryWorker } from '../../src/worker.js';

const baseUrl = process.env['DATABASE_URL'];
const T0 = new Date('2026-09-27T12:00:00Z');
const BODY = 'Subject: hi\r\n\r\nbody\r\n';

/** Scripted per local part: the replies a real MX gives. */
const script: FakeScript = (r) => {
  const local = r.address.slice(0, r.address.lastIndexOf('@')).toLowerCase();
  if (local.startsWith('nosuch')) return reply.reject('No such user');
  if (local.startsWith('policy')) return { kind: 'permanent', code: 550, enhanced: '5.7.1', text: 'Rejected by policy' };
  if (local.startsWith('temp')) return { kind: 'temporary', code: 450, enhanced: '4.1.1', text: 'Mailbox temporarily unavailable' };
  return reply.ok();
};

describe.skipIf(baseUrl === undefined)('suppression list: the delivery worker (PST-REQ-176)', () => {
  let t: TestDatabase;
  let accountId: string;
  let clock: Date;
  let worker: RunningWorker;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1110_delivery');
    accountId = (await t.db.account.create({ data: { displayName: 'Sender' } })).id;
    clock = new Date(T0);
    const delivery = createDeliveryWorker({
      db: t.db,
      transports: { direct: new FakeTransport({ script }) },
      openMessage: () => Promise.resolve(Readable.from([Buffer.from(BODY)])),
      onDsn: () => Promise.resolve(),
      now: () => clock,
    });
    worker = await startWorker({ db: t.db, databaseUrl: t.url, manual: true, now: () => clock, queues: { [OUTBOUND_QUEUE]: delivery.handle } });
  }, 120_000);
  afterAll(async () => {
    await worker.stop();
    await t.drop();
  });

  async function submit(recipients: string[]): Promise<string> {
    const { message } = await t.db.$transaction((tx) =>
      enqueueOutbound(tx, { accountId, envelopeFrom: 'me@d3cloud.io', headerFrom: 'me@d3cloud.io', blobSha256: 'a'.repeat(64), size: BODY.length, submittedVia: 'test', recipients: recipients.map((address) => ({ address })) }, { now: clock }),
    );
    return message.id;
  }

  it('a 550 5.1.1 suppresses the address with the reply; 5.7.1, 4xx and delivered do not', async () => {
    const id = await submit(['NoSuch@Bounce.test', 'policy@bounce.test', 'temp@bounce.test', 'fine@bounce.test']);
    await worker.drain();

    const states = await t.db.outboundRecipient.findMany({ where: { outboundMessageId: id } });
    expect(Object.fromEntries(states.map((r) => [r.address, r.state]))).toEqual({
      'NoSuch@bounce.test': 'bounced',
      'fine@bounce.test': 'delivered',
      'policy@bounce.test': 'bounced',
      'temp@bounce.test': 'deferred',
    });

    const rows = await t.db.suppressedRecipient.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const source = states.find((r) => r.address === 'NoSuch@bounce.test');
    expect(row).toMatchObject({
      address: 'nosuch@bounce.test',
      reason: 'hard-bounce',
      code: 550,
      enhanced: '5.1.1',
      text: 'No such user',
      sourceRecipientId: source?.id,
      bounceCount: 1,
    });
    expect(row?.firstAt).toEqual(clock);
    expect(row?.lastAt).toEqual(clock);

    // PST-REQ-181: audited, naming the address, the actor (the delivery daemon) and the reason.
    const audit = await t.db.auditEvent.findMany({ where: { action: 'suppression.add' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorKind: 'system', entityType: 'suppressed_recipient', entityId: row?.id });
    expect(audit[0]?.after).toMatchObject({ address: 'nosuch@bounce.test', reason: 'hard-bounce', enhanced: '5.1.1' });

    // The lookup every sending path uses matches case-insensitively.
    expect((await findSuppressed(t.db, ['NOSUCH@BOUNCE.TEST', 'policy@bounce.test'])).map((m) => m.address)).toEqual(['nosuch@bounce.test']);
  });

  it('a repeat hard bounce of a listed address bumps its count and last time, keeping one row', async () => {
    const first = await t.db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'nosuch@bounce.test' } });
    clock = new Date(clock.getTime() + 3_600_000);
    // Queued before it was listed (enqueueOutbound itself does not check: acceptSubmission does).
    await submit(['nosuch@bounce.test']);
    await worker.drain();
    const again = await t.db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'nosuch@bounce.test' } });
    expect(again.id).toBe(first.id);
    expect(again.bounceCount).toBe(2);
    expect(again.firstAt).toEqual(first.firstAt);
    expect(again.lastAt).toEqual(clock);
    expect(again.sourceRecipientId).not.toBe(first.sourceRecipientId);
  });

  it('an expiry bounce (still 4xx after 5 days) never suppresses', async () => {
    // temp@bounce.test from the first test is deferred; walk it past the 5-day mark.
    for (let i = 0; i < 400; i++) {
      const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { address: 'temp@bounce.test' } });
      if (r.state === 'bounced') break;
      clock = new Date(Math.max(clock.getTime(), r.nextAttemptAt.getTime()));
      await worker.drain();
    }
    const r = await t.db.outboundRecipient.findFirstOrThrow({ where: { address: 'temp@bounce.test' } });
    expect(r.state).toBe('bounced');
    expect(clock.getTime() - T0.getTime()).toBeGreaterThanOrEqual(MAX_QUEUE_AGE_MS);
    expect(await t.db.suppressedRecipient.findUnique({ where: { address: 'temp@bounce.test' } })).toBeNull();
    expect(await t.db.suppressedRecipient.count()).toBe(1);
  });
});
