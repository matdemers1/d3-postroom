// PST-T-6.3, PST-REQ-117, PST-REQ-118: real submission sessions — the daemon that carries real app
// passwords on 587/465 — over loopback with real TLS against a real database. Each ends with exactly
// one compressed transcript row for daemon 'submission' whose decompressed text never contains the
// app password or its base64, and no live-view NOTIFY payload (captured with LISTEN smtp_live)
// contains it either — including when the client pipelines AUTH PLAIN and its continuation in one
// write, before the server's 334.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { createAppPassword, hashAppPassword } from '@postroom/credentials';
import { createAuthThrottle } from '@postroom/auth-throttle';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDkimKeys } from '../../src/dkim.js';
import { createSubmissionListeners, type SubmissionListeners } from '../../src/server.js';
import { decompressTranscript, SMTP_LIVE_CHANNEL } from '../../src/transcript.js';
import { SmtpTestClient, b64 } from './client.js';

const exec = promisify(execFile);
const baseUrl = process.env['DATABASE_URL'];
const PEPPER = 'test-pepper-0123456789abcdef';
const OPERATOR = { kind: 'system', label: 'test' } as const;

// `pg` is @postroom/db's dependency, not this app's; resolve it from there rather than add a dep.
interface ListenClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  on(event: 'notification', fn: (n: { channel: string; payload?: string }) => void): void;
  end(): Promise<void>;
}
const requireFromDb = createRequire(join(import.meta.dirname, '../../../../packages/db/package.json'));
const pg = requireFromDb('pg') as { Client: new (o: { connectionString: string }) => ListenClient };

interface Account {
  address: string;
  appPassword: string;
}

