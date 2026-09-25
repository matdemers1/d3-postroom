// End to end with the queue: the outbound worker runs the real direct transport against a loopback
// MX, and the DeliveryAttempt row carries what the attempt learned — MX, source address, TLS.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker } from '@postroom/queue';
import { fakeResolver, startFakeMx, type FakeMx, type FakeMxTls } from '../../src/client/fake-mx.js';
import { createDirectTransport } from '../../src/client/transport.js';
import { enqueueOutbound, OUTBOUND_QUEUE } from '../../src/enqueue.js';
import { createDeliveryWorker } from '../../src/worker.js';

const baseUrl = process.env['DATABASE_URL'];
const BODY = 'From: me@d3cloud.io\r\nTo: you@e2e.test\r\nSubject: e2e\r\n\r\n.a dotted line\r\nbye\r\n';

let certDir: string | undefined;
let tlsConfig: FakeMxTls | undefined;
try {
  certDir = mkdtempSync(path.join(tmpdir(), 'pst-t16-cert-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
    '-days', '1', '-subj', '/CN=mx.e2e.test',
  ], { stdio: 'ignore' });
  tlsConfig = { key: readFileSync(path.join(certDir, 'key.pem')), cert: readFileSync(path.join(certDir, 'cert.pem')) };
} catch (error) {
  console.warn(`openssl unavailable, skipping the queue + STARTTLS test: ${error instanceof Error ? error.message : String(error)}`);
}

describe.skipIf(baseUrl === undefined || tlsConfig === undefined)('outbound queue with the direct MX client', () => {
  let t: TestDatabase;
  let mx: FakeMx;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t16');
    mx = await startFakeMx({ capabilities: () => ['8BITMIME', 'SIZE 1000000'] }, tlsConfig);
  }, 120_000);
  afterAll(async () => {
    await mx.close();
    await t.drop();
    if (certDir !== undefined) rmSync(certDir, { recursive: true, force: true });
  });

  it('a queued recipient is delivered, and its attempt records mxIp, localIp, tlsVersion and tlsCipher', async () => {
    const clock = new Date('2026-09-25T12:00:00Z');
    const accountId = (await t.db.account.create({ data: { displayName: 'Sender' } })).id;
    const direct = createDirectTransport({
      resolver: fakeResolver({ mx: { 'e2e.test': [{ preference: 10, exchange: 'mx.e2e.test' }] }, a: { 'mx.e2e.test': ['127.0.0.1'] } }),
      port: mx.port,
      log: () => undefined,
    });
    const delivery = createDeliveryWorker({
      db: t.db,
      transports: { direct },
      openMessage: () => Promise.resolve(Readable.from([Buffer.from(BODY)])),
      now: () => clock,
      leaseMs: 60_000,
      attemptTimeoutMs: 30_000,
    });
    const worker = await startWorker({ db: t.db, databaseUrl: t.url, manual: true, now: () => clock, leaseMs: 60_000, queues: { [OUTBOUND_QUEUE]: delivery.handle } });
    try {
      const { message } = await t.db.$transaction((tx) => enqueueOutbound(tx, {
        accountId,
        envelopeFrom: 'me@d3cloud.io',
        headerFrom: 'me@d3cloud.io',
        blobSha256: 'b'.repeat(64),
        size: BODY.length,
        submittedVia: 'test',
        recipients: [{ address: 'you@e2e.test' }],
      }, { now: clock }));

      expect(await worker.drain()).toBe(1);

      const recipient = await t.db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: message.id } });
      expect(recipient.state).toBe('delivered');
      expect(recipient.lastCode).toBe(250);
      const attempts = await t.db.deliveryAttempt.findMany({ where: { recipientId: recipient.id } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        transport: 'direct',
        outcome: 'delivered',
        remoteCode: 250,
        mxHost: 'mx.e2e.test',
        mxIp: '127.0.0.1',
        localIp: '127.0.0.1',
        tlsVersion: 'TLSv1.3',
      });
      expect(attempts[0]?.tlsCipher).toMatch(/^TLS_/);
      expect(attempts[0]?.tlsPeer).toMatch(/CN=mx\.e2e\.test; .*verified=false/);

      // The remote saw our source address and the message as written.
      const session = mx.sessions[0];
      expect(session?.remoteAddress).toBe('127.0.0.1');
      expect(session?.secure).toBe(true);
      expect(session?.mailFrom).toBe(`MAIL FROM:<me@d3cloud.io> SIZE=${BODY.length} BODY=8BITMIME`);
      expect(session?.body).toBe(BODY);
    } finally {
      await worker.stop();
    }
  });
});
