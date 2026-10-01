// PST-T-16.16 (PST-DA-039, PST-REQ-139): the iPhone's one-time profile URL. Creating one needs a
// session, step-up and CSRF; opening it needs nothing (the phone has no session), mints exactly one
// app password and returns the profile — once. A second open, an expired link and a forged one all
// answer the same 410. Two racing opens produce one profile. The link's status reports the minted
// password's first use, and only to its owner. The token is never written to the audit log.
//
// PST-T-16.27: an unspent link dies (the same 410) once the account's password changes, "sign out
// everywhere" runs, or a newer link is made; and the status names the protocol of the newest
// recorded use of the minted password, or none.
//
// PST-T-16.28: 50 replays of a spent (or superseded) link all answer 410 without taking the
// advisory lock, each costing at most the two reads of the non-locking check, and none past the
// per-link limit.
import { recordAudit } from '@postroom/audit';import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { verifyProtocolLogin } from '@postroom/credentials';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { runtimeFor } from '../../src/auth/runtime.js';
import { onceLinkStats, OPENS_PER_LINK } from '../../src/mobileconfig/index.js';
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
  protocol: string | null;
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

  it('a link made before a password change answers 410, and mints nothing (PST-T-16.27)', async () => {
    const me = await person();
    const link = await createLink(me);
    clock.advance(31_000);
    const changed = await request(app)
      .post('/api/auth/password')
      .set(CSRF)
      .set('cookie', me.cookie)
      .send({ currentPassword: PASSWORD, newPassword: 'a brand new long password, honest', code: totpCode(me.totpSecret, clock.now()) });
    expect(changed.status).toBe(200);
    const refused = await open(app, pathOf(link));
    expect(refused.status).toBe(410);
    expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(0);
    // Refused, not spent: no redeem row was written for it.
    expect(await db.auditEvent.count({ where: { entityType: 'mobileconfig_link', entityId: link.linkId, action: 'mobileconfig.link.redeem' } })).toBe(0);
    // A link made after the change works.
    const fresh = await createLink(me);
    expect((await open(app, pathOf(fresh))).status).toBe(200);
  });

  it('a link made before "sign out everywhere" answers 410 (PST-T-16.27)', async () => {
    const me = await person();
    const link = await createLink(me);
    await stepUp(me.cookie, me.totpSecret);
    const ended = await request(app).delete('/api/auth/sessions').set(CSRF).set('cookie', me.cookie);
    expect(ended.status).toBe(200);
    const refused = await open(app, pathOf(link));
    expect(refused.status).toBe(410);
    expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(0);
    const fresh = await createLink(me);
    expect((await open(app, pathOf(fresh))).status).toBe(200);
  });

  it('only the newest link works: making another kills the one before (PST-T-16.27)', async () => {
    const me = await person();
    const older = await createLink(me);
    const newer = await createLink(me);
    const refused = await open(app, pathOf(older));
    expect(refused.status).toBe(410);
    expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(0);
    expect((await open(app, pathOf(newer))).status).toBe(200);
    expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(1);
    // Another account's newer link is no business of this one.
    const other = await person();
    const mine = await createLink(me);
    await createLink(other);
    expect((await open(app, pathOf(mine))).status).toBe(200);
  });

  it('the refusals are the same 410 as a spent link', async () => {
    const me = await person();
    const spent = await createLink(me);
    await open(app, pathOf(spent));
    const spentAnswer = await open(app, pathOf(spent));
    const older = await createLink(me);
    await createLink(me);
    const superseded = await open(app, pathOf(older));
    expect(superseded.status).toBe(spentAnswer.status);
    expect((superseded.body as Buffer).toString('utf8')).toBe((spentAnswer.body as Buffer).toString('utf8'));
  });

  it('names the protocol of the newest recorded use, or none (PST-T-16.27)', async () => {
    const me = await person();
    const other = await person();
    const link = await createLink(me);
    const res = await open(app, pathOf(link));
    const id = String(res.headers['x-postroom-app-password-id']);
    const plist = (res.body as Buffer).toString('utf8');
    const password = /<key>IncomingPassword<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? '';

    const unused = (await status(me.cookie, link.linkId)).body as LinkStatus;
    expect(unused).toMatchObject({ redeemed: true, lastUsedAt: null, protocol: null });

    // Used, with no protocol recorded: the time alone.
    await db.appPassword.update({ where: { id }, data: { lastUsedAt: new Date() } });
    await db.auditEvent.deleteMany({ where: { entityType: 'app_password', entityId: id, action: 'app_password.use' } });
    expect(((await status(me.cookie, link.linkId)).body as LinkStatus).protocol).toBeNull();

    // CalDAV signs in first on an iPhone; then IMAP. The newest recorded use names the protocol.
    expect(await verifyProtocolLogin(db, { username: me.address, password, scope: 'dav', ip: '127.0.0.1' }, { pepper: PEPPER })).toMatchObject({ ok: true });
    await recordAudit(db, { actor: { kind: 'account', accountId: me.id }, action: 'app_password.use', entityType: 'app_password', entityId: id, after: { scope: 'dav' } });
    const dav = (await status(me.cookie, link.linkId)).body as LinkStatus;
    expect(dav.protocol).toBe('dav');
    expect(dav.lastUsedAt).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await recordAudit(db, { actor: { kind: 'account', accountId: me.id }, action: 'app_password.use', entityType: 'app_password', entityId: id, after: { scope: 'imap' } });
    expect(((await status(me.cookie, link.linkId)).body as LinkStatus).protocol).toBe('imap');
    // Only to its owner.
    expect((await status(other.cookie, link.linkId)).status).toBe(404);
  });

  describe('replays of a dead link (PST-T-16.28)', () => {
    /**
     * A second app over the same database whose client counts every query it runs, raw ones (the
     * advisory lock) included. Its own limiters, so the replays below start from a clean count.
     */
    const counted = async (): Promise<{ app: Express; stats: { queries: number; locks: number } }> => {
      const stats = { queries: 0, locks: 0 };
      const client = db.$extends({
        query: {
          $allOperations({ operation, args, query }) {
            stats.queries += 1;
            if (operation === '$executeRaw') stats.locks += 1;
            return query(args);
          },
        },
      });
      const deps = { db: client as unknown as Db, env: {}, config: baseConfig(clock) };
      const counting = createApp(deps);
      // The runtime reads the saved D3 Auth settings at boot (PST-T-17.6); that read is not an open's.
      await runtimeFor(deps).oidc.ready();
      stats.queries = 0;
      stats.locks = 0;
      return { app: counting, stats };
    };

    const replay = async (path: string): Promise<void> => {
      const { app: replayApp, stats } = await counted();
      const locksBefore = onceLinkStats.locks;
      const perOpen: number[] = [];
      const results = [];
      for (let i = 0; i < 50; i += 1) {
        const before = stats.queries;
        results.push(await open(replayApp, path));
        perOpen.push(stats.queries - before);
      }
      for (const r of results) expect(r.status).toBe(410);
      // No replay took the lock or opened the transaction it lives in.
      expect(stats.locks).toBe(0);
      expect(onceLinkStats.locks).toBe(locksBefore);
      // The counter is live (the first opens did query), each open ran at most the two reads of the
      // non-locking check, and past the per-link limit none at all.
      expect(perOpen[0]).toBeGreaterThan(0);
      expect(Math.max(...perOpen)).toBeLessThanOrEqual(2);
      expect(perOpen.slice(OPENS_PER_LINK).every((n) => n === 0)).toBe(true);
    };

    it('50 replays of a spent link: all 410, none takes the lock, at most two queries each', async () => {
      const me = await person();
      const link = await createLink(me);
      expect((await open(app, pathOf(link))).status).toBe(200);
      await replay(pathOf(link));
      expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(1);
      expect(await db.auditEvent.count({ where: { entityType: 'mobileconfig_link', entityId: link.linkId, action: 'mobileconfig.link.redeem' } })).toBe(1);
    });

    it('50 replays of a superseded link: all 410, none takes the lock, and the newer link still works', async () => {
      const me = await person();
      const older = await createLink(me);
      const newer = await createLink(me);
      await replay(pathOf(older));
      expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(0);
      expect((await open(app, pathOf(newer))).status).toBe(200);
    });

    it('the first open still goes through the lock', async () => {
      const me = await person();
      const link = await createLink(me);
      const { app: replayApp, stats } = await counted();
      const locksBefore = onceLinkStats.locks;
      expect((await open(replayApp, pathOf(link))).status).toBe(200);
      expect(stats.locks).toBe(1);
      expect(onceLinkStats.locks).toBe(locksBefore + 1);
    });
  });

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
