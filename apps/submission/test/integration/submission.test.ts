// PST-T-1.2 doneWhen at the protocol level, over real loopback sockets with real TLS: submission on
// 587 (STARTTLS) and 465 (implicit TLS) with an app password; spoofed senders get 553; the account
// password is refused; the stored message carries two DKIM signatures that verify; and 250 is only
// sent after the commit. (Thunderbird over the tailnet is the manual check that follows deploy.)
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { KeyObject } from 'node:crypto';
import { publicKeyFromDnsRecord, verifyLocal } from '@postroom/auth-checks';
import { createBlobStore, tmpDir, type BlobStore } from '@postroom/blobstore';
import { createAppPassword, hashAppPassword, revokeAppPassword } from '@postroom/credentials';
import { createAuthThrottle } from '@postroom/auth-throttle';
import { generateKek, type Kek } from '@postroom/crypto';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureDkimKeys } from '../../src/dkim.js';
import { createSubmissionListeners, type SubmissionListeners } from '../../src/server.js';
import { SmtpTestClient, b64 } from './client.js';

const exec = promisify(execFile);
const baseUrl = process.env['DATABASE_URL'];
const PEPPER = 'test-pepper-0123456789abcdef';
const OPERATOR = { kind: 'system', label: 'test' } as const;
const WEB_PASSWORD = 'correct horse battery staple';

interface Account {
  id: string;
  address: string;
  appPassword: string;
  appPasswordId: string;
}

