// PST-T-0.8 doneWhen, API half: setup → TOTP → sign-in; /setup gone after the first operator; the
// admin gate; step-up with its five-minute window; and the password path with D3 Auth unreachable.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import {
  baseConfig,
  cookieHeader,
  cookiesOf,
  createAccount,
  randomLogin,
  TestClock,
  totpCode,
} from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const OPERATOR = { displayName: 'Matt', login: 'matt', password: 'correct horse battery staple' };

interface StateBody {
  setupRequired: boolean;
  oidcConfigured: boolean;
  oidcAvailable: boolean;
  signedIn: boolean;
  account?: { id: string; isAdmin: boolean; address: string | null };
}

describe.skipIf(!baseUrl)('dual login: native path, setup, admin gate, step-up (PST-T-0.8)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let seededOperatorId = '';
  let operatorSecret = '';
  let guardMissesBefore = 0;

  const state = async (jar: Record<string, string> = {}, on: Express = app): Promise<StateBody> => {
    const res = await request(on).get('/api/auth/state').set('cookie', cookieHeader(jar));
    expect(res.status).toBe(200);
    return res.body as StateBody;
  };

  /** Password then TOTP. Moves the clock a step first so the code is never a replay. */
  const signIn = async (login: string, password: string, secret: string, on: Express = app): Promise<Record<string, string>> => {
    clock.advance(31_000);
    const first = await request(on).post('/api/auth/signin').set(CSRF).send({ login, password });
    expect(first.status).toBe(200);
    const { next, challenge } = first.body as { next: string; challenge: string };
    expect(next).toBe('totp');
    const second = await request(on)
      .post('/api/auth/signin/totp')
      .set(CSRF)
      .send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookiesOf(second);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t08');
    db = testDb.db;
    seededOperatorId = (await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' })).operatorId;
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  describe('one-time setup (PST-REQ-006, PST-REQ-171)', () => {
    it('reports setup required while the seeded operator has no credential', async () => {
      const body = await state();
      expect(body).toMatchObject({ setupRequired: true, signedIn: false, oidcConfigured: false, oidcAvailable: false });
      const page = await request(app).get('/setup');
      expect(page.status).not.toBe(302);
    });

    it('refuses a state-changing request without the CSRF header or a matching Origin', async () => {
      const res = await request(app).post('/api/auth/setup/begin').send(OPERATOR);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'csrf' });
      const evil = await request(app).post('/api/auth/setup/begin').set('origin', 'https://evil.example').send(OPERATOR);
      expect(evil.status).toBe(403);
    });

    it('refuses a short password', async () => {
      const res = await request(app).post('/api/auth/setup/begin').set(CSRF).send({ ...OPERATOR, password: 'short' });
      expect(res.status).toBe(400);
    });

    it('requires TOTP enrolment, confirmed with a code, before setup completes', async () => {
      const begin = await request(app).post('/api/auth/setup/begin').set(CSRF).send(OPERATOR);
      expect(begin.status).toBe(200);
      const { enrolToken, secret, otpauthUri } = begin.body as { enrolToken: string; secret: string; otpauthUri: string };
      expect(otpauthUri).toMatch(/^otpauth:\/\/totp\/Postroom:matt\?/);
      expect(secret).toMatch(/^[A-Z2-7]{32}$/);

      // Nothing is written to the account until the code proves the authenticator works.
      expect((await db.account.findUniqueOrThrow({ where: { id: seededOperatorId } })).passwordHash).toBeNull();

      const wrong = await request(app).post('/api/auth/setup/complete').set(CSRF).send({ enrolToken, code: '000000' });
      expect(wrong.status).toBe(400);
      expect(await db.auditEvent.count({ where: { action: 'auth.setup.code_rejected' } })).toBe(1);
      expect(await state()).toMatchObject({ setupRequired: true });

      const done = await request(app)
        .post('/api/auth/setup/complete')
        .set(CSRF)
        .send({ enrolToken, code: totpCode(secret, clock.now()) });
      expect(done.status).toBe(200);
      operatorSecret = secret;

      const setCookie = String(done.headers['set-cookie']);
      expect(setCookie).toMatch(/postroom_session=[A-Za-z0-9_-]{43};/);
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Lax/);

      const jar = cookiesOf(done);
      const after = await state(jar);
      expect(after).toMatchObject({ setupRequired: false, signedIn: true });
      expect(after.account).toMatchObject({ id: seededOperatorId, isAdmin: true, address: 'matt@d3cloud.io' });

      const account = await db.account.findUniqueOrThrow({ where: { id: seededOperatorId } });
      expect(account.passwordHash).toMatch(/^\$argon2id\$/);
      expect(account.totpEnabled).toBe(true);
      // The step the setup code used is burnt on the account row.
      expect(account.totpLastStep).not.toBeNull();
      expect((await db.session.findFirstOrThrow({ where: { accountId: seededOperatorId } })).method).toBe('password');
      expect(await db.setting.count({ where: { key: { startsWith: 'auth.' } } })).toBe(0);
      // Sealed under the KEK: the base32 secret is nowhere in the stored bytes.
      expect(Buffer.from(account.totpSecret ?? new Uint8Array()).toString('latin1')).not.toContain(secret);
      // The session row stores the token's hash only.
      const token = jar['postroom_session'] ?? '';
      expect(await db.session.count({ where: { idHash: token } })).toBe(0);
      expect(await db.auditEvent.count({ where: { action: 'auth.setup.complete', entityId: seededOperatorId } })).toBe(1);
    });

    it('redirects /setup to /signin and answers 409 once an operator exists', async () => {
      const page = await request(app).get('/setup');
      expect(page.status).toBe(302);
      expect(page.headers['location']).toBe('/signin');

      const begin = await request(app).post('/api/auth/setup/begin').set(CSRF).send({ ...OPERATOR, login: 'other' });
      expect(begin.status).toBe(409);
      const complete = await request(app).post('/api/auth/setup/complete').set(CSRF).send({ enrolToken: 'x', code: '123456' });
      expect(complete.status).toBe(409);
    });
  });

  describe('password + TOTP sign-in (PST-REQ-005)', () => {
    it('signs in with password then TOTP, by login or full address', async () => {
      const jar = await signIn('matt', OPERATOR.password, operatorSecret);
      expect(await state(jar)).toMatchObject({ signedIn: true, account: { isAdmin: true } });
      const jar2 = await signIn('Matt@D3cloud.io', OPERATOR.password, operatorSecret);
      expect(await state(jar2)).toMatchObject({ signedIn: true });
      expect(await db.auditEvent.count({ where: { action: 'auth.signin', actorAccountId: seededOperatorId } })).toBeGreaterThanOrEqual(2);
    });

    it('rejects a wrong password, and audits it', async () => {
      const before = await db.auditEvent.count({ where: { action: 'auth.signin.rejected' } });
      const res = await request(app).post('/api/auth/signin').set(CSRF).send({ login: 'matt', password: 'wrong password!' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
      expect(res.headers['set-cookie']).toBeUndefined();
      const rows = await db.auditEvent.findMany({ where: { action: 'auth.signin.rejected' }, orderBy: { at: 'desc' } });
      expect(rows.length).toBe(before + 1);
      expect(rows[0]?.entityId).toBe(seededOperatorId);
    });

    it('answers an unknown login exactly like a wrong password', async () => {
      const res = await request(app).post('/api/auth/signin').set(CSRF).send({ login: 'nobody', password: 'whatever at all' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid_credentials' });
    });

    it('rejects a wrong TOTP code and a replayed one, and audits both', async () => {
      clock.advance(31_000);
      const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login: 'matt', password: OPERATOR.password });
      const { challenge } = first.body as { challenge: string };
      const wrong = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: '000000' });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual({ error: 'invalid_code' });

      const code = totpCode(operatorSecret, clock.now());
      const ok = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code });
      expect(ok.status).toBe(200);

      const again = await request(app).post('/api/auth/signin').set(CSRF).send({ login: 'matt', password: OPERATOR.password });
      const replay = await request(app)
        .post('/api/auth/signin/totp')
        .set(CSRF)
        .send({ challenge: (again.body as { challenge: string }).challenge, code });
      expect(replay.status).toBe(401);
      const totpRejections = await db.auditEvent.findMany({ where: { action: 'auth.signin.rejected', entityId: seededOperatorId } });
      expect(totpRejections.filter((r) => JSON.stringify(r.after).includes('"totp"')).length).toBeGreaterThanOrEqual(2);
    });

    it('throttles repeated failures per login and IP before hashing', async () => {
      const login = randomLogin();
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        const res = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: 'not the password' });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses[5]).toBe(429);
    });
  });

  describe('admin gate (PST-REQ-007) and step-up (PST-REQ-008)', () => {
    let adminJar: Record<string, string> = {};
    let userJar: Record<string, string> = {};
    let userSessionId = '';
    const bob = { login: 'bob', password: 'bob has a long password' };

    beforeAll(async () => {
      const created = await createAccount(db, { ...bob, isAdmin: false });
      userJar = await signIn(bob.login, bob.password, created.totpSecret);
      adminJar = await signIn('matt', OPERATOR.password, operatorSecret);
      const own = await request(app).get('/api/auth/sessions').set('cookie', cookieHeader(userJar));
      const sessions = (own.body as { sessions: { id: string; current: boolean }[] }).sessions;
      userSessionId = sessions.find((s) => s.current)?.id ?? '';
      expect(userSessionId).not.toBe('');
    });

    it('401 without a session', async () => {
      expect((await request(app).get('/api/admin/sessions')).status).toBe(401);
    });

    it('403 for a non-admin on every /api/admin route', async () => {
      const cookie = cookieHeader(userJar);
      for (const [method, path] of [
        ['get', '/api/admin/sessions'],
        ['get', '/api/admin/anything-else'],
        ['delete', `/api/admin/sessions/${userSessionId}`],
        ['post', '/api/admin/whatever'],
      ] as const) {
        const res = await request(app)[method](path).set(CSRF).set('cookie', cookie);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body).toEqual({ error: 'forbidden' });
      }
    });

    it('200 for an admin', async () => {
      const res = await request(app).get('/api/admin/sessions').set('cookie', cookieHeader(adminJar));
      expect(res.status).toBe(200);
      const ids = (res.body as { sessions: { id: string }[] }).sessions.map((s) => s.id);
      expect(ids).toContain(userSessionId);
    });

    it('a destructive admin action needs a fresh second factor', async () => {
      const cookie = cookieHeader(adminJar);
      const refused = await request(app).delete(`/api/admin/sessions/${userSessionId}`).set(CSRF).set('cookie', cookie);
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: 'step_up_required' });

      const wrong = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: '000000' });
      expect(wrong.status).toBe(401);
      expect(await db.auditEvent.count({ where: { action: 'auth.step-up.rejected' } })).toBe(1);

      clock.advance(31_000);
      const stepUp = await request(app)
        .post('/api/auth/step-up')
        .set(CSRF)
        .set('cookie', cookie)
        .send({ code: totpCode(operatorSecret, clock.now()) });
      expect(stepUp.status).toBe(200);

      const revoked = await request(app).delete(`/api/admin/sessions/${userSessionId}`).set(CSRF).set('cookie', cookie);
      expect(revoked.status).toBe(200);
      expect(await db.session.findUnique({ where: { id: userSessionId } })).toBeNull();
      expect(await state(userJar)).toMatchObject({ signedIn: false });
      expect(await db.auditEvent.count({ where: { action: 'admin.session.revoke', entityId: userSessionId } })).toBe(1);
    });

    it('step-up expires after five minutes', async () => {
      const victim = await signIn(bob.login, bob.password, (await freshBob()).totpSecret);
      const sessions = await request(app).get('/api/auth/sessions').set('cookie', cookieHeader(victim));
      const victimId = (sessions.body as { sessions: { id: string; current: boolean }[] }).sessions.find((s) => s.current)?.id ?? '';
      const cookie = cookieHeader(adminJar);

      clock.advance(31_000);
      const stepUp = await request(app)
        .post('/api/auth/step-up')
        .set(CSRF)
        .set('cookie', cookie)
        .send({ code: totpCode(operatorSecret, clock.now()) });
      expect(stepUp.status).toBe(200);

      clock.advance(5 * 60 * 1000 + 1_000);
      const stale = await request(app).delete(`/api/admin/sessions/${victimId}`).set(CSRF).set('cookie', cookie);
      expect(stale.status).toBe(403);
      expect(stale.body).toEqual({ error: 'step_up_required' });
      expect(await db.session.findUnique({ where: { id: victimId } })).not.toBeNull();
    });

    // Bob's TOTP secret is regenerated so the step-expiry test does not depend on test order.
    async function freshBob(): Promise<{ totpSecret: string }> {
      const existing = await db.account.findFirstOrThrow({ where: { addresses: { some: { localPart: 'bob' } } } });
      await db.address.deleteMany({ where: { accountId: existing.id } });
      await db.account.delete({ where: { id: existing.id } });
      return createAccount(db, { ...bob, isAdmin: false });
    }
  });

  describe('sessions', () => {
    it('sign-out ends the session and audits it', async () => {
      const jar = await signIn('matt', OPERATOR.password, operatorSecret);
      const out = await request(app).post('/api/auth/signout').set(CSRF).set('cookie', cookieHeader(jar));
      expect(out.status).toBe(200);
      expect(await state(jar)).toMatchObject({ signedIn: false });
      expect(await db.auditEvent.count({ where: { action: 'auth.signout' } })).toBe(1);
    });

    it('ends after 12 hours idle', async () => {
      const jar = await signIn('matt', OPERATOR.password, operatorSecret);
      clock.advance(11 * 60 * 60 * 1000);
      expect(await state(jar)).toMatchObject({ signedIn: true });
      clock.advance(12 * 60 * 60 * 1000 + 60_000);
      expect(await state(jar)).toMatchObject({ signedIn: false });
    });

    it('left no successful mutation unaudited', async () => {
      await waitForAuditGuard();
      expect(missingAuditCount.value).toBe(guardMissesBefore);
    });
  });

  describe('with D3 Auth unreachable (PST-REQ-005)', () => {
    let deadApp: Express;

    beforeAll(() => {
      deadApp = createApp({
        db,
        env: {},
        config: baseConfig(clock, {
          // Fully configured, pointing at a port nothing listens on: refuses at once.
          d3authIssuer: 'http://127.0.0.1:1',
          d3authClientId: 'postroom',
          d3authClientSecret: 'not-a-real-secret',
        }),
      });
    });

    it('boots, says configured but unavailable', async () => {
      expect((await request(deadApp).get('/health')).status).toBe(200);
      expect(await state({}, deadApp)).toMatchObject({ oidcConfigured: true, oidcAvailable: false });
    });

    it('the password path still works', async () => {
      const jar = await signIn('matt', OPERATOR.password, operatorSecret, deadApp);
      expect(await state(jar, deadApp)).toMatchObject({ signedIn: true, oidcAvailable: false });
    });

    it('sends the D3 Auth button back to /signin with a reason instead of hanging', async () => {
      const res = await request(deadApp).get('/api/auth/oidc/start');
      expect(res.status).toBe(302);
      expect(String(res.headers['location'])).toMatch(/^\/signin\?signin_error=/);
    });
  });
});
