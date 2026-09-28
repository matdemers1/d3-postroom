// PST-T-11.11 doneWhen (PST-REQ-177, PST-REQ-180): the account-wide outbound cap counts every
// sending path together. Two app passwords over real SMTP (TLS, AUTH, DATA) and the webmail's
// acceptance (the same acceptSubmission call apps/api makes, with its own webmail cap) share one
// account's window; so do Sieve vacation replies. Over it: 452 4.5.3 naming the account, nothing
// queued, nothing frozen. The operator is alerted once per window — even though the SMTP daemon and
// the "webmail" here are two separate alert senders (as the three daemons are), because the
// once-only marker is a durable audit row, not an in-process flag. 'e2e-seed' alone is exempt.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { createAlertSender, type SendAlert } from '@postroom/alerts';
import { createAuthThrottle } from '@postroom/auth-throttle';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { createAppPassword, hashAppPassword } from '@postroom/credentials';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptSubmission, type AcceptOutcome, type EnforceSubmitterCaps } from '../../src/accept.js';
import { ACCOUNT_CAP_AUDIT_ACTION, createCapsEnforcer, createWebmailCapsEnforcer, type AccountCap } from '../../src/caps/index.js';
import { ensureDkimKeys } from '../../src/dkim.js';
import { createSubmissionListeners, type SubmissionListeners } from '../../src/server.js';
import { SmtpTestClient, b64 } from './client.js';

const exec = promisify(execFile);
const baseUrl = process.env['DATABASE_URL'];
const PEPPER = 'test-pepper-0123456789abcdef';
const OPERATOR = { kind: 'system', label: 'test' } as const;
const DOMAIN = 'd3cloud.io';
/** The account cap for the SMTP daemon and the webmail alike (per-credential and webmail caps stay far above it). */
const HOURLY = 6;

