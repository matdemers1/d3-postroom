// PST-T-1.11 doneWhen, through the queue: forcing SES for a test domain delivers that recipient via
// the (loopback) SES smarthost with Postroom's DKIM intact, every other domain still goes direct,
// and the DeliveryAttempt row — what the delivery timeline shows — says 'ses' and names the host.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { generateDkimKeys, signMessage, verifyLocal } from '@postroom/auth-checks';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker } from '@postroom/queue';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeResolver, startFakeMx, type FakeMx, type FakeMxTls } from '../../src/client/fake-mx.js';
import { createDirectTransport } from '../../src/client/transport.js';
import { enqueueOutbound, OUTBOUND_QUEUE } from '../../src/enqueue.js';
import { createSesTransport, parseSesDomains } from '../../src/transports/ses.js';
import type { Transport } from '../../src/transports/types.js';
import { createDeliveryWorker } from '../../src/worker.js';

const baseUrl = process.env['DATABASE_URL'];
const SES_HOST = 'email-smtp.fake.test';
const USER = 'AKIAFAKESMTPUSER';
const PASSWORD = 'fake-ses-smtp-password';

let certDir: string | undefined;
let sesTls: FakeMxTls | undefined;
try {
  certDir = mkdtempSync(path.join(tmpdir(), 'pst-t111-cert-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
    '-days', '1', '-subj', `/CN=${SES_HOST}`, '-addext', `subjectAltName=DNS:${SES_HOST}`,
  ], { stdio: 'ignore' });
  sesTls = { key: readFileSync(path.join(certDir, 'key.pem')), cert: readFileSync(path.join(certDir, 'cert.pem')) };
} catch (error) {
  console.warn(`openssl unavailable, skipping the SES queue test: ${error instanceof Error ? error.message : String(error)}`);
}

const keys = generateDkimKeys();
const UNSIGNED = Buffer.from('From: me@d3cloud.io\r\nTo: a@example.test, b@other.test\r\nSubject: ses\r\n\r\n.dot-led\r\nbody é\r\n', 'utf8');

