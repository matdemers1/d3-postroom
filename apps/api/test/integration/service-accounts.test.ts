// PST-T-1.12 doneWhen: a script sends via alerts@ over submission.
//
// End to end: an admin creates a service mailbox through POST /api/admin/service-accounts (admin +
// step-up, audited), mints its app password through the existing POST /api/app-passwords?accountId=
// path, then scripts/send-via-submission.mjs — the plain, dependency-free client any ecosystem app
// or the operator can copy — sends a real message over a real (self-signed) TLS submission listener
// started in-process. The per-credential recipient cap (PST-REQ-046 / PST-T-1.10) is honoured too:
// once the cap is spent, the same script's next send is refused.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createAuthThrottle } from '@postroom/auth-throttle';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek, type Kek } from '@postroom/crypto';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { ensureDkimKeys } from '@postroom/submission/dkim';
import { createCapsChecker, createCapsEnforcer } from '@postroom/submission/caps';
import { createSubmissionListeners, type SubmissionListeners } from '@postroom/submission';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, PEPPER, randomLogin, TestClock, totpCode } from './helpers.js';

const exec = promisify(execFile);
const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const SCRIPT = join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'send-via-submission.mjs');

describe.skipIf(!baseUrl)('service mailboxes over submission (PST-T-1.12)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let kek: Kek;
  let blobs: BlobStore;
  let dir: string;
  let listeners: SubmissionListeners;
  let port465 = 0;
  const clock = new TestClock();

  const signIn = async (login: string, secret: string): Promise<Record<string, string>> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookiesOf(second);
  };

  const adminSession = async (): Promise<{ id: string; cookie: string; totpSecret: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: true });
    return { id, totpSecret, cookie: cookieHeader(await signIn(login, totpSecret)) };
  };

  const stepUp = async (cookie: string, secret: string): Promise<void> => {
    clock.advance(31_000);
    const res = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(secret, clock.now()) });
    expect(res.status).toBe(200);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t112_service');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });

    dir = await mkdtemp(join(tmpdir(), 'pst-t112-'));
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ]);
    kek = generateKek();
    blobs = createBlobStore({ root: join(dir, 'blobs'), db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');

    const capsOptions = { db, hourlyDefault: 100, dailyDefault: 100 };
    listeners = createSubmissionListeners({
      db,
      hostname: 'mail.d3cloud.io',
      maxSize: 10 * 1024 * 1024,
      maxRecipients: 20,
      pepper: PEPPER,
      storage: () => ({ blobs, kek }),
      tls: { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) },
      throttle: createAuthThrottle({ db, sleep: () => Promise.resolve(), sourceCeiling: 1000 }),
      checkCaps: createCapsChecker(capsOptions),
      enforceCaps: createCapsEnforcer(capsOptions),
    });
    const s465 = listeners.submissions;
    if (s465 === null) throw new Error('465 listener missing');
    s465.listen(0, '127.0.0.1');
    await once(s465, 'listening');
    port465 = (s465.address() as AddressInfo).port;
  }, 120_000);

  afterAll(async () => {
    await listeners.close();
    await testDb.drop();
    await rm(dir, { recursive: true, force: true });
  });

  async function send(user: string, pass: string, to: string): Promise<{ stdout: string }> {
    return exec(process.execPath, [
      SCRIPT,
      '--host',
      '127.0.0.1',
      '--port',
      String(port465),
      '--user',
      user,
      '--pass',
      pass,
      '--from',
      user,
      '--to',
      to,
      '--subject',
      'Postroom alert',
      '--body',
      'A test alert from the CLI script.',
      '--insecure',
    ]);
  }

  it('creates a service mailbox, mints its app password, and sends through it (doneWhen)', async () => {
    const admin = await adminSession();
    await stepUp(admin.cookie, admin.totpSecret);

    const createdAccount = await request(app)
      .post('/api/admin/service-accounts')
      .set(CSRF)
      .set('cookie', admin.cookie)
      .send({ localPart: 'alerts', displayName: 'Postroom alerts', dailyRecipientCap: 200 });
    expect(createdAccount.status).toBe(201);
    const account = createdAccount.body as { accountId: string; address: string; displayName: string; dailyRecipientCap: number };
    expect(account.address).toBe('alerts@d3cloud.io');
    expect(account.dailyRecipientCap).toBe(200);
    expect(account).not.toHaveProperty('password');
    expect(account).not.toHaveProperty('passwordHash');

    // Default mailboxes exist, just as they would for a person.
    const mailboxes = await db.mailbox.findMany({ where: { accountId: account.accountId }, select: { name: true } });
    expect(mailboxes.map((m) => m.name).sort()).toEqual(['Archive', 'Drafts', 'INBOX', 'Junk', 'Rejects', 'Sent', 'Trash'].sort());

    const dbAccount = await db.account.findUniqueOrThrow({ where: { id: account.accountId } });
    expect(dbAccount.kind).toBe('service');
    expect(dbAccount.passwordHash).toBeNull();

    const auditRows = await db.auditEvent.findMany({ where: { entityId: account.accountId, action: 'admin.service_account.create' } });
    expect(auditRows).toHaveLength(1);

    // The app password is minted through the existing, already-tested route.
    const createdPassword = await request(app)
      .post(`/api/app-passwords?accountId=${account.accountId}`)
      .set(CSRF)
      .set('cookie', admin.cookie)
      .send({ label: 'alerts submission', scopes: ['smtp'], dailyRecipientCap: 1 });
    expect(createdPassword.status).toBe(201);
    const { password } = createdPassword.body as { password: string };

    // A script sends via alerts@ over submission.
    const { stdout } = await send(account.address, password, 'ops1@example.com');
    expect(stdout).toMatch(/^250 /);

    const stored = await db.outboundMessage.findFirst({ where: { accountId: account.accountId } });
    expect(stored).not.toBeNull();
    expect(stored?.envelopeFrom).toBe(account.address);

    // The cap (1) is now spent: the next send over the same credential is refused, not queued.
    let refused: unknown;
    try {
      await send(account.address, password, 'ops2@example.com');
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeDefined();
    expect(String((refused as { stderr?: string }).stderr)).toMatch(/452/);
    const messages = await db.outboundMessage.count({ where: { accountId: account.accountId } });
    expect(messages).toBe(1);

    const frozen = await db.appPassword.findUniqueOrThrow({ where: { id: (createdPassword.body as { id: string }).id } });
    expect(frozen.frozenAt).not.toBeNull();
  });

  it('refuses without admin, without step-up, and a taken local part', async () => {
    const nonAdminLogin = randomLogin();
    const { totpSecret } = await createAccount(db, { login: nonAdminLogin, password: PASSWORD, isAdmin: false });
    const nonAdminCookie = cookieHeader(await signIn(nonAdminLogin, totpSecret));
    expect(
      (
        await request(app)
          .post('/api/admin/service-accounts')
          .set(CSRF)
          .set('cookie', nonAdminCookie)
          .send({ localPart: 'shipyard', displayName: 'Shipyard' })
      ).status,
    ).toBe(403);

    const admin = await adminSession();
    // No step-up yet.
    expect(
      (
        await request(app)
          .post('/api/admin/service-accounts')
          .set(CSRF)
          .set('cookie', admin.cookie)
          .send({ localPart: 'shipyard', displayName: 'Shipyard' })
      ).status,
    ).toBe(403);

    await stepUp(admin.cookie, admin.totpSecret);
    const first = await request(app)
      .post('/api/admin/service-accounts')
      .set(CSRF)
      .set('cookie', admin.cookie)
      .send({ localPart: 'shipyard', displayName: 'Shipyard' });
    expect(first.status).toBe(201);

    await stepUp(admin.cookie, admin.totpSecret);
    const conflict = await request(app)
      .post('/api/admin/service-accounts')
      .set(CSRF)
      .set('cookie', admin.cookie)
      .send({ localPart: 'shipyard', displayName: 'Shipyard again' });
    expect(conflict.status).toBe(409);
  });
});
