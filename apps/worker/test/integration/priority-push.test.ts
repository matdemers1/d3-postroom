// PST-T-20.5: new Priority mail reaches every device registered for postroom.priority — the sender's
// name, the subject, the thread, a link that opens the message — sealed to the device and collapsed
// per thread. People mail pushes nothing, and neither does a device that did not ask for Priority.
import { createECDH, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek, sealWithKek } from '@postroom/crypto';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { openEnvelope, sendKeyAad } from '@postroom/push';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { createInboundPipeline, INBOUND_QUEUE } from '../../src/pipeline.js';
import { Clock, plainMessage, spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('Priority mail through the relay (PST-T-20.5)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let worker: RunningWorker;
  let youId = '';
  const kek = generateKek();
  const clock = new Clock();
  const sent: { url: string; body: string }[] = [];
  const device = createECDH('prime256v1');
  device.generateKeys();
  const relayFetch: typeof fetch = (input, init) => {
    sent.push({ url: String(input), body: String(init?.body ?? '') });
    return Promise.resolve(new Response('{}', { status: 202 }));
  };

  const you = (): TestRecipient => ({ rcpt: 'you@d3cloud.io', address: 'you@d3cloud.io', accountIds: [youId], kind: 'mailbox' });
  const settle = async (n: number): Promise<void> => {
    for (let i = 0; i < 80 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 25));
  };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t205');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    youId = (await db.account.create({ data: { displayName: 'You' } })).id;
    for (const categories of [['postroom.priority'], ['postroom.other']]) {
      const id = randomUUID();
      await db.relayRegistration.create({
        data: {
          id,
          accountId: youId,
          devicePublicKey: new Uint8Array(device.getPublicKey()),
          relayUrl: 'https://relay.example.test',
          registration: `reg-${categories[0] ?? ''}`,
          sendKeySealed: new Uint8Array(sealWithKek(kek, Buffer.from('send-key-0123456789abcdef'), sendKeyAad(id))),
          categories,
        },
      });
    }
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t205-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    worker = await startWorker({
      db,
      databaseUrl: t.url,
      queues: {
        [INBOUND_QUEUE]: createInboundPipeline({ db, blobs, now: clock.now, kek: () => kek, push: { host: 'mail.example.test', fetch: relayFetch } }).handle,
      },
      manual: true,
      now: clock.now,
    });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('pushes a Priority message to the device that asked for Priority, and only to it', async () => {
    // Alice is Priority by the account's own rule; everyone else is People.
    await db.sieveScript.create({
      data: { accountId: youId, name: 'rules', active: true, content: ['require "vnd.postroom.bucket";', 'if address :is "from" "alice@example.org" { bucket "priority"; }', ''].join('\r\n') },
    });
    const { id } = await spool(db, blobs, { recipients: [you()], message: plainMessage({ subject: 'Re: site copy' }) });
    expect(await worker.drain()).toBe(1);
    await settle(1);
    expect(sent).toHaveLength(1);
    const [push] = sent;
    expect(push?.url).toBe('https://relay.example.test/v1/push/reg-postroom.priority');
    const body = JSON.parse(push?.body ?? '{}') as { ciphertext: string; collapseId?: string };
    const payload = JSON.parse(openEnvelope(device, body.ciphertext).toString()) as Record<string, unknown>;
    const message = await db.message.findFirstOrThrow({ where: { inboundMessageId: id } });
    expect(payload).toMatchObject({
      v: 1,
      category: 'postroom.priority',
      title: 'Alice',
      body: 'Re: site copy',
      thread: message.threadId,
      link: `d3constellation://mail.example.test/postroom/message/${message.id}`,
    });
    expect(body.collapseId).toBe(message.threadId);
  });

  it('People mail pushes nothing', async () => {
    const before = sent.length;
    await spool(db, blobs, { recipients: [you()], message: plainMessage({ subject: 'Just people', from: 'bob@example.org' }) });
    expect(await worker.drain()).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.length).toBe(before);
  });
});