describe.skipIf(baseUrl === undefined)('submission daemon (PST-T-1.2)', () => {
  let t: TestDatabase;
  let db: Db;
  let kek: Kek;
  let blobs: BlobStore;
  let dir: string;
  let listeners: SubmissionListeners;
  let port587 = 0;
  let port465 = 0;
  let failBeforeCommit = false;
  const logs: { event: string; fields: Record<string, unknown> }[] = [];

  async function makeAccount(domain = 'd3cloud.io'): Promise<Account> {
    const login = `u${Math.random().toString(16).slice(2, 10)}`;
    const d = await db.domain.upsert({ where: { name: domain }, update: {}, create: { name: domain } });
    const account = await db.account.create({
      // Hashed exactly like a web password (Argon2id + pepper). Only the web login may use it.
      data: { displayName: login, passwordHash: await hashAppPassword(WEB_PASSWORD, PEPPER) },
    });
    await db.address.create({ data: { localPart: login, domainId: d.id, kind: AddressKind.primary, accountId: account.id } });
    const created = await createAppPassword(db, OPERATOR, { accountId: account.id, label: 'Thunderbird', scopes: ['smtp'] }, { pepper: PEPPER });
    return { id: account.id, address: `${login}@${domain}`, appPassword: created.password, appPasswordId: created.appPassword.id };
  }

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t12');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    dir = await mkdtemp(join(tmpdir(), 'pst-t12-'));
    await exec('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
    ]);
    kek = generateKek();
    blobs = createBlobStore({ root: join(dir, 'blobs'), db, kek });
    await ensureDkimKeys(db, kek, 'd3cloud.io');
    listeners = createSubmissionListeners({
      db,
      hostname: 'mail.d3cloud.io',
      maxSize: 10 * 1024 * 1024,
      maxRecipients: 3,
      pepper: PEPPER,
      storage: () => ({ blobs, kek }),
      tls: { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) },
      throttle: createAuthThrottle({ db, sleep: () => Promise.resolve(), sourceCeiling: 1000 }),
      log: (event, fields = {}) => logs.push({ event, fields }),
      faults: {
        beforeCommit: () => {
          if (failBeforeCommit) {
            failBeforeCommit = false;
            return Promise.reject(new Error('injected failure before commit'));
          }
          return Promise.resolve();
        },
      },
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
    await t.drop();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    failBeforeCommit = false;
  });

  /** 587: greet, EHLO, STARTTLS, EHLO again. */
  async function over587(): Promise<SmtpTestClient> {
    const c = await SmtpTestClient.plain(port587);
    expect((await c.next()).code).toBe(220);
    const ehlo = await c.send('EHLO client.test');
    expect(ehlo.lines).toContain('STARTTLS');
    expect(ehlo.lines.some((l) => l.startsWith('AUTH'))).toBe(false); // not before TLS
    expect((await c.startTls()).code).toBe(220);
    expect(c.encrypted).toBe(true);
    const ehlo2 = await c.send('EHLO client.test');
    expect(ehlo2.lines).toEqual(expect.arrayContaining(['AUTH PLAIN LOGIN', 'SIZE 10485760', '8BITMIME', 'SMTPUTF8', 'ENHANCEDSTATUSCODES', 'PIPELINING', 'DSN']));
    return c;
  }

  async function over465(): Promise<SmtpTestClient> {
    const c = await SmtpTestClient.implicitTls(port465);
    expect(c.encrypted).toBe(true);
    expect((await c.next()).code).toBe(220);
    const ehlo = await c.send('EHLO client.test');
    expect(ehlo.lines).toContain('AUTH PLAIN LOGIN');
    expect(ehlo.lines).not.toContain('STARTTLS');
    return c;
  }

  const authPlain = (c: SmtpTestClient, user: string, password: string) => c.send(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`);

  function message(from: string, extra = ''): string {
    const head = [`From: Me <${from}>`, 'To: Friend <friend@example.com>', 'Subject: hello over submission', ...(extra === '' ? [] : [extra])];
    return [...head, '', 'Hi there.', '.leading dot line', ''].join('\r\n');
  }

  async function outboundCount(): Promise<number> {
    return db.outboundMessage.count();
  }

  async function publicKeys(domain: string): Promise<Map<string, KeyObject>> {
    const rows = await db.dkimKey.findMany({ where: { domain: { name: domain } } });
    return new Map(rows.map((r) => [r.selector, publicKeyFromDnsRecord(r.dnsRecord).publicKey]));
  }

  async function expectSignedAndQueued(outboundId: string, account: Account): Promise<Buffer> {
    const msg = await db.outboundMessage.findUniqueOrThrow({ where: { id: outboundId }, include: { recipients: true } });
    expect(msg).toMatchObject({ accountId: account.id, appPasswordId: account.appPasswordId, envelopeFrom: account.address, headerFrom: account.address, submittedVia: 'submission', subject: 'hello over submission' });
    expect(msg.recipients.map((r) => r.address)).toEqual(['friend@example.com']);
    const jobs = await db.job.findMany({ where: { queue: 'outbound' } });
    expect(jobs.some((j) => (j.payload as { messageId?: string }).messageId === outboundId)).toBe(true);
    const audit = await db.auditEvent.findFirst({ where: { action: 'submission.accept', entityId: outboundId } });
    expect(audit?.actorAccountId).toBe(account.id);

    const stored = await blobs.getBuffer(msg.blobSha256);
    const text = stored.toString('latin1');
    // Two DKIM-Signature fields on top: Ed25519, then RSA.
    const sigs = text.split('\r\n').filter((l) => l.startsWith('DKIM-Signature:'));
    expect(sigs).toHaveLength(2);
    expect(text.startsWith('DKIM-Signature: v=1; a=ed25519-sha256;')).toBe(true);
    expect(sigs[1]).toContain('a=rsa-sha256;');
    const results = await verifyLocal(stored, await publicKeys('d3cloud.io'));
    expect(results.map((r) => [r.algorithm, r.result])).toEqual([
      ['ed25519-sha256', 'pass'],
      ['rsa-sha256', 'pass'],
    ]);
    expect(msg.size).toBe(stored.length);
    return stored;
  }

  it('587: EHLO → STARTTLS → EHLO → AUTH PLAIN (app password) → MAIL/RCPT/DATA → 250, queued and DKIM-signed', async () => {
    const acct = await makeAccount();
    const c = await over587();
    expect(await authPlain(c, acct.address, acct.appPassword)).toMatchObject({ code: 235, enhanced: '2.7.0' });
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    expect((await c.send('RCPT TO:<friend@example.com> NOTIFY=FAILURE,DELAY')).code).toBe(250);
    const { final } = await c.data(message(acct.address));
    expect(final).toMatchObject({ code: 250, enhanced: '2.0.0' });
    const id = /Queued as ([0-9a-f-]{36})/.exec(final?.lines[0] ?? '')?.[1] ?? '';
    const stored = await expectSignedAndQueued(id, acct);
    expect(stored.toString('latin1')).toContain('\r\n\r\nHi there.\r\n.leading dot line\r\n'); // dot-unstuffed
    const rcpt = await db.outboundRecipient.findFirstOrThrow({ where: { outboundMessageId: id } });
    expect(rcpt.dsnNotify).toBe('FAILURE,DELAY');
    c.close();
  });

  it('465: implicit TLS, AUTH LOGIN, same flow → 250', async () => {
    const acct = await makeAccount();
    const c = await over465();
    expect((await c.send('AUTH LOGIN')).code).toBe(334);
    expect((await c.send(b64(acct.address))).code).toBe(334);
    expect((await c.send(b64(acct.appPassword))).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${acct.address.toUpperCase()}>`)).code).toBe(250);
    expect((await c.send('RCPT TO:<friend@example.com>')).code).toBe(250);
    const { final } = await c.data(message(acct.address));
    expect(final?.code).toBe(250);
    const id = /Queued as ([0-9a-f-]{36})/.exec(final?.lines[0] ?? '')?.[1] ?? '';
    const msg = await db.outboundMessage.findUniqueOrThrow({ where: { id } });
    expect(msg.envelopeFrom).toBe(acct.address.toUpperCase());
    await expect(blobs.verify(msg.blobSha256)).resolves.toBe(true);
    c.close();
  });

  it('AUTH on plaintext 587 before STARTTLS → 538; MAIL before AUTH → 530 (no relay)', async () => {
    const acct = await makeAccount();
    const c = await SmtpTestClient.plain(port587);
    await c.next();
    await c.send('EHLO client.test');
    expect(await authPlain(c, acct.address, acct.appPassword)).toMatchObject({ code: 538 });
    expect(await c.send(`MAIL FROM:<${acct.address}>`)).toMatchObject({ code: 530, enhanced: '5.7.0' });
    expect(await c.send('RCPT TO:<friend@example.com>')).toMatchObject({ code: 503 });
    c.close();

    // Over TLS too: no AUTH, no MAIL.
    const s = await over465();
    expect(await s.send(`MAIL FROM:<${acct.address}>`)).toMatchObject({ code: 530, enhanced: '5.7.0' });
    expect(await s.send('MAIL FROM:<>')).toMatchObject({ code: 530 });
    s.close();
  });

  it('the account web password → 535; a revoked app password → 535; nothing about the password is logged', async () => {
    const acct = await makeAccount();
    const c = await over465();
    expect(await authPlain(c, acct.address, WEB_PASSWORD)).toMatchObject({ code: 535, enhanced: '5.7.8' });
    c.close();

    await revokeAppPassword(db, OPERATOR, { id: acct.appPasswordId });
    const r = await over587();
    expect(await authPlain(r, acct.address, acct.appPassword)).toMatchObject({ code: 535, enhanced: '5.7.8' });
    r.close();

    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(WEB_PASSWORD);
    expect(serialized).not.toContain(acct.appPassword);
    expect(logs.some((l) => l.event === 'auth' && l.fields['reason'] === 'revoked')).toBe(true);
  });

  it('PST-REQ-075: an AUTH failure is an auth.failure audit row through the shared throttle, with no password', async () => {
    const acct = await makeAccount();
    const c = await over465();
    expect(await authPlain(c, acct.address, WEB_PASSWORD)).toMatchObject({ code: 535, enhanced: '5.7.8' });
    c.close();
    const rows = await db.auditEvent.findMany({ where: { action: 'auth.failure', entityId: acct.address.toLowerCase() } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: 'anonymous',
      entityType: 'credential',
      ip: '127.0.0.1',
      after: { protocol: 'submission', username: acct.address.toLowerCase(), reason: 'bad_password' },
    });
    expect(JSON.stringify(rows)).not.toContain(WEB_PASSWORD);
  });

  it('spoofed MAIL FROM someone@gmail.com → 553; <> → 553', async () => {
    const acct = await makeAccount();
    const c = await over465();
    expect((await authPlain(c, acct.address, acct.appPassword)).code).toBe(235);
    expect(await c.send('MAIL FROM:<someone@gmail.com>')).toMatchObject({ code: 553, enhanced: '5.7.1' });
    expect(await c.send('MAIL FROM:<>')).toMatchObject({ code: 553, enhanced: '5.7.1' });
    c.close();
  });

  it('own MAIL FROM but From: someone@gmail.com → 553 after DATA, nothing queued', async () => {
    const acct = await makeAccount();
    const before = await outboundCount();
    const c = await over587();
    expect((await authPlain(c, acct.address, acct.appPassword)).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    expect((await c.send('RCPT TO:<friend@example.com>')).code).toBe(250);
    const { start, final } = await c.data(message('someone@gmail.com'));
    expect(start.code).toBe(354);
    expect(final).toMatchObject({ code: 553, enhanced: '5.7.1' });
    expect(await outboundCount()).toBe(before);
    // The session is still usable: RSET-free, a new transaction works.
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    c.close();
  });

  it('strips Bcc, adds a missing Message-ID and Date', async () => {
    const acct = await makeAccount();
    const c = await over465();
    expect((await authPlain(c, acct.address, acct.appPassword)).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    expect((await c.send('RCPT TO:<friend@example.com>')).code).toBe(250);
    expect((await c.send('RCPT TO:<hidden@example.org>')).code).toBe(250);
    const { final } = await c.data(message(acct.address, 'Bcc: hidden@example.org'));
    expect(final?.code).toBe(250);
    const id = /Queued as ([0-9a-f-]{36})/.exec(final?.lines[0] ?? '')?.[1] ?? '';
    const msg = await db.outboundMessage.findUniqueOrThrow({ where: { id }, include: { recipients: true } });
    expect(msg.recipients.map((r) => r.address).sort()).toEqual(['friend@example.com', 'hidden@example.org']);
    const text = (await blobs.getBuffer(msg.blobSha256)).toString('latin1');
    expect(text).not.toMatch(/^bcc:/im);
    expect(text).not.toContain('hidden@example.org');
    expect(msg.messageId).toMatch(/^<[0-9a-f-]{36}@d3cloud\.io>$/);
    expect(text).toContain(`\r\nMessage-ID: ${msg.messageId ?? ''}\r\n`);
    expect(text).toMatch(/\r\nDate: \w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d \+0000\r\n/);
    c.close();
  });

  it('caps recipients per message → 452 4.5.3', async () => {
    const acct = await makeAccount();
    const c = await over465();
    expect((await authPlain(c, acct.address, acct.appPassword)).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    for (const n of [1, 2, 3]) expect((await c.send(`RCPT TO:<r${String(n)}@example.com>`)).code).toBe(250);
    expect(await c.send('RCPT TO:<r4@example.com>')).toMatchObject({ code: 452, enhanced: '4.5.3' });
    c.close();
  });

  it('no DKIM keys for the domain → 451 and nothing queued; after ensureDkimKeys → 250', async () => {
    const acct = await makeAccount('second.test');
    const c = await over465();
    expect((await authPlain(c, acct.address, acct.appPassword)).code).toBe(235);
    const attempt = async () => {
      expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
      expect((await c.send('RCPT TO:<friend@example.com>')).code).toBe(250);
      return (await c.data(message(acct.address))).final;
    };
    const before = await outboundCount();
    expect(await attempt()).toMatchObject({ code: 451, enhanced: '4.3.5' });
    expect(await outboundCount()).toBe(before);

    const keys = await ensureDkimKeys(db, kek, 'second.test');
    expect(keys.map((k) => [k.algorithm, k.created])).toEqual([
      ['ed25519-sha256', true],
      ['rsa-sha256', true],
    ]);
    expect(keys[0]?.dnsName).toMatch(/^pr\d{6}e\._domainkey\.second\.test$/);
    expect((await ensureDkimKeys(db, kek, 'second.test')).every((k) => !k.created)).toBe(true);
    expect(await db.auditEvent.count({ where: { action: 'dkim_key.create' } })).toBe(4);

    const ok = await attempt();
    expect(ok?.code).toBe(250);
    const id = /Queued as ([0-9a-f-]{36})/.exec(ok?.lines[0] ?? '')?.[1] ?? '';
    const msg = await db.outboundMessage.findUniqueOrThrow({ where: { id } });
    const results = await verifyLocal(await blobs.getBuffer(msg.blobSha256), await publicKeys('second.test'));
    expect(results.map((r) => [r.domain, r.result])).toEqual([
      ['second.test', 'pass'],
      ['second.test', 'pass'],
    ]);
    c.close();
  });

  it('crash safety: a failure inside the accepting transaction → 451, no rows, the final blob is an orphan gc removes', async () => {
    const acct = await makeAccount();
    const counts = async () => ({
      outbound: await db.outboundMessage.count(),
      recipients: await db.outboundRecipient.count(),
      jobs: await db.job.count(),
      blobs: await db.blob.count(),
      accepts: await db.auditEvent.count({ where: { action: 'submission.accept' } }),
    });
    const before = await counts();
    const c = await over587();
    expect((await authPlain(c, acct.address, acct.appPassword)).code).toBe(235);
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    expect((await c.send('RCPT TO:<friend@example.com>')).code).toBe(250);
    failBeforeCommit = true;
    const { final } = await c.data(message(acct.address, 'X-Crash: yes'));
    expect(final).toMatchObject({ code: 451, enhanced: '4.3.0' });
    expect(await counts()).toEqual(before);
    expect(logs.some((l) => l.event === 'data-error' && String(l.fields['error']).includes('injected failure'))).toBe(true);

    // No spool left behind; the placed-then-rolled-back final blob file is an orphan for gc.
    expect((await readdir(tmpDir(blobs.root))).filter((f) => f.endsWith('.spool.tmp'))).toEqual([]);
    const gc = await blobs.gc({ olderThanMs: 0, now: Date.now() + 1000 });
    expect(gc.orphans).toBe(1);

    // And the next message on the same session goes through.
    expect((await c.send(`MAIL FROM:<${acct.address}>`)).code).toBe(250);
    expect((await c.send('RCPT TO:<friend@example.com>')).code).toBe(250);
    expect((await c.data(message(acct.address, 'X-Crash: no'))).final?.code).toBe(250);
    c.close();
  });
});
