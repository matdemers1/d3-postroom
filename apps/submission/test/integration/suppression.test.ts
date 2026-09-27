// PST-T-11.10 / PST-REQ-176, PST-REQ-179 over SMTP submission: a message is accepted on 465, the
// delivery worker attempts it against the fake transport, which answers 550 5.1.1 for one
// recipient — so that address is suppressed — and a second send to it is refused at RCPT (550
// 5.1.1 naming the suppression, just that RCPT), and at DATA when it was listed after RCPT.
// Removing the entry lets the address be sent to again. Real sockets, real TLS, a real database.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { createAppPassword, hashAppPassword } from '@postroom/credentials';
import { createAuthThrottle } from '@postroom/auth-throttle';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { createDeliveryWorker, OUTBOUND_QUEUE } from '@postroom/delivery';
import { FakeTransport, reply as fakeReply } from '@postroom/delivery/fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDkimKeys } from '../../src/dkim.js';
import { createSubmissionListeners, type SubmissionListeners } from '../../src/server.js';
import { SmtpTestClient, b64 } from './client.js';

const exec = promisify(execFile);
const baseUrl = process.env['DATABASE_URL'];
const PEPPER = 'test-pepper-0123456789abcdef';
const OPERATOR = { kind: 'system', label: 'test' } as const;

describe.skipIf(baseUrl === undefined)('suppression list over SMTP submission (PST-T-11.10)', () => {
  let t: TestDatabase;
  let db: Db;
  let kek: Kek;
  let blobs: BlobStore;
  let dir: string;
  let listeners: SubmissionListeners;
  let port465 = 0;
  let account: { address: string; appPassword: string };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1110_submission');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    dir = await mkdtemp(join(tmpdir(), 'pst-t1110-'));
    await exec('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
    ]);
    kek = generateKek();
    blobs = createBlobStore({ root: join(dir, 'blobs'), db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');

    const login = `u${Math.random().toString(16).slice(2, 10)}`;
    const d = await db.domain.findUniqueOrThrow({ where: { name: 'd3cloud.io' } });
    const acct = await db.account.create({ data: { displayName: login, passwordHash: await hashAppPassword('correct horse battery staple', PEPPER) } });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: acct.id } });
    const created = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'suppression', scopes: ['smtp'] }, { pepper: PEPPER });
    account = { address: `${login}@d3cloud.io`, appPassword: created.password };

    listeners = createSubmissionListeners({
      db,
      hostname: 'mail.d3cloud.io',
      maxSize: 10 * 1024 * 1024,
      maxRecipients: 20,
      pepper: PEPPER,
      storage: () => ({ blobs, kek }),
      tls: { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) },
      throttle: createAuthThrottle({ db, sleep: () => Promise.resolve(), sourceCeiling: 1000 }),
    });
    const s465 = listeners.submissions;
    if (s465 === null) throw new Error('465 listener missing');
    s465.listen(0, '127.0.0.1');
    await once(s465, 'listening');
    port465 = (s465.address() as AddressInfo).port;
  }, 120_000);

  afterAll(async () => {
    await listeners.close();
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  async function session(): Promise<SmtpTestClient> {
    const c = await SmtpTestClient.implicitTls(port465);
    await c.next();
    await c.send('EHLO client.test');
    expect((await c.send(`AUTH PLAIN ${b64(`\0${account.address}\0${account.appPassword}`)}`)).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${account.address}>`)).code).toBe(250);
    return c;
  }

  const message = (to: string): string => [`From: Me <${account.address}>`, `To: <${to}>`, 'Subject: hi', '', 'Hi.', ''].join('\r\n');

  /** Run every due outbound job through the real delivery worker, against the fake transport. */
  async function deliverAll(): Promise<void> {
    const fake = new FakeTransport({ script: (r) => (r.address.startsWith('gone@') ? fakeReply.reject('No such user') : fakeReply.ok()) });
    const worker = createDeliveryWorker({ db, transports: { direct: fake }, openMessage: () => Promise.resolve(Readable.from([Buffer.from('x')])), onDsn: () => Promise.resolve() });
    const jobs = await db.job.findMany({ where: { queue: OUTBOUND_QUEUE, status: 'pending' } });
    for (const job of jobs) {
      await worker.handle(job);
      await db.job.update({ where: { id: job.id }, data: { status: 'done' } });
    }
  }

  it('a fake-transport 550 5.1.1 suppresses the address; the next RCPT to it is refused, alone', async () => {
    const first = await session();
    expect((await first.send('RCPT TO:<gone@example.com>')).code).toBe(250);
    expect((await first.send('RCPT TO:<friend@example.com>')).code).toBe(250);
    expect((await first.data(message('gone@example.com'))).final?.code).toBe(250);
    first.close();

    await deliverAll();
    const listed = await db.suppressedRecipient.findUniqueOrThrow({ where: { address: 'gone@example.com' } });
    expect(listed).toMatchObject({ reason: 'hard-bounce', code: 550, enhanced: '5.1.1', text: 'No such user' });
    // friend@ was delivered, so it is not listed.
    expect(await db.suppressedRecipient.count()).toBe(1);

    const second = await session();
    const refused = await second.send('RCPT TO:<Gone@Example.com>');
    expect(refused).toMatchObject({ code: 550, enhanced: '5.1.1' });
    expect(refused.lines.join(' ')).toContain('gone@example.com is on this server\'s suppression list (after a hard bounce)');
    // Only that RCPT: the transaction carries on with the others.
    expect((await second.send('RCPT TO:<friend@example.com>')).code).toBe(250);
    const accepted = await second.data(message('friend@example.com'));
    expect(accepted.final?.code).toBe(250);
    const id = /Queued as ([0-9a-f-]{36})/.exec(accepted.final?.lines.join(' ') ?? '')?.[1];
    const queued = await db.outboundRecipient.findMany({ where: { outboundMessageId: id ?? '' } });
    expect(queued.map((r) => r.address)).toEqual(['friend@example.com']);
    second.close();
  });

  it('listed between RCPT and DATA: the accepting transaction refuses the message with 550 5.1.1', async () => {
    const c = await session();
    expect((await c.send('RCPT TO:<late@example.com>')).code).toBe(250);
    await db.suppressedRecipient.create({ data: { address: 'late@example.com', reason: 'manual', bounceCount: 0 } });
    const before = await db.outboundMessage.count();
    const { final } = await c.data(message('late@example.com'));
    expect(final).toMatchObject({ code: 550, enhanced: '5.1.1' });
    expect(final?.lines.join(' ')).toContain('late@example.com is on this server\'s suppression list (added by an admin)');
    expect(await db.outboundMessage.count()).toBe(before);
    c.close();
  });

  it('removal re-allows sending to the address', async () => {
    await db.suppressedRecipient.deleteMany({ where: { address: { in: ['gone@example.com', 'late@example.com'] } } });
    const c = await session();
    expect((await c.send('RCPT TO:<gone@example.com>')).code).toBe(250);
    expect((await c.data(message('gone@example.com'))).final?.code).toBe(250);
    c.close();
  });
});
