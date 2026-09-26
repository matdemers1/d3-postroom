// PST-T-8.6, HTTP half: POST /api/mobileconfig needs a session, a fresh step-up and the CSRF
// header; it mints exactly one app password scoped imap+smtp+dav, embeds it in the profile, and
// audits both the app password's creation and the generation itself. The minted password
// authenticates over the same protocol-login path IMAP/SMTP/DAV use.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { verifyProtocolLogin } from '@postroom/credentials';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { request } from '../loopback.js';
import { PEPPER, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

function xml(node: Buffer): string {
  return node.toString('utf8');
}

/** POST /api/mobileconfig with the response buffered raw: supertest has no built-in parser for
 *  application/x-apple-aspen-config, so `res.body` would otherwise come back empty. */
function postMobileconfig(app: Express, cookie: string) {
  return request(app)
    .post('/api/mobileconfig')
    .set(CSRF)
    .set('cookie', cookie)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        cb(null, Buffer.concat(chunks));
      });
    })
    .send();
}

/** A `<key>NAME</key>` value's raw text, for the string/boolean/integer shapes this profile uses. */
function plistValue(plist: string, key: string): string | undefined {
  const match = new RegExp(`<key>${key}</key>\\s*<(string|integer)>([^<]*)</\\1>`).exec(plist);
  if (match !== null) return match[2];
  const flag = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(plist);
  return flag?.[1];
}

describe.skipIf(!baseUrl)('mobileconfig over HTTP (PST-T-8.6)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let guardMissesBefore = 0;
  let dir = '';

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const stepUp = async (cookie: string, secret: string): Promise<void> => {
    clock.advance(31_000);
    const res = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(secret, clock.now()) });
    expect(res.status).toBe(200);
  };

  const person = async (): Promise<{ id: string; login: string; address: string; cookie: string; totpSecret: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    return { id, login, address: `${login}@d3cloud.io`, cookie: await signIn(login, totpSecret), totpSecret };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t86_mobileconfig');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('needs a session, a fresh step-up, and the CSRF header', async () => {
    expect((await request(app).post('/api/mobileconfig').set(CSRF)).status).toBe(401);
    const me = await person();
    expect((await request(app).post('/api/mobileconfig').set('cookie', me.cookie).send()).status).toBe(403);
    const noStepUp = await request(app).post('/api/mobileconfig').set(CSRF).set('cookie', me.cookie).send();
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body).toEqual({ error: 'step_up_required' });
  });

  it('mints exactly one app password scoped imap+smtp+dav, embeds it, and audits both', async () => {
    const me = await person();
    await stepUp(me.cookie, me.totpSecret);
    const res = await postMobileconfig(app, me.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-apple-aspen-config');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-postroom-mobileconfig-signed']).toBe('0'); // no signing cert configured

    const plist = xml(res.body as Buffer);
    expect(plist).toContain('com.apple.mail.managed');
    expect(plist).toContain('com.apple.caldav.account');
    expect(plist).toContain('com.apple.carddav.account');
    expect(plistValue(plist, 'EmailAddress')).toBe(me.address);
    expect(plistValue(plist, 'IncomingMailServerPortNumber')).toBe('993');
    expect(plistValue(plist, 'OutgoingMailServerPortNumber')).toBe('465');
    expect(plistValue(plist, 'CalDAVPort')).toBe('443');

    const uuids = [...plist.matchAll(/<key>PayloadUUID<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
    expect(uuids).toHaveLength(4); // the profile itself + 3 payloads
    expect(new Set(uuids).size).toBe(4);

    const appPasswords = await db.appPassword.findMany({ where: { accountId: me.id } });
    expect(appPasswords).toHaveLength(1);
    expect(appPasswords[0]?.label).toMatch(/^iPhone profile \d{4}-\d{2}-\d{2}$/);
    expect(appPasswords[0]?.scopes.slice().sort()).toEqual(['dav', 'imap', 'smtp']);

    const passwordMatch = /<key>IncomingPassword<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    const embeddedPassword = passwordMatch?.[1];
    expect(embeddedPassword).toBeDefined();
    expect(await verifyProtocolLogin(db, { username: me.address, password: embeddedPassword ?? '', scope: 'imap', ip: '127.0.0.1' }, { pepper: PEPPER })).toMatchObject({ ok: true });

    const auditRows = await db.auditEvent.findMany({ where: { actorAccountId: me.id }, orderBy: { at: 'asc' } });
    expect(auditRows.map((r) => r.action)).toEqual(expect.arrayContaining(['app_password.create', 'mobileconfig.generate']));
    expect(auditRows.some((r) => r.action === 'mobileconfig.generate' && r.entityId === me.id)).toBe(true);
  });

  it('the app-passwords list shows the minted password by its name', async () => {
    const me = await person();
    await stepUp(me.cookie, me.totpSecret);
    await postMobileconfig(app, me.cookie);
    const listed = await request(app).get('/api/app-passwords').set('cookie', me.cookie);
    expect(listed.status).toBe(200);
    const list = (listed.body as { appPasswords: { label: string }[] }).appPasswords;
    expect(list).toHaveLength(1);
    expect(list[0]?.label).toMatch(/^iPhone profile \d{4}-\d{2}-\d{2}$/);
  });

  it('signs with a configured certificate, verifiable by openssl, embedding the same plist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pst-mobileconfig-sign-'));
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=Postroom Test/O=d3cloud.io'],
      { stdio: 'pipe' },
    );
    const signedApp = createApp({
      db,
      env: { MOBILECONFIG_SIGNING_CERT_FILE: join(dir, 'cert.pem'), MOBILECONFIG_SIGNING_KEY_FILE: join(dir, 'key.pem') },
      config: baseConfig(clock),
    });
    const login = randomLogin();
    const { totpSecret } = await createAccount(db, { login, password: PASSWORD });
    clock.advance(31_000);
    const first = await request(signedApp).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    const second = await request(signedApp)
      .post('/api/auth/signin/totp')
      .set(CSRF)
      .send({ challenge: (first.body as { challenge: string }).challenge, code: totpCode(totpSecret, clock.now()) });
    const cookie = cookieHeader(cookiesOf(second));
    clock.advance(31_000);
    await request(signedApp).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(totpSecret, clock.now()) });

    const res = await postMobileconfig(signedApp, cookie);
    expect(res.status).toBe(200);
    expect(res.headers['x-postroom-mobileconfig-signed']).toBe('1');

    const file = join(dir, 'p.mobileconfig');
    writeFileSync(file, res.body as Buffer);
    const recovered = execFileSync('openssl', ['smime', '-verify', '-inform', 'DER', '-noverify', '-in', file], { stdio: 'pipe' }).toString('utf8');
    expect(recovered).toContain(`<string>${login}@d3cloud.io</string>`);
    expect(readFileSync(file).length).toBeGreaterThan(0);
  });

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
