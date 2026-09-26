// PST-T-4.10 doneWhen: integration coverage for the ASVS 5.0 L2 hardening added in
// apps/api/src/auth/** (PST-T-4.3, PST-REQ-091) — password change, session list/revoke with
// step-up, admin session sweep, the five-minute OIDC-link freshness rule, session rotation on
// sign-in, and the authz.denied audit on a non-admin /api/admin call. Unit-level proofs (password
// policy, cookies, headers, CSRF/step-up gating, throttle) live beside the source in
// apps/api/src/auth/asvs-hardening.test.ts.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeIssuer, type FakeIssuer } from '../../../../e2e/fake-issuer/server.mjs';
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
const PASSWORD = 'correct horse battery staple';

interface SessionRow {
  id: string;
  current: boolean;
}

describe.skipIf(!baseUrl)('ASVS hardening: API integration (PST-T-4.10, PST-REQ-091)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let guardMissesBefore = 0;

  /** Password then TOTP. Moves the clock a step first so the code is never a replay. */
  const signIn = async (login: string, password: string, secret: string, on: Express = app): Promise<Record<string, string>> => {
    clock.advance(31_000);
    const first = await request(on).post('/api/auth/signin').set(CSRF).send({ login, password });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(on)
      .post('/api/auth/signin/totp')
      .set(CSRF)
      .send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookiesOf(second);
  };

  const stepUp = async (cookie: string, secret: string): Promise<void> => {
    clock.advance(31_000);
    const res = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(secret, clock.now()) });
    expect(res.status).toBe(200);
  };

  const ownSessionId = async (cookie: string): Promise<string> => {
    const res = await request(app).get('/api/auth/sessions').set('cookie', cookie);
    expect(res.status).toBe(200);
    const sessions = (res.body as { sessions: SessionRow[] }).sessions;
    const id = sessions.find((s) => s.current)?.id;
    if (id === undefined) throw new Error('no current session');
    return id;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t410');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  describe('password change (ASVS 6.2.2, 6.2.3, 7.4.3, 7.5.1)', () => {
    it('401 on the wrong current password, 401 on the wrong code, 400 on a weak new password, then succeeds ending other sessions, with an audit row', async () => {
      const login = randomLogin();
      const { id: accountId, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: false });
      const jar = await signIn(login, PASSWORD, totpSecret);
      const cookie = cookieHeader(jar);
      // A second session for the same account, which the password change should end.
      const otherJar = await signIn(login, PASSWORD, totpSecret);

      clock.advance(31_000);
      const wrongPassword = await request(app)
        .post('/api/auth/password')
        .set(CSRF)
        .set('cookie', cookie)
        .send({ currentPassword: 'not the password', newPassword: 'a brand new long password', code: totpCode(totpSecret, clock.now()) });
      expect(wrongPassword.status).toBe(401);
      expect(wrongPassword.body).toEqual({ error: 'invalid_credentials' });

      clock.advance(31_000);
      const wrongCode = await request(app)
        .post('/api/auth/password')
        .set(CSRF)
        .set('cookie', cookie)
        .send({ currentPassword: PASSWORD, newPassword: 'a brand new long password', code: '000000' });
      expect(wrongCode.status).toBe(401);
      expect(wrongCode.body).toEqual({ error: 'invalid_code' });

      clock.advance(31_000);
      const weak = await request(app)
        .post('/api/auth/password')
        .set(CSRF)
        .set('cookie', cookie)
        .send({ currentPassword: PASSWORD, newPassword: 'short', code: totpCode(totpSecret, clock.now()) });
      expect(weak.status).toBe(400);
      expect(weak.body).toMatchObject({ error: 'weak_password' });

      const before = await db.auditEvent.count({ where: { action: 'auth.password.change' } });
      clock.advance(31_000);
      const newPassword = 'a brand new long password, honest';
      const success = await request(app)
        .post('/api/auth/password')
        .set(CSRF)
        .set('cookie', cookie)
        .send({ currentPassword: PASSWORD, newPassword, code: totpCode(totpSecret, clock.now()) });
      expect(success.status).toBe(200);
      expect(success.body).toMatchObject({ ok: true, endedSessions: 1 });

      expect(await db.auditEvent.count({ where: { action: 'auth.password.change' } })).toBe(before + 1);
      const row = await db.auditEvent.findFirstOrThrow({ where: { action: 'auth.password.change' }, orderBy: { at: 'desc' } });
      expect(row.entityId).toBe(accountId);
      expect(row.after).toBeDefined();

      // The other session is gone; this one, the one that changed the password, survives.
      const otherState = await request(app).get('/api/auth/state').set('cookie', cookieHeader(otherJar));
      expect((otherState.body as { signedIn: boolean }).signedIn).toBe(false);
      const ownState = await request(app).get('/api/auth/state').set('cookie', cookie);
      expect((ownState.body as { signedIn: boolean }).signedIn).toBe(true);

      // The new password now signs in; the old one no longer does.
      const oldFails = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
      expect(oldFails.status).toBe(401);
      await signIn(login, newPassword, totpSecret);
    });
  });

  describe('DELETE /api/auth/sessions[/:id] (ASVS 7.5.2)', () => {
    it('403 without a fresh step-up, and 404 for a session belonging to another account', async () => {
      const login = randomLogin();
      const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: false });
      const jar = await signIn(login, PASSWORD, totpSecret);
      const cookie = cookieHeader(jar);
      const sessionId = await ownSessionId(cookie);

      const otherLogin = randomLogin();
      const other = await createAccount(db, { login: otherLogin, password: PASSWORD, isAdmin: false });
      const otherJar = await signIn(otherLogin, PASSWORD, other.totpSecret);
      const otherSessionId = await ownSessionId(cookieHeader(otherJar));

      const noStepUp = await request(app).delete(`/api/auth/sessions/${sessionId}`).set(CSRF).set('cookie', cookie);
      expect(noStepUp.status).toBe(403);
      expect(noStepUp.body).toEqual({ error: 'step_up_required' });

      const noStepUpBulk = await request(app).delete('/api/auth/sessions').set(CSRF).set('cookie', cookie);
      expect(noStepUpBulk.status).toBe(403);
      expect(noStepUpBulk.body).toEqual({ error: 'step_up_required' });

      await stepUp(cookie, totpSecret);
      const crossAccount = await request(app).delete(`/api/auth/sessions/${otherSessionId}`).set(CSRF).set('cookie', cookie);
      expect(crossAccount.status).toBe(404);
      expect(crossAccount.body).toEqual({ error: 'not_found' });
      expect(await db.session.findUnique({ where: { id: otherSessionId } })).not.toBeNull();

      const ownRevoke = await request(app).delete(`/api/auth/sessions/${sessionId}`).set(CSRF).set('cookie', cookie);
      expect(ownRevoke.status).toBe(200);
      expect(await db.session.findUnique({ where: { id: sessionId } })).toBeNull();
    });
  });

  describe('admin session sweep DELETE /api/admin/sessions (ASVS 7.4.5, 7.5.2)', () => {
    it('needs step-up and keeps the caller alive either way', async () => {
      const adminLogin = randomLogin();
      const admin = await createAccount(db, { login: adminLogin, password: PASSWORD, isAdmin: true });
      const adminJar = await signIn(adminLogin, PASSWORD, admin.totpSecret);
      const adminCookie = cookieHeader(adminJar);
      const adminSessionId = await ownSessionId(adminCookie);

      const victimLogin = randomLogin();
      const victim = await createAccount(db, { login: victimLogin, password: PASSWORD, isAdmin: false });
      const victimJar = await signIn(victimLogin, PASSWORD, victim.totpSecret);

      const noStepUp = await request(app).delete('/api/admin/sessions?all=1').set(CSRF).set('cookie', adminCookie);
      expect(noStepUp.status).toBe(403);
      expect(noStepUp.body).toEqual({ error: 'step_up_required' });
      expect(await db.session.count({ where: { accountId: victim.id } })).toBe(1);

      await stepUp(adminCookie, admin.totpSecret);
      const sweep = await request(app).delete('/api/admin/sessions?all=1').set(CSRF).set('cookie', adminCookie);
      expect(sweep.status).toBe(200);
      expect((sweep.body as { ended: number }).ended).toBeGreaterThanOrEqual(1);

      // The caller's own session is untouched; the victim's is gone.
      const adminState = await request(app).get('/api/auth/state').set('cookie', adminCookie);
      expect((adminState.body as { signedIn: boolean }).signedIn).toBe(true);
      expect(await db.session.findUnique({ where: { id: adminSessionId } })).not.toBeNull();
      const victimState = await request(app).get('/api/auth/state').set('cookie', cookieHeader(victimJar));
      expect((victimState.body as { signedIn: boolean }).signedIn).toBe(false);
    });
  });

  describe('a non-admin /api/admin call (ASVS 16.3.2)', () => {
    it('writes an authz.denied audit row', async () => {
      const login = randomLogin();
      const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: false });
      const jar = await signIn(login, PASSWORD, totpSecret);
      const account = await db.account.findFirstOrThrow({ where: { addresses: { some: { localPart: login } } } });

      const before = await db.auditEvent.count({ where: { action: 'authz.denied', actorAccountId: account.id } });
      const res = await request(app).get('/api/admin/sessions').set('cookie', cookieHeader(jar));
      expect(res.status).toBe(403);
      expect(await db.auditEvent.count({ where: { action: 'authz.denied', actorAccountId: account.id } })).toBe(before + 1);
      const row = await db.auditEvent.findFirstOrThrow({ where: { action: 'authz.denied', actorAccountId: account.id }, orderBy: { at: 'desc' } });
      expect(row.after).toMatchObject({ method: 'GET', reason: 'not_admin' });
    });
  });

  describe('session rotation on sign-in (ASVS 7.2.4)', () => {
    it('deletes the old session cookie presented while signing in again', async () => {
      const login = randomLogin();
      const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: false });
      const firstJar = await signIn(login, PASSWORD, totpSecret);
      const firstSessionId = await ownSessionId(cookieHeader(firstJar));
      expect(await db.session.findUnique({ where: { id: firstSessionId } })).not.toBeNull();

      // Sign in again while the old session cookie is still presented.
      clock.advance(31_000);
      const first = await request(app)
        .post('/api/auth/signin')
        .set(CSRF)
        .set('cookie', cookieHeader(firstJar))
        .send({ login, password: PASSWORD });
      expect(first.status).toBe(200);
      const { challenge } = first.body as { challenge: string };
      const second = await request(app)
        .post('/api/auth/signin/totp')
        .set(CSRF)
        .set('cookie', cookieHeader(firstJar))
        .send({ challenge, code: totpCode(totpSecret, clock.now()) });
      expect(second.status).toBe(200);
      const secondJar = cookiesOf(second);

      expect(await db.session.findUnique({ where: { id: firstSessionId } })).toBeNull();
      const secondSessionId = await ownSessionId(cookieHeader(secondJar));
      expect(secondSessionId).not.toBe(firstSessionId);
      expect(await db.session.findUnique({ where: { id: secondSessionId } })).not.toBeNull();
    });
  });

  describe('link=1 freshness rule (ASVS 7.5.1)', () => {
    let issuer: FakeIssuer;
    let linkedApp: Express;

    beforeAll(async () => {
      issuer = await startFakeIssuer({ port: 0, clientId: 'postroom', clientSecret: 'shh-basic-only' });
      linkedApp = createApp({
        db,
        env: {},
        config: baseConfig(clock, {
          d3authIssuer: issuer.url,
          d3authClientId: 'postroom',
          d3authClientSecret: 'shh-basic-only',
        }),
      });
    });

    afterAll(async () => {
      await issuer.close();
    });

    it('a session older than five minutes redirects to sign-in instead of starting the link', async () => {
      const login = randomLogin();
      const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: false });
      const jar = await signIn(login, PASSWORD, totpSecret, linkedApp);

      clock.advance(5 * 60 * 1000 + 1_000);
      const res = await request(linkedApp).get('/api/auth/oidc/start?link=1').set('cookie', cookieHeader(jar));
      expect(res.status).toBe(302);
      expect(String(res.headers['location'])).toMatch(/^\/signin\?signin_error=.+&link_after_signin=1$/);
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('a freshly signed-in session is allowed to start the link', async () => {
      const login = randomLogin();
      const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: false });
      const jar = await signIn(login, PASSWORD, totpSecret, linkedApp);
      const res = await request(linkedApp).get('/api/auth/oidc/start?link=1').set('cookie', cookieHeader(jar));
      expect(res.status).toBe(302);
      expect(String(res.headers['location']).startsWith(`${issuer.url}/authorize?`)).toBe(true);
    });
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
