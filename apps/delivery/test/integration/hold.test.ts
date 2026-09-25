// PST-T-1.10 / PST-REQ-044: a message whose credential is frozen is held (never attempted) until an
// operator thaws it, at which point it is delivered normally.
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { enqueueOutbound, OUTBOUND_QUEUE } from '../../src/enqueue.js';
import { HELD_TEXT, thawCredential } from '../../src/hold.js';
import { FakeTransport, reply } from '../../src/transports/fake.js';
import { createDeliveryWorker } from '../../src/worker.js';

const baseUrl = process.env['DATABASE_URL'];
const T0 = new Date('2026-09-25T12:00:00Z');
const BODY = 'Subject: hi\r\n\r\nbody\r\n';
const SYSTEM = { kind: 'system' } as const;

describe.skipIf(baseUrl === undefined)('held mail (PST-T-1.10)', () => {
  let t: TestDatabase;
  let accountId: string;
  let clock: Date;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t110_delivery');
    accountId = (await t.db.account.create({ data: { displayName: 'Sender' } })).id;
  }, 120_000);
  afterAll(async () => { await t.drop(); });

  async function makeFrozenAppPassword(): Promise<string> {
    const ap = await t.db.appPassword.create({
      data: { accountId, label: 'held-credential', prefix: `pfx${Math.random().toString(16).slice(2, 10)}`, hash: 'x', scopes: ['smtp'], frozenAt: clock },
    });
    return ap.id;
  }

  function setup(): { worker: Promise<RunningWorker>; fake: FakeTransport } {
    const fake = new FakeTransport({ script: () => reply.ok(), readMessage: true });
    const delivery = createDeliveryWorker({
      db: t.db,
      transports: { direct: fake },
      openMessage: () => Promise.resolve(Readable.from([Buffer.from(BODY)])),
      now: () => clock,
    });
    const worker = startWorker({ db: t.db, databaseUrl: t.url, manual: true, now: () => clock, queues: { [OUTBOUND_QUEUE]: delivery.handle } });
    return { worker, fake };
  }

  async function submit(appPasswordId: string, recipients: string[]): Promise<string> {
    const { message } = await t.db.$transaction((tx) => enqueueOutbound(tx, {
      accountId,
      appPasswordId,
      envelopeFrom: 'me@d3cloud.io',
      headerFrom: 'me@d3cloud.io',
      blobSha256: 'a'.repeat(64),
      size: BODY.length,
      submittedVia: 'test',
      recipients: recipients.map((address) => ({ address })),
    }, { now: clock }));
    return message.id;
  }

  it('a queued message whose credential is frozen is never attempted; after thaw it is delivered', async () => {
    clock = new Date(T0);
    const appPasswordId = await makeFrozenAppPassword();
    const { worker: w, fake } = setup();
    const worker = await w;

    const id = await submit(appPasswordId, ['held@example.com']);
    const ran = await worker.drain();
    expect(ran).toBeGreaterThan(0); // the job ran; it just held instead of attempting
    expect(fake.calls).toHaveLength(0);

    const held = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: id } });
    expect(held.state).toBe('queued');
    expect(held.lastText).toBe(HELD_TEXT);
    expect(held.attempts).toBe(0);

    // Nothing rescheduled itself while frozen: no more jobs to drain, no transport call.
    expect(await worker.drain()).toBe(0);
    expect(fake.calls).toHaveLength(0);

    const before = await t.db.auditEvent.count({ where: { action: 'app_password.thaw', entityId: appPasswordId } });
    const result = await thawCredential(t.db, appPasswordId, SYSTEM, clock);
    expect(result).toEqual({ thawed: true, rescheduled: 1 });
    const after = await t.db.auditEvent.count({ where: { action: 'app_password.thaw', entityId: appPasswordId } });
    expect(after).toBe(before + 1);

    const thawedAgain = await thawCredential(t.db, appPasswordId, SYSTEM, clock);
    expect(thawedAgain).toEqual({ thawed: false, rescheduled: 0 });

    expect(await worker.drain()).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(1);
    const delivered = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: id } });
    expect(delivered.state).toBe('delivered');

    await worker.stop();
  });
});
