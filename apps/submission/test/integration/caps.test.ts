// PST-T-1.10 doneWhen: the cap+1th recipient is refused with 452, the credential is frozen, an
// alert fires once, and a later message from the frozen credential is refused at MAIL with 452
// 4.7.0. Real sockets, real TLS, a real database — same rig as PST-T-1.2's submission.test.ts.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createAlertSender, type AlertMessage, type AlertResult } from '@postroom/alerts';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { createAppPassword, hashAppPassword } from '@postroom/credentials';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCapsChecker, createCapsEnforcer } from '../../src/caps/index.js';
import { ensureDkimKeys } from '../../src/dkim.js';
import { createSubmissionListeners, type SubmissionListeners } from '../../src/server.js';
import { AuthThrottle } from '../../src/throttle.js';
import { SmtpTestClient, b64 } from './client.js';

const exec = promisify(execFile);
const baseUrl = process.env['DATABASE_URL'];
const PEPPER = 'test-pepper-0123456789abcdef';
const OPERATOR = { kind: 'system', label: 'test' } as const;
const CAP = 3;

interface Account {
  id: string;
  address: string;
  appPassword: string;
  appPasswordId: string;
  label: string;
}

describe.skipIf(baseUrl === undefined)('per-credential recipient caps (PST-T-1.10)', () => {
  let t: TestDatabase;
  let db: Db;
  let kek: Kek;
  let blobs: BlobStore;
  let dir: string;
  let listeners: SubmissionListeners;
  let port465 = 0;
  const alerts: { message: AlertMessage; result: AlertResult }[] = [];

  async function makeAccount(domain = 'd3cloud.io'): Promise<Account> {
    const login = `u${Math.random().toString(16).slice(2, 10)}`;
    const label = `caps-${login}`;
    const d = await db.domain.upsert({ where: { name: domain }, update: {}, create: { name: domain } });
    const account = await db.account.create({ data: { displayName: login, passwordHash: await hashAppPassword('correct horse battery staple', PEPPER) } });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    const created = await createAppPassword(db, OPERATOR, { accountId: account.id, label, scopes: ['smtp'] }, { pepper: PEPPER });
    return { id: account.id, address: `${login}@${domain}`, appPassword: created.password, appPasswordId: created.appPassword.id, label };
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t110_submission');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    dir = await mkdtemp(join(tmpdir(), 'pst-t110-'));
    await exec('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
    ]);
    kek = generateKek();
    blobs = createBlobStore({ root: join(dir, 'blobs'), db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');

    const relayFetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { to: string; subject: string; text: string }) : { to: '', subject: '', text: '' };
      alerts.push({ message: { subject: body.subject, text: body.text }, result: { sent: true } });
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const capsOptions = {
      db,
      hourlyDefault: 100,
      dailyDefault: CAP,
      sendAlert: createAlertSender({ url: 'https://relay.test/send', token: 'tok', to: 'ops@d3cloud.io', fetch: relayFetch }),
    };
    const checkCaps = createCapsChecker(capsOptions);
    const enforceCaps = createCapsEnforcer(capsOptions);

    listeners = createSubmissionListeners({
      db,
      hostname: 'mail.d3cloud.io',
      maxSize: 10 * 1024 * 1024,
      maxRecipients: 20,
      pepper: PEPPER,
      storage: () => ({ blobs, kek }),
      tls: { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) },
      throttle: new AuthThrottle({ baseDelayMs: 0, maxDelayMs: 0, lockoutFailures: 1000 }),
      checkCaps,
      enforceCaps,
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

  async function connect(): Promise<SmtpTestClient> {
    const c = await SmtpTestClient.implicitTls(port465);
    await c.next();
    await c.send('EHLO client.test');
    return c;
  }

  const authPlain = (c: SmtpTestClient, user: string, password: string) => c.send(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`);

  function message(from: string): string {
    return [`From: Me <${from}>`, 'To: Friend <friend@example.com>', 'Subject: hi', '', 'Hi.', ''].join('\r\n');
  }

  it('the cap+1th recipient in one message is refused with 452, freezing the credential and alerting once', async () => {
    alerts.length = 0;
    const acct = await makeAccount();
    const c = await connect();
    expect((await authPlain(c, acct.address, acct.appPassword)).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    for (const n of [1, 2, 3]) expect((await c.send(`RCPT TO:<r${String(n)}@example.com>`)).code).toBe(250);
    expect(await c.send('RCPT TO:<r4@example.com>')).toMatchObject({ code: 452, enhanced: '4.5.3' });

    const frozen = await db.appPassword.findUniqueOrThrow({ where: { id: acct.appPasswordId } });
    expect(frozen.frozenAt).not.toBeNull();

    const audit = await db.auditEvent.findFirst({ where: { action: 'app_password.freeze', entityId: acct.appPasswordId } });
    expect(audit).toMatchObject({ actorKind: 'system', actorAccountId: null });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.message.subject).toContain(acct.label);

    // The credential froze before DATA (checkCaps caught it eagerly at RCPT); the authoritative
    // check inside the accepting transaction refuses the message too — nothing queued from it.
    const before = await db.outboundRecipient.count();
    const { final } = await c.data(message(acct.address));
    expect(final).toMatchObject({ code: 452, enhanced: '4.7.0' });
    expect(await db.outboundRecipient.count()).toBe(before);

    // A later message in the same session, from the now-frozen credential, is refused at MAIL.
    expect(await c.send(`MAIL FROM:<${acct.address}>`)).toMatchObject({ code: 452, enhanced: '4.7.0' });
    c.close();
  });

  it('rolling window across messages: 3 recipients, then 1 more in a second message trips the cap', async () => {
    alerts.length = 0;
    const acct = await makeAccount();
    const c1 = await connect();
    expect((await authPlain(c1, acct.address, acct.appPassword)).code).toBe(235);
    expect((await c1.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    for (const n of [1, 2, 3]) expect((await c1.send(`RCPT TO:<w${String(n)}@example.com>`)).code).toBe(250);
    const { final } = await c1.data(message(acct.address));
    expect(final?.code).toBe(250);
    c1.close();

    const notFrozenYet = await db.appPassword.findUniqueOrThrow({ where: { id: acct.appPasswordId } });
    expect(notFrozenYet.frozenAt).toBeNull();

    const c2 = await connect();
    expect((await authPlain(c2, acct.address, acct.appPassword)).code).toBe(235);
    expect((await c2.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    expect(await c2.send('RCPT TO:<w4@example.com>')).toMatchObject({ code: 452, enhanced: '4.5.3' });
    const frozen = await db.appPassword.findUniqueOrThrow({ where: { id: acct.appPasswordId } });
    expect(frozen.frozenAt).not.toBeNull();
    expect(alerts).toHaveLength(1);
    c2.close();
  });

  // Regression for the refuted gap: createCapsChecker's plain SELECT COUNT, with no lock spanning
  // count-then-insert, let concurrent sessions each read "under cap" and both persist — the cap
  // enforced only against already-committed rows, never against what a sibling session was about to
  // commit. `enforceCaps`'s advisory-locked recount, run inside the accepting transaction itself,
  // is what a race like this cannot slip past.
  it('concurrency: five simultaneous submissions whose total exceeds the cap persist at most the cap, freeze once, alert once', async () => {
    alerts.length = 0;
    const acct = await makeAccount();

    async function attemptOneMessage(n: number): Promise<{ code: number; enhanced: string | undefined }> {
      const c = await connect();
      await authPlain(c, acct.address, acct.appPassword);
      await c.send(`MAIL FROM:<${acct.address}>`);
      for (const r of [0, 1, 2]) await c.send(`RCPT TO:<race${String(n)}-${String(r)}@example.com>`);
      const { final } = await c.data(message(acct.address));
      c.close();
      return { code: final?.code ?? 0, enhanced: final?.enhanced };
    }

    // Five sessions, each offering 3 recipients against a cap of 3: fired together so their
    // accepting transactions race for the advisory lock rather than running one after another.
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => attemptOneMessage(n)));

    const succeeded = results.filter((r) => r.code === 250);
    const refused = results.filter((r) => r.code === 452);
    expect(succeeded.length).toBeLessThanOrEqual(1); // cap 3, 3 recipients per message: at most one message fits
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused.every((r) => r.enhanced === '4.5.3' || r.enhanced === '4.7.0')).toBe(true);

    const persisted = await db.outboundRecipient.count({ where: { message: { appPasswordId: acct.appPasswordId } } });
    expect(persisted).toBeLessThanOrEqual(CAP);

    const frozen = await db.appPassword.findUniqueOrThrow({ where: { id: acct.appPasswordId } });
    expect(frozen.frozenAt).not.toBeNull();

    const audits = await db.auditEvent.findMany({ where: { action: 'app_password.freeze', entityId: acct.appPasswordId } });
    expect(audits).toHaveLength(1); // the updateMany guard means only one racer's freeze ever commits

    expect(alerts).toHaveLength(1);
  });
});
