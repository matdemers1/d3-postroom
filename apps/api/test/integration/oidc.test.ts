// PST-T-0.8 doneWhen, D3 Auth half: the full authorization-code flow against a hand-rolled issuer
// (PKCE, client_secret_basic, RS256), identity linking by (iss, sub) and never by email — including
// the email-collision case — the roles claim as an admin source, and back-channel logout.
import { waitForAuditGuard, missingAuditCount } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeIssuer, type FakeIssuer, type FakeIssuerUser } from '../../../../e2e/fake-issuer/server.mjs';
import { createApp } from '../../src/app.js';
import {
  baseConfig,
  cookieHeader,
  cookiesOf,
  createAccount,
  TestClock,
  totpCode,
  WEB_ORIGIN,
} from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };

interface StateBody {
  oidcConfigured: boolean;
  oidcAvailable: boolean;
  signedIn: boolean;
  method?: string;
  account?: { id: string; isAdmin: boolean };
}

describe.skipIf(!baseUrl)('Sign in with D3 Auth (PST-REQ-005, PST-REQ-007)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let issuer: FakeIssuer;
  const clock = new TestClock();
  let operator: { id: string; totpSecret: string };
  let guardMissesBefore = 0;
  const OPERATOR_PASSWORD = 'operator password, long enough';

  const state = async (jar: Record<string, string>): Promise<StateBody> => {
    const res = await request(app).get('/api/auth/state').set('cookie', cookieHeader(jar));
    return res.body as StateBody;
  };

  /** Browser round trip: /oidc/start → issuer /authorize → our /oidc/callback, cookies carried. */
  const oidcSignIn = async (
    user: FakeIssuerUser,
    jar: Record<string, string> = {},
    startPath = '/api/auth/oidc/start',
    tamper?: (callback: URL) => void,
  ): Promise<{ location: string; jar: Record<string, string> }> => {
    issuer.setUser(user);
    const start = await request(app).get(startPath).set('cookie', cookieHeader(jar));
    expect(start.status).toBe(302);
    const authorizeUrl = String(start.headers['location']);
    expect(authorizeUrl.startsWith(`${issuer.url}/authorize?`)).toBe(true);
    const params = new URL(authorizeUrl).searchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('openid profile email d3:roles');
    cookiesOf(start, jar);
    expect(jar['postroom_oidc']).toBeDefined();

    const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const callback = new URL(authorized.headers.get('location') ?? '');
    expect(callback.origin).toBe(WEB_ORIGIN);
    tamper?.(callback);

    const done = await request(app).get(`${callback.pathname}${callback.search}`).set('cookie', cookieHeader(jar));
    expect(done.status).toBe(302);
    cookiesOf(done, jar);
    return { location: String(done.headers['location']), jar };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t08');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    // The operator as setup would leave it: admin, password, TOTP, operator@d3cloud.io.
    const seeded = await db.account.findFirstOrThrow({ where: { isAdmin: true } });
    await db.account.delete({ where: { id: seeded.id } });
    operator = await createAccount(db, { login: 'operator', password: OPERATOR_PASSWORD, isAdmin: true });

    issuer = await startFakeIssuer({ port: 0, clientId: 'postroom', clientSecret: 'shh-basic-only' });
    app = createApp({
      db,
      env: {},
      config: baseConfig(clock, {
        d3authIssuer: issuer.url,
        d3authClientId: 'postroom',
        d3authClientSecret: 'shh-basic-only',
      }),
    });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await issuer.close();
    await testDb.drop();
  });

  it('discovers the issuer and offers the button', async () => {
    expect(await state({})).toMatchObject({ oidcConfigured: true, oidcAvailable: true, signedIn: false });
  });

  it('completes the code flow, provisions an account linked by (iss, sub), and signs in', async () => {
    const { location, jar } = await oidcSignIn({ sub: 'alice-1', email: 'alice@example.com', name: 'Alice', roles: [] });
    expect(location).toBe('/');
    expect(jar['postroom_oidc']).toBeUndefined();
    const body = await state(jar);
    expect(body).toMatchObject({ signedIn: true, method: 'oidc', account: { isAdmin: false } });

    const link = await db.identityLink.findUniqueOrThrow({
      where: { issuer_subject: { issuer: issuer.url, subject: 'alice-1' } },
    });
    expect(link.accountId).toBe(body.account?.id);
    expect(issuer.stats.token).toBeGreaterThan(0);
    // Sign-in metadata lives on the session row, not in `setting`.
    const row = await db.session.findFirstOrThrow({ where: { accountId: link.accountId } });
    expect(row).toMatchObject({ method: 'oidc', roles: [], oidcIssuer: issuer.url, oidcSubject: 'alice-1' });
    expect(await db.setting.count({ where: { key: { startsWith: 'auth.' } } })).toBe(0);
    expect(await db.auditEvent.count({ where: { action: 'auth.signin', actorAccountId: link.accountId } })).toBe(1);

    // No admin role and no admin flag: the admin API refuses.
    expect((await request(app).get('/api/admin/sessions').set('cookie', cookieHeader(jar))).status).toBe(403);
  });

  it('the same subject with a changed email is the same account', async () => {
    const first = await db.identityLink.findUniqueOrThrow({
      where: { issuer_subject: { issuer: issuer.url, subject: 'alice-1' } },
    });
    const { jar } = await oidcSignIn({ sub: 'alice-1', email: 'alice.new@example.com', roles: [] });
    expect((await state(jar)).account?.id).toBe(first.accountId);
    const after = await db.identityLink.findUniqueOrThrow({ where: { id: first.id } });
    expect(after.email).toBe('alice.new@example.com');
  });

  it('a different subject asserting the same email is a different account — never matched by email', async () => {
    const alice = await db.identityLink.findUniqueOrThrow({
      where: { issuer_subject: { issuer: issuer.url, subject: 'alice-1' } },
    });
    const { jar } = await oidcSignIn({ sub: 'impostor-2', email: 'alice.new@example.com', roles: [] });
    const body = await state(jar);
    expect(body.signedIn).toBe(true);
    expect(body.account?.id).not.toBe(alice.accountId);
  });

  it('refuses, without a 5xx, an identity whose email a local account already holds', async () => {
    const accountsBefore = await db.account.count();
    const { location, jar } = await oidcSignIn({ sub: 'mallory-3', email: 'operator@d3cloud.io', roles: [] });
    expect(location).toMatch(/^\/signin\?signin_error=.+&link_after_signin=1$/);
    expect(jar['postroom_session']).toBeUndefined();
    expect(await db.account.count()).toBe(accountsBefore);
    expect(
      await db.identityLink.findUnique({ where: { issuer_subject: { issuer: issuer.url, subject: 'mallory-3' } } }),
    ).toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'auth.oidc.rejected' } })).toBe(1);
  });

  it('links deliberately: signed in with the password, then Sign in with D3 Auth with link=1', async () => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login: 'operator', password: OPERATOR_PASSWORD });
    const second = await request(app)
      .post('/api/auth/signin/totp')
      .set(CSRF)
      .send({ challenge: (first.body as { challenge: string }).challenge, code: totpCode(operator.totpSecret, clock.now()) });
    expect(second.status).toBe(200);
    const jar = cookiesOf(second);

    const { location } = await oidcSignIn({ sub: 'op-d3', email: 'operator@d3cloud.io', roles: [] }, { ...jar }, '/api/auth/oidc/start?link=1');
    expect(location).toBe('/');
    const link = await db.identityLink.findUniqueOrThrow({ where: { issuer_subject: { issuer: issuer.url, subject: 'op-d3' } } });
    expect(link.accountId).toBe(operator.id);
    expect(await db.auditEvent.count({ where: { action: 'auth.identity.link', actorAccountId: operator.id } })).toBe(1);

    // From now on D3 Auth alone reaches the operator, who is an admin by the native flag.
    const fresh = await oidcSignIn({ sub: 'op-d3', email: 'operator@d3cloud.io', roles: [] });
    expect(await state(fresh.jar)).toMatchObject({ signedIn: true, account: { id: operator.id, isAdmin: true } });
  });

  it("grants admin from the roles claim ('admin' on this client) without the native flag", async () => {
    const { jar } = await oidcSignIn({ sub: 'role-admin-4', email: 'ra@example.com', roles: ['admin'] });
    const body = await state(jar);
    expect(body.account?.isAdmin).toBe(true);
    const account = await db.account.findUniqueOrThrow({ where: { id: body.account?.id ?? '' } });
    expect(account.isAdmin).toBe(false);
    expect((await db.session.findFirstOrThrow({ where: { accountId: account.id } })).roles).toEqual(['admin']);
    expect((await request(app).get('/api/admin/sessions').set('cookie', cookieHeader(jar))).status).toBe(200);
  });

  it('refuses a callback whose state does not match the one this browser started', async () => {
    const { location, jar } = await oidcSignIn({ sub: 'alice-1', roles: [] }, {}, '/api/auth/oidc/start', (cb) => {
      cb.searchParams.set('state', 'forged');
    });
    expect(location).toMatch(/^\/signin\?signin_error=/);
    expect(jar['postroom_session']).toBeUndefined();
  });

  it('refuses a callback from a browser that never started a sign-in', async () => {
    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=def');
    expect(res.status).toBe(302);
    expect(String(res.headers['location'])).toMatch(/^\/signin\?signin_error=/);
  });

  it('back-channel logout ends the D3 Auth sessions of that subject, once', async () => {
    const { jar } = await oidcSignIn({ sub: 'bcl-5', email: 'bcl@example.com', roles: [] });
    expect((await state(jar)).signedIn).toBe(true);
    // A second D3 Auth session for the same subject: back-channel logout ends both, looked up by
    // (oidcIssuer, oidcSubject).
    const second = await oidcSignIn({ sub: 'bcl-5', email: 'bcl@example.com', roles: [] });
    expect((await state(second.jar)).signedIn).toBe(true);

    const bad = await request(app).post('/api/auth/oidc/backchannel-logout').type('form').send({ logout_token: 'nope' });
    expect(bad.status).toBe(400);

    const token = issuer.logoutToken('bcl-5');
    // Server-to-server: no CSRF header, no cookie — the signed token is the authentication.
    const res = await request(app).post('/api/auth/oidc/backchannel-logout').type('form').send({ logout_token: token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ended: 2, repeated: false });
    expect((await state(jar)).signedIn).toBe(false);
    expect((await state(second.jar)).signedIn).toBe(false);

    const again = await request(app).post('/api/auth/oidc/backchannel-logout').type('form').send({ logout_token: token });
    expect(again.body).toMatchObject({ ok: true, ended: 0, repeated: true });
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
