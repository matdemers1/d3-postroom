// PST-REQ-187 through the real worker: while FCrDNS does not hold, a recipient routed to `direct`
// is carried by SES, and its DeliveryAttempt records `ses` — not the `direct` key it was routed to.
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { enqueueOutbound, OUTBOUND_QUEUE } from '../../src/enqueue.js';
import { FakeTransport, reply } from '../../src/transports/fake.js';
import { guardDirectTransport } from '../../src/transports/index.js';
import { createDeliveryWorker } from '../../src/worker.js';

const baseUrl = process.env['DATABASE_URL'];
const T0 = new Date('2026-09-27T12:00:00Z');
const BODY = 'Subject: hi\r\n\r\nbody\r\n';

describe.skipIf(baseUrl === undefined)('FCrDNS guard: the attempt records the transport that carried it (PST-REQ-187)', () => {
  let t: TestDatabase;
  let worker: RunningWorker;
  const direct = new FakeTransport({ name: 'direct', script: () => reply.ok() });
  const ses = new FakeTransport({ name: 'ses', script: () => reply.ok(), details: { mxHost: 'email-smtp.us-east-1.amazonaws.com' } });

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t416_attempt');
    const guard = { check: () => Promise.resolve({ valid: false as const, reason: 'FCrDNS not yet valid: PTR is ec2-18-208-39-127.compute-1.amazonaws.com, expected mx.d3cloud.io' }) };
    const delivery = createDeliveryWorker({
      db: t.db,
      transports: { direct: guardDirectTransport(direct, ses, guard) },
      openMessage: () => Promise.resolve(Readable.from([Buffer.from(BODY)])),
      onDsn: () => Promise.resolve(),
      now: () => T0,
    });
    worker = await startWorker({ db: t.db, databaseUrl: t.url, manual: true, now: () => T0, queues: { [OUTBOUND_QUEUE]: delivery.handle } });
  }, 120_000);
  afterAll(async () => {
    await worker.stop();
    await t.drop();
  });

  it('routes a direct recipient through SES and records transport ses', async () => {
    const accountId = (await t.db.account.create({ data: { displayName: 'Sender' } })).id;
    const { message } = await t.db.$transaction((tx) =>
      enqueueOutbound(tx, { accountId, envelopeFrom: 'me@d3cloud.io', headerFrom: 'me@d3cloud.io', blobSha256: 'a'.repeat(64), size: BODY.length, submittedVia: 'test', recipients: [{ address: 'someone@example.test' }] }, { now: T0 }),
    );
    await worker.drain();

    expect(direct.calls).toHaveLength(0);
    expect(ses.calls).toHaveLength(1);
    const recipient = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: message.id } });
    expect(recipient.state).toBe('delivered');
    const attempts = await t.db.deliveryAttempt.findMany({ where: { recipientId: recipient.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ transport: 'ses', outcome: 'delivered', mxHost: 'email-smtp.us-east-1.amazonaws.com' });
  });
});