describe.skipIf(baseUrl === undefined)('submission session transcripts (PST-T-6.3)', () => {
  let t: TestDatabase;
  let db: Db;
  let kek: Kek;
  let blobs: BlobStore;
  let dir: string;
  let listeners: SubmissionListeners;
  let listener: ListenClient;
  let port587 = 0;
  let port465 = 0;
  const notified: string[] = [];

  async function makeAccount(): Promise<Account> {
    const login = `u${Math.random().toString(16).slice(2, 10)}`;
    const d = await db.domain.upsert({ where: { name: 'd3cloud.io' }, update: {}, create: { name: 'd3cloud.io' } });
    const account = await db.account.create({ data: { displayName: login, passwordHash: await hashAppPassword('web password', PEPPER) } });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    const created = await createAppPassword(db, OPERATOR, { accountId: account.id, label: 'Thunderbird', scopes: ['smtp'] }, { pepper: PEPPER });
    return { address: `${login}@d3cloud.io`, appPassword: created.password };
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t63b_sub');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    dir = await mkdtemp(join(tmpdir(), 'pst-t63b-'));
    await exec('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
    ]);
    kek = generateKek();
    blobs = createBlobStore({ root: join(dir, 'blobs'), db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');

    listener = new pg.Client({ connectionString: t.url });
    await listener.connect();
    listener.on('notification', (n) => {
      if (n.channel === SMTP_LIVE_CHANNEL && n.payload !== undefined) notified.push(n.payload);
    });
    await listener.query(`LISTEN ${SMTP_LIVE_CHANNEL}`);

    listeners = createSubmissionListeners({
      db,
      hostname: 'mail.d3cloud.io',
      maxSize: 10 * 1024 * 1024,
      maxRecipients: 3,
      pepper: PEPPER,
      storage: () => ({ blobs, kek }),
      tls: { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) },
      throttle: createAuthThrottle({ db, sleep: () => Promise.resolve(), sourceCeiling: 1000 }),
      log: () => undefined,
    });
    listeners.submission.listen(0, '127.0.0.1');
    await once(listeners.submission, 'listening');
    port587 = (listeners.submission.address() as AddressInfo).port;
    const s465 = listeners.submissions;
    if (s465 === null) throw new Error('465 listener missing');
    s465.listen(0, '127.0.0.1');
    await once(s465, 'listening');
    port465 = (s465.address() as AddressInfo).port;
  }, 120_000);

  afterAll(async () => {
    await listeners.close();
    await listener.end();
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  function message(from: string): string {
    return [`From: Me <${from}>`, 'To: Friend <friend@example.com>', 'Subject: transcript test', '', 'the secret body text', ''].join('\r\n');
  }

  /** Waits for the session's row, then for its NOTIFYs (fire-and-forget) to have landed. */
  async function newRow(before: number): Promise<Awaited<ReturnType<Db['smtpTranscript']['findMany']>>> {
    let rows = await db.smtpTranscript.findMany({ where: { daemon: 'submission' }, orderBy: { startedAt: 'asc' } });
    for (let i = 0; i < 100 && rows.length <= before; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      rows = await db.smtpTranscript.findMany({ where: { daemon: 'submission' }, orderBy: { startedAt: 'asc' } });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return rows;
  }

  function secretsOf(acct: Account): string[] {
    return [acct.appPassword, b64(acct.appPassword), b64(`\0${acct.address}\0${acct.appPassword}`)];
  }

  function expectNoSecrets(text: string, secrets: readonly string[]): void {
    for (const s of secrets) expect(text).not.toContain(s);
  }

  it('587: STARTTLS, AUTH PLAIN with an app password, MAIL/RCPT/DATA/QUIT → one compressed row, no secret stored or published', async () => {
    const acct = await makeAccount();
    const secrets = secretsOf(acct);
    const before = await db.smtpTranscript.count({ where: { daemon: 'submission' } });
    const notifiedBefore = notified.length;

    const c = await SmtpTestClient.plain(port587);
    expect((await c.next()).code).toBe(220);
    expect((await c.send('EHLO client.test')).code).toBe(250);
    expect((await c.startTls()).code).toBe(220);
    expect((await c.send('EHLO client.test')).code).toBe(250);
    expect((await c.send(`AUTH PLAIN ${b64(`\0${acct.address}\0${acct.appPassword}`)}`)).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    expect((await c.send('RCPT TO:<friend@example.com>')).code).toBe(250);
    expect((await c.data(message(acct.address))).final?.code).toBe(250);
    expect((await c.send('QUIT')).code).toBe(221);
    c.close();

    const rows = await newRow(before);
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    if (row === undefined) throw new Error('no transcript row');
    expect(row.daemon).toBe('submission');
    expect(row.compression).toBe('gzip');
    expect(row.compressedBytes).toBeGreaterThan(0);
    expect(row.compressedBytes).toBe(row.body.length);
    const text = decompressTranscript(row);
    expect(Buffer.byteLength(text, 'utf8')).toBe(row.rawBytes);
    expectNoSecrets(text, secrets);
    expect(text).toContain('C: STARTTLS');
    expect(text).toContain('C: AUTH PLAIN [redacted]');
    expect(text).toContain(`C: MAIL FROM:<${acct.address}>`);
    expect(text).toContain('C: RCPT TO:<friend@example.com>');
    expect(text).toMatch(/C: \[message body: \d+ bytes\]/);
    expect(text).not.toContain('the secret body text');
    expect(text).toContain('C: QUIT');

    const live = notified.slice(notifiedBefore);
    const mine = live.filter((p) => (JSON.parse(p) as { sessionId: string }).sessionId === row.sessionId);
    expect(mine.length).toBe(row.lineCount);
    expect(mine.some((p) => p.includes('AUTH PLAIN [redacted]'))).toBe(true);
    for (const payload of live) expectNoSecrets(payload, secrets);
  });

  it('465: AUTH PLAIN and its base64 continuation pipelined in one write, before the 334 → still redacted, stored and live', async () => {
    const acct = await makeAccount();
    const secrets = secretsOf(acct);
    const before = await db.smtpTranscript.count({ where: { daemon: 'submission' } });
    const notifiedBefore = notified.length;

    const c = await SmtpTestClient.implicitTls(port465);
    expect((await c.next()).code).toBe(220);
    expect((await c.send('EHLO client.test')).code).toBe(250);
    // The client class has no raw write; this is the refutation's exact shape on the wire.
    (c as unknown as { socket: Socket }).socket.write(`AUTH PLAIN\r\n${b64(`\0${acct.address}\0${acct.appPassword}`)}\r\n`);
    expect((await c.next()).code).toBe(334);
    expect((await c.next()).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    expect((await c.send('RCPT TO:<friend@example.com>')).code).toBe(250);
    expect((await c.data(message(acct.address))).final?.code).toBe(250);
    expect((await c.send('QUIT')).code).toBe(221);
    c.close();

    const rows = await newRow(before);
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1];
    if (row === undefined) throw new Error('no transcript row');
    expect(row.daemon).toBe('submission');
    expect(row.compressedBytes).toBeGreaterThan(0);
    const text = decompressTranscript(row);
    expectNoSecrets(text, secrets);
    expect(text).toContain('C: AUTH PLAIN\n');
    expect(text).toContain('C: [redacted]');
    // The 235 was observed before MAIL FROM was sent, so MAIL FROM is shown.
    expect(text).toContain(`C: MAIL FROM:<${acct.address}>`);

    const live = notified.slice(notifiedBefore);
    expect(live.some((p) => (JSON.parse(p) as { sessionId: string }).sessionId === row.sessionId)).toBe(true);
    for (const payload of live) expectNoSecrets(payload, secrets);
  });
});
