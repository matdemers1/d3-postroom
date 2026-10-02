// PST-T-17.6 hardening (PST-ADR-014), from adversarial verification: turning off never depends on
// the KEK; a sealed secret never follows a changed issuer or client ID; an in-flight sign-in is bound
// to the client it started with; turning off or retargeting ends D3 Auth sessions; saves are
// serialised; the last way into an account cannot be unlinked; the discovery test is capped.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeIssuer, type FakeIssuer, type FakeIssuerUser } from '../../../../e2e/fake-issuer/server.mjs';
import { createApp } from '../../src/app.js';
import type { ApiConfig } from '../../src/deps.js';
import { request } from '../loopback.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, createD3AuthAccount, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PATH = '/api/admin/auth/d3auth';
const SECRET_A = 'issuer-a-client-secret-0123456789';
const SECRET_B = 'issuer-b-client-secret-9876543210';
const RETYPE = 'Enter the client secret again when the issuer or client ID changes.';
const CHANGED = 'Sign-in settings changed while you were signing in. Try again.';

interface View {
  source: string;
  enabled: boolean;
  issuer: string | null;
  clientId: string | null;
  status: string;
  signedOut?: boolean;
}

describe.skipIf(!baseUrl)('D3 Auth settings hardening (PST-T-17.6)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let issuerA: FakeIssuer;
  let issuerB: FakeIssuer;
  let app: Express;
  const clock = new TestClock();
  const PASSWORD = 'operator password, long enough';
  let operator: { id: string; totpSecret: string };
  let opJar: Record<string, string> = {};
  let guardMissesBefore = 0;

  const envA = (): Partial<ApiConfig> => ({ d3authIssuer: issuerA.url, d3authClientId: 'postroom-a', d3authClientSecret: SECRET_A });
  const boot = (extra: Partial<ApiConfig> = {}): Express => createApp({ db, env: {}, config: baseConfig(clock, extra) });
  const state = async (on: Express, jar: Record<string, string> = {}): Promise<{ oidcConfigured: boolean; signedIn: boolean; method?: string }> =>
    (await request(on).get('/api/auth/state').set('cookie', cookieHeader(jar))).body as { oidcConfigured: boolean; signedIn: boolean; method?: string };
  const row = async (): Promise<unknown> => (await db.setting.findUnique({ where: { key: 'auth:d3auth' } }))?.value ?? null;

  const signIn = async (on: Express, login: string, password: string, secret: string): Promise<Record<string, string>> => {
    clock.advance(31_000);
    const first = await request(on).post('/api/auth/signin').set(CSRF).send({ login, password });
    expect(first.status).toBe(200);
    const second = await request(on)
      .post('/api/auth/signin/totp')
      .set(CSRF)
      .send({ challenge: (first.body as { challenge: string }).challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookiesOf(second);
  };

  const stepUp = async (on: Express, jar: Record<string, string>, secret: string): Promise<void> => {
    clock.advance(31_000);
    const res = await request(on).post('/api/auth/step-up').set(CSRF).set('cookie', cookieHeader(jar)).send({ code: totpCode(secret, clock.now()) });
    expect(res.status).toBe(200);
  };

  const put = (on: Express, body: Record<string, unknown>, jar = opJar) => request(on).put(PATH).set(CSRF).set('cookie', cookieHeader(jar)).send(body);

  /** /oidc/start → issuer /authorize: the callback URL the issuer sends the browser back to, and its jar. */
  const beginOidc = async (on: Express, issuer: FakeIssuer, user: FakeIssuerUser, jar: Record<string, string> = {}, startPath = '/api/auth/oidc/start') => {
    issuer.setUser(user);
    const start = await request(on).get(startPath).set('cookie', cookieHeader(jar));
    expect(start.status).toBe(302);
    const authorizeUrl = String(start.headers['location']);
    expect(authorizeUrl.startsWith(`${issuer.url}/authorize?`)).toBe(true);
    cookiesOf(start, jar);
    const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorized.status).toBe(302);
    return { callback: new URL(authorized.headers.get('location') ?? ''), jar };
  };
  const finishOidc = async (on: Express, callback: URL, jar: Record<string, string>) => {
    const done = await request(on).get(`${callback.pathname}${callback.search}`).set('cookie', cookieHeader(jar));
    expect(done.status).toBe(302);
    cookiesOf(done, jar);
    return { location: String(done.headers['location']), jar };
  };
  const oidcSignIn = async (on: Express, issuer: FakeIssuer, user: FakeIssuerUser, jar: Record<string, string> = {}, startPath?: string) => {
    const begun = await beginOidc(on, issuer, user, jar, startPath);
    return finishOidc(on, begun.callback, begun.jar);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t176h');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    const seeded = await db.account.findFirstOrThrow({ where: { isAdmin: true } });
    await db.account.delete({ where: { id: seeded.id } });
    operator = await createAccount(db, { login: 'operator', password: PASSWORD, isAdmin: true });
    issuerA = await startFakeIssuer({ port: 0, clientId: 'postroom-a', clientSecret: SECRET_A });
    issuerB = await startFakeIssuer({ port: 0, clientId: 'postroom-b', clientSecret: SECRET_B });
    app = boot();
    opJar = await signIn(app, 'operator', PASSWORD, operator.totpSecret);
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await issuerA.close();
    await issuerB.close();
    await testDb.drop();
  });

  it('turn off wins over the env file even with the server key not loaded, and stays off after a restart', async () => {
    const keyless = boot({ ...envA(), kekBase64: undefined });
    expect(await state(keyless)).toMatchObject({ oidcConfigured: true });
    // Step-up itself needs the key (it opens the TOTP secret), so it happens on a keyed server; the
    // session row it marks is the same one.
    await stepUp(app, opJar, operator.totpSecret);
    const res = await request(keyless).delete(PATH).set(CSRF).set('cookie', cookieHeader(opJar));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'console', enabled: false, status: 'not_configured' });
    expect(await state(keyless)).toMatchObject({ oidcConfigured: false });
    const restarted = boot({ ...envA(), kekBase64: undefined });
    expect(await state(restarted)).toMatchObject({ oidcConfigured: false });
    expect(((await request(restarted).get(PATH).set('cookie', cookieHeader(opJar))).body as View).source).toBe('console');
    await db.setting.delete({ where: { key: 'auth:d3auth' } });
  });

  it('a changed issuer or client ID needs the secret again; the same ones keep it', async () => {
    await stepUp(app, opJar, operator.totpSecret);
    expect((await put(app, { issuer: issuerB.url, clientId: 'postroom-b', clientSecret: SECRET_B })).status).toBe(200);
    const saved = await row();

    for (const body of [{ issuer: issuerA.url, clientId: 'postroom-b' }, { issuer: issuerB.url, clientId: 'postroom-other' }]) {
      const res = await put(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_request', fields: [{ path: 'clientSecret', message: RETYPE }] });
      expect(await row()).toEqual(saved);
    }
    // The same issuer (a trailing slash is the same issuer) and client ID: the sealed one is kept.
    const same = await put(app, { issuer: `${issuerB.url}/`, clientId: 'postroom-b' });
    expect(same.status).toBe(200);
    expect((await row()) as { sealedSecret: string }).toMatchObject({ sealedSecret: (saved as { sealedSecret: string }).sealedSecret });
  });

  it('refuses to unlink the last way into an account with no password', async () => {
    const dora = await createAccount(db, { login: 'dora', password: 'dora has a long password' });
    await db.identityLink.create({ data: { accountId: dora.id, issuer: issuerB.url, subject: 'dora-b' } });
    const { location, jar } = await oidcSignIn(app, issuerB, { sub: 'dora-b', roles: [] });
    expect(location).toBe('/');
    await db.account.update({ where: { id: dora.id }, data: { passwordHash: null } });
    const link = await db.identityLink.findFirstOrThrow({ where: { accountId: dora.id } });
    await stepUp(app, jar, dora.totpSecret);
    const refused = await request(app).delete(`/api/account/identities/${link.id}`).set(CSRF).set('cookie', cookieHeader(jar));
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'last_sign_in_method' });
    expect(await db.identityLink.count({ where: { id: link.id } })).toBe(1);

    // With a second identity, one of them can go.
    await db.identityLink.create({ data: { accountId: dora.id, issuer: issuerB.url, subject: 'dora-b-2' } });
    const second = await db.identityLink.findFirstOrThrow({ where: { subject: 'dora-b-2' } });
    const ok = await request(app).delete(`/api/account/identities/${second.id}`).set(CSRF).set('cookie', cookieHeader(jar));
    expect(ok.status).toBe(200);
  });

  it('retargeting ends every D3 Auth session, audited; an unchanged save and password sessions are left alone', async () => {
    // D3 Auth only reaches a linked account (PST-ADR-015).
    await createD3AuthAccount(db, issuerB.url, 'carol-b', { email: 'carol@example.com' });
    const carol = (await oidcSignIn(app, issuerB, { sub: 'carol-b', email: 'carol@example.com', roles: [] })).jar;
    expect(await state(app, carol)).toMatchObject({ signedIn: true, method: 'oidc' });

    await stepUp(app, opJar, operator.totpSecret);
    const unchanged = await put(app, { issuer: issuerB.url, clientId: 'postroom-b' });
    expect(unchanged.status).toBe(200);
    expect((unchanged.body as View).signedOut).toBe(false);
    expect(await state(app, carol)).toMatchObject({ signedIn: true });

    const retarget = await put(app, { issuer: issuerA.url, clientId: 'postroom-a', clientSecret: SECRET_A });
    expect(retarget.status).toBe(200);
    expect(retarget.body).toMatchObject({ issuer: issuerA.url, signedOut: false });
    expect(await state(app, carol)).toMatchObject({ signedIn: false });
    expect(await state(app, opJar)).toMatchObject({ signedIn: true });
    expect(await db.session.count({ where: { method: 'oidc' } })).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'auth.session.revoke-d3auth' }, orderBy: { at: 'desc' } });
    expect(audit.after).toMatchObject({ reason: 'retargeted' });
    expect((audit.after as { count: number }).count).toBeGreaterThanOrEqual(1);
  });

  it('a sign-in started against one client is refused at the callback once the settings change, and the new token endpoint is never called', async () => {
    const begun = await beginOidc(app, issuerA, { sub: 'erin-a', roles: [] });
    await stepUp(app, opJar, operator.totpSecret);
    expect((await put(app, { issuer: issuerB.url, clientId: 'postroom-b', clientSecret: SECRET_B })).status).toBe(200);
    const tokensA = issuerA.stats.token;
    const tokensB = issuerB.stats.token;
    const { location, jar } = await finishOidc(app, begun.callback, begun.jar);
    expect(location.startsWith('/signin?')).toBe(true);
    expect(new URL(location, 'http://x').searchParams.get('signin_error')).toBe(CHANGED);
    expect(jar['postroom_session']).toBeUndefined();
    expect(issuerB.stats.token).toBe(tokensB);
    expect(issuerA.stats.token).toBe(tokensA);
    expect(await db.identityLink.count({ where: { subject: 'erin-a' } })).toBe(0);
  });

  it('a turn-off that commits during the code exchange still stops the session being issued', async () => {
    // The row is written behind the in-process provider's back: the callback's first check (against
    // the live provider) passes and the code is exchanged, so only the issue-time check can refuse.
    const begun = await beginOidc(app, issuerB, { sub: 'late-b', roles: [] });
    const before = await db.setting.findUniqueOrThrow({ where: { key: 'auth:d3auth' } });
    await db.setting.update({ where: { key: 'auth:d3auth' }, data: { value: { enabled: false, updatedAt: new Date().toISOString() } } });
    try {
      const tokensB = issuerB.stats.token;
      const { location, jar } = await finishOidc(app, begun.callback, begun.jar);
      expect(issuerB.stats.token).toBe(tokensB + 1);
      expect(new URL(location, 'http://x').searchParams.get('signin_error')).toBe(CHANGED);
      expect(jar['postroom_session']).toBeUndefined();
      expect(await db.identityLink.count({ where: { subject: 'late-b' } })).toBe(0);
      const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'auth.oidc.rejected' }, orderBy: { at: 'desc' } });
      expect(audit.after).toMatchObject({ reason: 'settings_changed', stage: 'issue' });
    } finally {
      await db.setting.update({ where: { key: 'auth:d3auth' }, data: { value: before.value as object } });
    }
  });

  it('turning off ends D3 Auth sessions, the caller’s own included — it is told, and its cookie cleared', async () => {
    const fresh = await signIn(app, 'operator', PASSWORD, operator.totpSecret);
    expect((await oidcSignIn(app, issuerB, { sub: 'op-b', roles: [] }, { ...fresh }, '/api/auth/oidc/start?link=1')).location).toBe('/');
    const viaD3 = (await oidcSignIn(app, issuerB, { sub: 'op-b', roles: [] })).jar;
    expect(await state(app, viaD3)).toMatchObject({ signedIn: true, method: 'oidc' });
    await stepUp(app, viaD3, operator.totpSecret);
    const res = await request(app).delete(PATH).set(CSRF).set('cookie', cookieHeader(viaD3));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, signedOut: true });
    expect(cookiesOf(res, { ...viaD3 })['postroom_session']).toBeUndefined();
    expect(await state(app, viaD3)).toMatchObject({ signedIn: false });
    expect(await state(app, opJar)).toMatchObject({ signedIn: true });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'auth.session.revoke-d3auth' }, orderBy: { at: 'desc' } });
    expect(audit.after).toMatchObject({ reason: 'disabled' });
  });

  it('concurrent saves leave the live provider equal to the last committed row', async () => {
    await stepUp(app, opJar, operator.totpSecret);
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((c) => `postroom-${c}`);
    const results = await Promise.all(ids.map((clientId) => put(app, { issuer: issuerB.url, clientId, clientSecret: SECRET_B })));
    for (const r of results) expect(r.status).toBe(200);
    const saved = (await row()) as { clientId: string };
    const view = (await request(app).get(PATH).set('cookie', cookieHeader(opJar))).body as View;
    expect(view.clientId).toBe(saved.clientId);
    const start = await request(app).get('/api/auth/oidc/start');
    expect(new URL(String(start.headers['location'])).searchParams.get('client_id')).toBe(saved.clientId);
  });

  describe('POST /test', () => {
    let huge: Server;
    let hugeUrl = '';

    beforeAll(async () => {
      huge = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ issuer: hugeUrl, authorization_endpoint: `${hugeUrl}/authorize`, padding: 'x'.repeat(1024 * 1024) }));
      });
      await new Promise<void>((resolve) => huge.listen(0, '127.0.0.1', resolve));
      hugeUrl = `http://127.0.0.1:${(huge.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => huge.close(() => {
        resolve();
      }));
    });

    it('refuses a discovery document past 256 KiB', async () => {
      const res = await request(app).post(`${PATH}/test`).set(CSRF).set('cookie', cookieHeader(opJar)).send({ issuer: hugeUrl });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, issuer: hugeUrl });
      expect((res.body as { error: string }).error).toMatch(/256 KiB/);
    });

    it('is limited to ten a minute per account', async () => {
      const fresh = boot();
      const test = () => request(fresh).post(`${PATH}/test`).set(CSRF).set('cookie', cookieHeader(opJar)).send({ issuer: 'http://127.0.0.1:1' });
      for (let i = 0; i < 10; i += 1) expect((await test()).status).toBe(200);
      const limited = await test();
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({ error: 'too_many_attempts' });
      clock.advance(61_000);
      expect((await test()).status).toBe(200);
    });
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