describe.skipIf(baseUrl === undefined || sesTls === undefined)('outbound queue with the SES fallback', () => {
  let t: TestDatabase;
  let sesHost: FakeMx;
  let mx: FakeMx;
  let signed: Buffer;
  let accountId: string;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t111');
    sesHost = await startFakeMx({ capabilities: () => ['8BITMIME', 'SIZE 10485760'], auth: { user: USER, password: PASSWORD } }, sesTls);
    mx = await startFakeMx({ capabilities: () => ['8BITMIME'] });
    const headers = await signMessage(UNSIGNED, {
      domain: 'd3cloud.io',
      keys: [{ selector: 'ed', algorithm: 'ed25519-sha256', privateKey: keys.ed25519.privateKey }],
      canonicalization: 'simple/simple',
    });
    signed = Buffer.concat([Buffer.from(headers.join(''), 'latin1'), UNSIGNED]);
    accountId = (await t.db.account.create({ data: { displayName: 'Sender' } })).id;
  }, 120_000);
  afterAll(async () => {
    await sesHost.close();
    await mx.close();
    await t.drop();
    if (certDir !== undefined) rmSync(certDir, { recursive: true, force: true });
  });

  const resolver = fakeResolver({
    mx: { 'other.test': [{ preference: 10, exchange: 'mx.other.test' }], 'example.test': [{ preference: 10, exchange: 'mx.other.test' }] },
    a: { 'mx.other.test': ['127.0.0.1'], [SES_HOST]: ['127.0.0.1'] },
  });

  function transports(sesDomains: string): Record<string, Transport> {
    return {
      direct: createDirectTransport({ resolver, port: mx.port, log: () => undefined }),
      ses: createSesTransport({
        host: SES_HOST, port: sesHost.port, user: USER, password: PASSWORD, resolver,
        domains: parseSesDomains(sesDomains), tlsOptions: { ca: sesTls?.cert ?? '' }, log: () => undefined,
      }),
    };
  }

  async function run(sesDomains: string, clock: Date, transportOverride?: Record<string, Transport>): Promise<string> {
    const delivery = createDeliveryWorker({
      db: t.db,
      transports: transportOverride ?? transports(sesDomains),
      openMessage: () => Promise.resolve(Readable.from([signed.subarray(0, 50), signed.subarray(50)])),
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
        blobSha256: 'c'.repeat(64),
        size: signed.length,
        submittedVia: 'test',
        recipients: [{ address: 'a@example.test' }, { address: 'b@other.test' }],
      }, { now: clock }));
      expect(await worker.drain()).toBe(2);
      return message.id;
    } finally {
      await worker.stop();
    }
  }

  async function attemptsByAddress(messageId: string): Promise<Record<string, { state: string; transport: string; mxHost: string | null; tlsPeer: string | null; outcome: string }>> {
    const recipients = await t.db.outboundRecipient.findMany({ where: { outboundMessageId: messageId }, include: { attemptsLog: true } });
    return Object.fromEntries(recipients.map((r) => {
      expect(r.attemptsLog).toHaveLength(1);
      const a = r.attemptsLog[0];
      return [r.address, { state: r.state, transport: a?.transport ?? '', mxHost: a?.mxHost ?? null, tlsPeer: a?.tlsPeer ?? null, outcome: a?.outcome ?? '' }];
    }));
  }

  it('DELIVERY_SES_DOMAINS=example.test: that recipient goes via SES with DKIM intact, the other direct; attempts say so', async () => {
    const sesBefore = sesHost.sessions.length;
    const mxBefore = mx.sessions.length;
    const id = await run('example.test', new Date('2026-09-26T12:00:00Z'));
    const byAddress = await attemptsByAddress(id);
    expect(byAddress['a@example.test']).toMatchObject({ state: 'delivered', transport: 'ses', mxHost: SES_HOST, outcome: 'delivered' });
    expect(byAddress['a@example.test']?.tlsPeer).toContain('verified=true');
    expect(byAddress['b@other.test']).toMatchObject({ state: 'delivered', transport: 'direct', mxHost: 'mx.other.test', outcome: 'delivered' });

    const viaSes = sesHost.sessions.slice(sesBefore);
    expect(viaSes).toHaveLength(1);
    expect(viaSes[0]?.authUser).toBe(USER);
    expect(viaSes[0]?.rcptTo).toEqual(['a@example.test']);
    const received = viaSes[0]?.bodyBuffer() ?? Buffer.alloc(0);
    expect(received.equals(signed)).toBe(true);
    expect((await verifyLocal(received, { ed: keys.ed25519.publicKey })).map((v) => v.result)).toEqual(['pass']);
    expect(mx.sessions.slice(mxBefore).map((s) => s.rcptTo)).toEqual([['b@other.test']]);
  });

  it("DELIVERY_SES_DOMAINS='*' routes every domain via SES", async () => {
    const mxBefore = mx.sessions.length;
    const id = await run('*', new Date('2026-09-26T13:00:00Z'));
    const byAddress = await attemptsByAddress(id);
    expect(byAddress['a@example.test']).toMatchObject({ state: 'delivered', transport: 'ses', mxHost: SES_HOST });
    expect(byAddress['b@other.test']).toMatchObject({ state: 'delivered', transport: 'ses', mxHost: SES_HOST });
    expect(mx.sessions.length).toBe(mxBefore);
  });

  it('an SES 4xx defers and a 5xx bounces, through the same state machine as direct', async () => {
    const strict = await startFakeMx({
      auth: { user: USER, password: PASSWORD },
      rcpt: (to) => (to.startsWith('a@') ? '451 4.4.5 Maximum sending rate exceeded' : '554 5.7.1 Address blacklisted'),
    }, sesTls);
    try {
      const id = await run('*', new Date('2026-09-26T14:00:00Z'), {
        direct: createDirectTransport({ resolver, port: mx.port, log: () => undefined }),
        ses: createSesTransport({ host: SES_HOST, port: strict.port, user: USER, password: PASSWORD, resolver, domains: ['*'], tlsOptions: { ca: sesTls?.cert ?? '' }, log: () => undefined }),
      });
      const byAddress = await attemptsByAddress(id);
      expect(byAddress['a@example.test']).toMatchObject({ state: 'deferred', transport: 'ses', outcome: 'deferred' });
      expect(byAddress['b@other.test']).toMatchObject({ state: 'bounced', transport: 'ses' });
    } finally {
      await strict.close();
    }
  });
});
