// PST-T-16.16 (PST-DA-039, PST-REQ-139): the iPhone's one-time profile URL. Creating one needs a
// session, step-up and CSRF; opening it needs nothing (the phone has no session), mints exactly one
// app password and returns the profile — once. A second open, an expired link and a forged one all
// answer the same 410. Two racing opens produce one profile. The link's status reports the minted
// password's first use, and only to its owner. The token is never written to the audit log.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { verifyProtocolLogin } from '@postroom/credentials';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { LINK_TTL_MS } from '../../src/mobileconfig/link.js';
import { request } from '../loopback.js';
import { PEPPER, TestClock, WEB_ORIGIN, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

interface Link {
  url: string;
  linkId: string;
  expiresAt: string;
}

interface LinkStatus {
  redeemed: boolean;
  appPasswordId: string | null;
  lastUsedAt: string | null;
}

/** GET a one-time URL with the body buffered raw (the profile is not JSON). No cookie, ever. */
function open(app: Express, path: string) {
  return request(app)
    .get(path)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        cb(null, Buffer.concat(chunks));
      });
    });
}

describe.skipIf(!baseUrl)('one-time profile links (PST-T-16.16)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let guardMissesBefore = 0;

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

  const person = async (): Promise<{ id: string; address: string; cookie: string; totpSecret: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    return { id, address: `${login}@d3cloud.io`, cookie: await signIn(login, totpSecret), totpSecret };
  };

  const createLink = async (me: { cookie: string; totpSecret: string }): Promise<Link> => {
    await stepUp(me.cookie, me.totpSecret);
    const res = await request(app).post('/api/mobileconfig/links').set(CSRF).set('cookie', me.cookie).send();
    expect(res.status).toBe(201);
    return res.body as Link;
  };

  /** The path part of a link's URL: the test server is not at WEB_ORIGIN. */
  const pathOf = (link: Link): string => {
    const url = new URL(link.url);
    expect(url.origin).toBe(new URL(WEB_ORIGIN).origin);
    return url.pathname;
  };

  const status = async (cookie: string, linkId: string) => request(app).get(`/api/mobileconfig/links/${linkId}`).set('cookie', cookie);

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t1616_mobileconfig_link');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('creating a link needs a session, the CSRF header and a fresh step-up', async () => {
    expect((await request(app).post('/api/mobileconfig/links').set(CSRF).send()).status).toBe(401);
    const me = await person();
    expect((await request(app).post('/api/mobileconfig/links').set('cookie', me.cookie).send()).status).toBe(403);
    const noStepUp = await request(app).post('/api/mobileconfig/links').set(CSRF).set('cookie', me.cookie).send();
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body).toEqual({ error: 'step_up_required' });
  });

  it('create → open without a session → 200 with the profile → open again → 410', async () => {
    const me = await person();
    const link = await createLink(me);
    expect(link.url).toMatch(/\/api\/mobileconfig\/once\/[A-Za-z0-9_-]{98}$/);
    expect(link.linkId).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(link.expiresAt).getTime() - clock.now().getTime()).toBeLessThanOrEqual(LINK_TTL_MS);
    // Nothing is minted until the phone opens it.
    expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(0);
    expect(((await status(me.cookie, link.linkId)).body as LinkStatus).redeemed).toBe(false);

    const first = await open(app, pathOf(link));
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toContain('application/x-apple-aspen-config');
    expect(first.headers['cache-control']).toBe('no-store');
    const plist = (first.body as Buffer).toString('utf8');
    expect(plist).toContain(`<string>${me.address}</string>`);
    const minted = await db.appPassword.findMany({ where: { accountId: me.id } });
    expect(minted).toHaveLength(1);
    expect(minted[0]?.scopes.slice().sort()).toEqual(['dav', 'imap', 'smtp']);
    expect(first.headers['x-postroom-app-password-id']).toBe(minted[0]?.id);

    const second = await open(app, pathOf(link));
    expect(second.status).toBe(410);
    expect(second.headers['content-type']).toContain('text/plain');
    // Spent means spent: no second password, however often it is opened.
    expect((await open(app, pathOf(link))).status).toBe(410);
    expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(1);
  });

  it('an expired link answers 410, the same as a spent one, and mints nothing', async () => {
    const me = await person();
    const spent = await createLink(me);
    await open(app, pathOf(spent));
    const spentAnswer = await open(app, pathOf(spent));

    const link = await createLink(me);
    clock.advance(LINK_TTL_MS + 1_000);
    const expired = await open(app, pathOf(link));
    expect(expired.status).toBe(410);
    expect((expired.body as Buffer).toString('utf8')).toBe((spentAnswer.body as Buffer).toString('utf8'));
    expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(1);
  });

  it('a forged or malformed token answers the same 410', async () => {
    const me = await person();
    const link = await createLink(me);
    const path = pathOf(link);
    // A character mid-token (the last one is partly base64 padding bits, so changing it may not
    // change a byte at all).
    const at = path.length - 40;
    const swapped = path[at] === 'A' ? 'B' : 'A';
    const forged = await open(app, `${path.slice(0, at)}${swapped}${path.slice(at + 1)}`);
    expect(forged.status).toBe(410);
    expect((await open(app, '/api/mobileconfig/once/not-a-token')).status).toBe(410);
    // The real one still works afterwards: a bad guess does not spend someone else's link.
    expect((await open(app, path)).status).toBe(200);
  });

  it('a HEAD (a link preview) never spends the link', async () => {
    const me = await person();
    const link = await createLink(me);
    expect((await request(app).head(pathOf(link))).status).toBe(405);
    expect((await open(app, pathOf(link))).status).toBe(200);
  });

  it('two racing opens produce exactly one profile', async () => {
    const me = await person();
    const link = await createLink(me);
    const results = await Promise.all([open(app, pathOf(link)), open(app, pathOf(link)), open(app, pathOf(link))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410, 410]);
    expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(1);
  });

  it('the status reports the minted password and its first use, to its owner only', async () => {
    const me = await person();
    const other = await person();
    const link = await createLink(me);
    const res = await open(app, pathOf(link));
    const plist = (res.body as Buffer).toString('utf8');

    const before = (await status(me.cookie, link.linkId)).body as LinkStatus;
    expect(before.redeemed).toBe(true);
    expect(before.appPasswordId).toBe(res.headers['x-postroom-app-password-id']);
    expect(before.lastUsedAt).toBeNull();

    const password = /<key>IncomingPassword<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? '';
    expect(await verifyProtocolLogin(db, { username: me.address, password, scope: 'imap', ip: '127.0.0.1' }, { pepper: PEPPER })).toMatchObject({ ok: true });
    const after = (await status(me.cookie, link.linkId)).body as LinkStatus;
    expect(after.lastUsedAt).not.toBeNull();

    expect((await status(other.cookie, link.linkId)).status).toBe(404);
    expect((await status(me.cookie, '0'.repeat(64))).status).toBe(404);
    expect((await status(me.cookie, 'nope')).status).toBe(404);
  });

  it('audits create and redeem by link id, and never writes the token', async () => {
    const me = await person();
    const link = await createLink(me);
    await open(app, pathOf(link));
    const token = pathOf(link).split('/').at(-1) ?? '';
    const rows = await db.auditEvent.findMany({ where: { entityType: 'mobileconfig_link', entityId: link.linkId } });
    expect(rows.map((r) => r.action).sort()).toEqual(['mobileconfig.generate', 'mobileconfig.link.create', 'mobileconfig.link.redeem']);
    expect(rows.every((r) => r.actorAccountId === me.id)).toBe(true);
    const everything = await db.auditEvent.findMany({ where: { actorAccountId: me.id } });
    expect(JSON.stringify(everything)).not.toContain(token);
  });

  it('serves the copyable settings: IMAP 993, SMTP 465 and 587, the address as username', async () => {
    const me = await person();
    const res = await request(app).get('/api/mobileconfig/settings').set('cookie', me.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      address: me.address,
      username: me.address,
      imap: { host: 'mx.d3cloud.io', port: 993, security: 'tls' },
      smtp: [
        { host: 'mx.d3cloud.io', port: 465, security: 'tls' },
        { host: 'mx.d3cloud.io', port: 587, security: 'starttls' },
      ],
    });
    expect((await request(app).get('/api/mobileconfig/settings')).status).toBe(401);
  });

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