describe.skipIf(baseUrl === undefined)('account-wide outbound cap (PST-T-11.11, PST-REQ-177, PST-REQ-180)', () => {
  let t: TestDatabase;
  let db: Db;
  let kek: Kek;
  let blobs: BlobStore;
  let dir: string;
  let listeners: SubmissionListeners;
  let port465 = 0;
  /** Every alert that reached the relay, from any sender. */
  const relayed: { subject: string; text: string }[] = [];
  const relayFetch = (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { subject: string; text: string }) : { subject: '', text: '' };
    relayed.push({ subject: body.subject, text: body.text });
    return Promise.resolve(new Response(null, { status: 200 }));
  };
  /** A separate alert sender per "daemon": each has its own in-memory dedupe, as the real three do. */
  const newSender = (): SendAlert => createAlertSender({ url: 'https://relay.test/send', token: 'tok', to: 'ops@d3cloud.io', fetch: relayFetch });
  const smtpCap: AccountCap = { hourly: HOURLY, daily: 1000, sendAlert: newSender() };
  const webmailCap: AccountCap = { hourly: HOURLY, daily: 1000, sendAlert: newSender() };
  const accountAlerts = (): { subject: string; text: string }[] => relayed.filter((a) => a.subject.includes('account outbound cap'));

  interface Account {
    id: string;
    address: string;
    passwords: { password: string; id: string }[];
  }

  async function makeAccount(appPasswords: number): Promise<Account> {
    const login = `u${Math.random().toString(16).slice(2, 10)}`;
    const d = await db.domain.upsert({ where: { name: DOMAIN }, update: {}, create: { name: DOMAIN } });
    const account = await db.account.create({ data: { displayName: login, passwordHash: await hashAppPassword('correct horse battery staple', PEPPER) } });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    const passwords: { password: string; id: string }[] = [];
    for (let i = 0; i < appPasswords; i++) {
      const created = await createAppPassword(db, OPERATOR, { accountId: account.id, label: `${login}-${String(i)}`, scopes: ['smtp'] }, { pepper: PEPPER });
      passwords.push({ password: created.password, id: created.appPassword.id });
    }
    return { id: account.id, address: `${login}@${DOMAIN}`, passwords };
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1111_submission');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: DOMAIN });
    dir = await mkdtemp(join(tmpdir(), 'pst-t1111-'));
    await exec('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
    ]);
    kek = generateKek();
    blobs = createBlobStore({ root: join(dir, 'blobs'), db, kek });
    await ensureDkimKeys(db, kek, DOMAIN);

    listeners = createSubmissionListeners({
      db,
      hostname: 'mail.d3cloud.io',
      maxSize: 10 * 1024 * 1024,
      maxRecipients: 20,
      pepper: PEPPER,
      storage: () => ({ blobs, kek }),
      tls: { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) },
      throttle: createAuthThrottle({ db, sleep: () => Promise.resolve(), sourceCeiling: 1000 }),
      // The per-credential cap stays in force, far above the account's.
      enforceCaps: createCapsEnforcer({ db, hourlyDefault: 100, dailyDefault: 500, sendAlert: newSender() }),
      accountCap: smtpCap,
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

  function message(from: string, to: readonly string[]): string {
    return [`From: Me <${from}>`, `To: ${to.join(', ')}`, `Subject: hi ${randomUUID()}`, '', 'Hi.', ''].join('\r\n');
  }

  /** One message over SMTP (465, AUTH PLAIN with one app password); the DATA reply. */
  async function smtpSend(acct: Account, which: number, to: readonly string[]): Promise<{ code: number; enhanced: string | undefined; lines: readonly string[] }> {
    const c = await SmtpTestClient.implicitTls(port465);
    try {
      await c.next();
      await c.send('EHLO client.test');
      const ap = acct.passwords[which];
      if (ap === undefined) throw new Error('no such app password');
      expect((await c.send(`AUTH PLAIN ${b64(`\0${acct.address}\0${ap.password}`)}`)).code).toBe(235);
      expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
      for (const r of to) expect((await c.send(`RCPT TO:<${r}>`)).code).toBe(250);
      const { final } = await c.data(message(acct.address, to));
      return { code: final?.code ?? 0, enhanced: final?.enhanced, lines: final?.lines ?? [] };
    } finally {
      c.close();
    }
  }

  /** One acceptance as another path would make it: the webmail (with its own cap), a vacation reply, the e2e seed. */
  async function directSend(acct: Account, submittedVia: string, to: readonly string[], cap: AccountCap = webmailCap, now: () => Date = () => new Date()): Promise<AcceptOutcome> {
    const webmailCaps = createWebmailCapsEnforcer({ db, hourlyDefault: 100, dailyDefault: 500 });
    const enforceCaps: EnforceSubmitterCaps = submittedVia === 'webmail' ? (tx, recipients, at) => webmailCaps(tx, acct.id, recipients, at) : () => Promise.resolve();
    return acceptSubmission(
      Readable.from([Buffer.from(message(acct.address, to), 'latin1')]),
      {
        submitter: { accountId: acct.id, addresses: new Set([acct.address]) },
        envelopeFrom: submittedVia === 'sieve-vacation' ? '' : acct.address,
        recipients: to.map((address) => ({ address })),
        sessionId: randomUUID(),
        submittedVia,
        enforceCaps,
        auditContext: { requestId: randomUUID(), ip: null },
      },
      { db, storage: () => ({ blobs, kek }), now, log: () => undefined, accountCap: cap },
    );
  }

  const queuedFor = (accountId: string): Promise<number> => db.outboundRecipient.count({ where: { message: { accountId } } });

  it('two app passwords, the webmail and a vacation reply share one window; over it every path is refused, nothing frozen, one alert', async () => {
    relayed.length = 0;
    const acct = await makeAccount(2);

    // Under the cap, from every path: 2 + 2 + 1 + 1 = 6 = HOURLY.
    expect((await smtpSend(acct, 0, ['a1@example.com', 'a2@example.com'])).code).toBe(250);
    expect((await smtpSend(acct, 1, ['b1@example.com', 'b2@example.com'])).code).toBe(250);
    expect((await directSend(acct, 'webmail', ['w1@example.com'])).ok).toBe(true);
    expect((await directSend(acct, 'sieve-vacation', ['v1@example.com'])).ok).toBe(true);
    expect(await queuedFor(acct.id)).toBe(HOURLY);
    expect(accountAlerts()).toHaveLength(0);

    // Over it, from SMTP: 452 4.5.3 naming the account, not the credential.
    const over = await smtpSend(acct, 0, ['a3@example.com']);
    expect(over).toMatchObject({ code: 452, enhanced: '4.5.3' });
    expect(over.lines.join(' ')).toMatch(/for this account/);
    expect(accountAlerts()).toHaveLength(1);
    expect(accountAlerts()[0]?.text).toContain(acct.id);

    // …from the other app password, the webmail (another daemon, another alert sender) and a vacation reply.
    expect(await smtpSend(acct, 1, ['b3@example.com'])).toMatchObject({ code: 452, enhanced: '4.5.3' });
    const web = await directSend(acct, 'webmail', ['w2@example.com']);
    expect(web).toMatchObject({ ok: false, reason: 'account-cap', reply: { code: 452, enhanced: '4.5.3' } });
    const vacation = await directSend(acct, 'sieve-vacation', ['v2@example.com']);
    expect(vacation).toMatchObject({ ok: false, reason: 'account-cap' });

    // Nothing queued past the cap; nothing frozen; one alert, one marker, for the whole window.
    expect(await queuedFor(acct.id)).toBe(HOURLY);
    const frozen = await db.appPassword.findMany({ where: { accountId: acct.id, frozenAt: { not: null } } });
    expect(frozen).toHaveLength(0);
    expect(accountAlerts()).toHaveLength(1);
    const markers = await db.auditEvent.findMany({ where: { action: ACCOUNT_CAP_AUDIT_ACTION, entityId: acct.id } });
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ actorKind: 'system', entityType: 'account', after: expect.objectContaining({ window: 'hourly', limit: HOURLY }) as unknown });

    // The e2e seeding route is not a sending path: exempt.
    expect((await directSend(acct, 'e2e-seed', ['seed@example.com'])).ok).toBe(true);
  });

  it('concurrent sends from two app passwords and the webmail never land the account over its cap, and alert once', async () => {
    relayed.length = 0;
    const acct = await makeAccount(2);
    // Nine sends of one recipient each, fired together, against a cap of six.
    const results = await Promise.all([
      ...[0, 1, 2].map((n) => smtpSend(acct, 0, [`ra${String(n)}@example.com`]).then((r) => r.code === 250)),
      ...[0, 1, 2].map((n) => smtpSend(acct, 1, [`rb${String(n)}@example.com`]).then((r) => r.code === 250)),
      ...[0, 1, 2].map((n) => directSend(acct, 'webmail', [`rw${String(n)}@example.com`]).then((r) => r.ok)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(HOURLY);
    expect(await queuedFor(acct.id)).toBe(HOURLY);
    expect(accountAlerts()).toHaveLength(1);
  });

  it('reaching the daily cap after the hourly one alerts again, once', async () => {
    relayed.length = 0;
    const acct = await makeAccount(1);
    const cap: AccountCap = { hourly: 2, daily: 3, sendAlert: newSender() };
    expect((await directSend(acct, 'webmail', ['d1@example.com', 'd2@example.com'], cap)).ok).toBe(true);
    expect(await directSend(acct, 'webmail', ['d3@example.com'], cap)).toMatchObject({ ok: false, reason: 'account-cap' }); // hourly
    expect(accountAlerts()).toHaveLength(1);
    // Two hours on: the hour is clear, the day is not.
    const later = (): Date => new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await directSend(acct, 'webmail', ['d4@example.com', 'd5@example.com'], cap, later)).toMatchObject({ ok: false, reason: 'account-cap' }); // daily
    expect(await directSend(acct, 'webmail', ['d6@example.com', 'd7@example.com'], cap, later)).toMatchObject({ ok: false, reason: 'account-cap' });
    expect(accountAlerts()).toHaveLength(2);
    const windows = (await db.auditEvent.findMany({ where: { action: ACCOUNT_CAP_AUDIT_ACTION, entityId: acct.id }, orderBy: { at: 'asc' } })).map((e) => (e.after as { window: string }).window);
    expect(windows).toEqual(['hourly', 'daily']);
  });
});
