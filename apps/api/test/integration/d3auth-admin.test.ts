// PST-T-17.6 doneWhen (PST-ADR-014, PST-REQ-201/202/204): Sign in with D3 Auth configured from the
// console — saved with the secret sealed under the KEK, winning over the D3AUTH_* env, swapped in
// without a restart so /api/auth/state and the sign-in start follow it at once, turned off over the
// env, tested by discovery — and the caller's linked identities listed and unlinked.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { kekFromBase64, openWithKek } from '@postroom/crypto';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeIssuer, type FakeIssuer, type FakeIssuerUser } from '../../../../e2e/fake-issuer/server.mjs';
import { createApp } from '../../src/app.js';
import type { ApiConfig } from '../../src/deps.js';
import { request } from '../loopback.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, createD3AuthAccount, KEK_BASE64, TestClock, totpCode, WEB_ORIGIN } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PATH = '/api/admin/auth/d3auth';
const SECRET_A = 'issuer-a-client-secret-0123456789';
const SECRET_B = 'issuer-b-client-secret-9876543210';

interface View {
  source: string;
  enabled: boolean;
  issuer: string | null;
  clientId: string | null;
  secretSet: boolean;
  status: string;
  lastError: string | null;
  redirectUri: string;
  backchannelLogoutUri: string;
  postLogoutRedirectUri: string;
  manifest: Record<string, unknown>;
}

interface StateBody {
  oidcConfigured: boolean;
  oidcAvailable: boolean;
  signedIn: boolean;
  method?: string;
  account?: { id: string };
}

describe.skipIf(!baseUrl)('Sign in with D3 Auth from the console (PST-T-17.6, PST-ADR-014)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let issuerA: FakeIssuer;
  let issuerB: FakeIssuer;
  let app: Express;
  const clock = new TestClock();
  const PASSWORD = 'operator password, long enough';
  const BOB_PASSWORD = 'bob has a long password too';
  let operator: { id: string; totpSecret: string };
  let bob: { id: string; totpSecret: string };
  let opJar: Record<string, string> = {};
  let bobJar: Record<string, string> = {};
  let guardMissesBefore = 0;

  /** The server as the operator's env file sets it up: D3AUTH_* pointing at issuer A. */
  const envA = (): Partial<ApiConfig> => ({ d3authIssuer: issuerA.url, d3authClientId: 'postroom-a', d3authClientSecret: SECRET_A });
  /** A fresh process: a new deps object is a new runtime, which reads the row at boot. */
  const boot = (extra: Partial<ApiConfig> = {}): Express => createApp({ db, env: {}, config: baseConfig(clock, extra) });

  const state = async (on: Express, jar: Record<string, string> = {}): Promise<StateBody> =>
    (await request(on).get('/api/auth/state').set('cookie', cookieHeader(jar))).body as StateBody;

  const view = async (on: Express): Promise<View> => {
    const res = await request(on).get(PATH).set('cookie', cookieHeader(opJar));
    expect(res.status).toBe(200);
    return res.body as View;
  };

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

  /** Where /oidc/start sends the browser. */
  const startLocation = async (on: Express): Promise<string> => {
    const res = await request(on).get('/api/auth/oidc/start');
    expect(res.status).toBe(302);
    return String(res.headers['location']);
  };

  /** Browser round trip: /oidc/start → issuer /authorize → our /oidc/callback, cookies carried. */
  const oidcSignIn = async (
    on: Express,
    issuer: FakeIssuer,
    user: FakeIssuerUser,
    jar: Record<string, string> = {},
    startPath = '/api/auth/oidc/start',
  ): Promise<{ location: string; jar: Record<string, string> }> => {
    issuer.setUser(user);
    const start = await request(on).get(startPath).set('cookie', cookieHeader(jar));
    expect(start.status).toBe(302);
    const authorizeUrl = String(start.headers['location']);
    expect(authorizeUrl.startsWith(`${issuer.url}/authorize?`)).toBe(true);
    cookiesOf(start, jar);
    const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const callback = new URL(authorized.headers.get('location') ?? '');
    const done = await request(on).get(`${callback.pathname}${callback.search}`).set('cookie', cookieHeader(jar));
    expect(done.status).toBe(302);
    cookiesOf(done, jar);
    return { location: String(done.headers['location']), jar };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t176');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    const seeded = await db.account.findFirstOrThrow({ where: { isAdmin: true } });
    await db.account.delete({ where: { id: seeded.id } });
    operator = await createAccount(db, { login: 'operator', password: PASSWORD, isAdmin: true });
    bob = await createAccount(db, { login: 'bob', password: BOB_PASSWORD });

    issuerA = await startFakeIssuer({ port: 0, clientId: 'postroom-a', clientSecret: SECRET_A });
    issuerB = await startFakeIssuer({ port: 0, clientId: 'postroom-b', clientSecret: SECRET_B });
    app = boot(envA());
    opJar = await signIn(app, 'operator', PASSWORD, operator.totpSecret);
    bobJar = await signIn(app, 'bob', BOB_PASSWORD, bob.totpSecret);
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await issuerA.close();
    await issuerB.close();
    await testDb.drop();
  });

  it('with no saved row the env file applies, and says so — with the URIs and manifest to register', async () => {
    const body = await view(app);
    expect(body).toEqual({
      source: 'server_file',
      enabled: true,
      issuer: issuerA.url,
      clientId: 'postroom-a',
      secretSet: true,
      status: 'available',
      lastError: null,
      redirectUri: `${WEB_ORIGIN}/api/auth/oidc/callback`,
      backchannelLogoutUri: `${WEB_ORIGIN}/api/auth/oidc/backchannel-logout`,
      postLogoutRedirectUri: `${WEB_ORIGIN}/signin`,
      manifest: {
        client_id: 'postroom-a',
        name: 'Postroom',
        client_type: 'confidential_web',
        redirect_uris: [`${WEB_ORIGIN}/api/auth/oidc/callback`],
        post_logout_redirect_uris: [`${WEB_ORIGIN}/signin`],
        backchannel_logout_uri: `${WEB_ORIGIN}/api/auth/oidc/backchannel-logout`,
        roles: [
          { key: 'admin', display: 'Administrator' },
          { key: 'member', display: 'Member', default: true },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain(SECRET_A);
    expect((await startLocation(app)).startsWith(`${issuerA.url}/authorize?`)).toBe(true);
  });

  it('is admin only, and every write needs a fresh step-up', async () => {
    expect((await request(app).get(PATH)).status).toBe(401);
    expect((await request(app).get(PATH).set('cookie', cookieHeader(bobJar))).status).toBe(403);
    expect((await request(app).put(PATH).set(CSRF).set('cookie', cookieHeader(bobJar)).send({})).status).toBe(403);
    expect((await request(app).post(`${PATH}/test`).set(CSRF).set('cookie', cookieHeader(bobJar)).send({})).status).toBe(403);
    const put = await request(app)
      .put(PATH)
      .set(CSRF)
      .set('cookie', cookieHeader(opJar))
      .send({ issuer: issuerB.url, clientId: 'postroom-b', clientSecret: SECRET_B });
    expect(put.status).toBe(403);
    expect(put.body).toEqual({ error: 'step_up_required' });
    const del = await request(app).delete(PATH).set(CSRF).set('cookie', cookieHeader(opJar));
    expect(del.body).toEqual({ error: 'step_up_required' });
    expect(await db.setting.findUnique({ where: { key: 'auth:d3auth' } })).toBeNull();
  });

  it('validates the issuer, the client ID, and a secret when none is saved', async () => {
    await stepUp(app, opJar, operator.totpSecret);
    const put = (body: Record<string, unknown>) => request(app).put(PATH).set(CSRF).set('cookie', cookieHeader(opJar)).send(body);
    for (const issuer of ['http://auth.example.com', 'ftp://auth.example.com', 'https://auth.example.com/?x=1', 'https://u:p@auth.example.com', 'not a url']) {
      const res = await put({ issuer, clientId: 'postroom-b', clientSecret: SECRET_B });
      expect(res.status, issuer).toBe(400);
      expect((res.body as { fields: { path: string }[] }).fields[0]?.path).toBe('issuer');
    }
    expect((await put({ issuer: issuerB.url, clientId: 'has space', clientSecret: SECRET_B })).status).toBe(400);
    const noSecret = await put({ issuer: issuerB.url, clientId: 'postroom-b' });
    expect(noSecret.status).toBe(400);
    expect((noSecret.body as { fields: { path: string }[] }).fields[0]?.path).toBe('clientSecret');
  });

  it('save → the row wins, state flips and the sign-in start goes to the new issuer, with no restart', async () => {
    await stepUp(app, opJar, operator.totpSecret);
    const res = await request(app)
      .put(PATH)
      .set(CSRF)
      .set('cookie', cookieHeader(opJar))
      // A trailing slash is normalised away.
      .send({ issuer: `${issuerB.url}/`, clientId: 'postroom-b', clientSecret: SECRET_B });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'console', enabled: true, issuer: issuerB.url, clientId: 'postroom-b', secretSet: true, status: 'available', lastError: null });
    expect((res.body as View).manifest['client_id']).toBe('postroom-b');
    expect(JSON.stringify(res.body)).not.toContain(SECRET_B);

    expect(await state(app)).toMatchObject({ oidcConfigured: true, oidcAvailable: true });
    expect((await startLocation(app)).startsWith(`${issuerB.url}/authorize?`)).toBe(true);
    // The whole flow against B: its /token accepts only B's client ID and secret (client_secret_basic),
    // so this proves the sealed secret is the one in use. D3 Auth only reaches a linked account
    // (PST-ADR-015), so Carol's is linked first.
    await createD3AuthAccount(db, issuerB.url, 'carol-b', { email: 'carol@example.com' });
    const { location, jar } = await oidcSignIn(app, issuerB, { sub: 'carol-b', email: 'carol@example.com', roles: [] });
    expect(location).toBe('/');
    expect(await state(app, jar)).toMatchObject({ signedIn: true, method: 'oidc' });
  });

  it('seals the secret: the row holds no plaintext, opens under the KEK, and no audit row or response carries it', async () => {
    const row = await db.setting.findUniqueOrThrow({ where: { key: 'auth:d3auth' } });
    const text = JSON.stringify(row.value);
    expect(text).not.toContain(SECRET_B);
    const value = row.value as { enabled: boolean; issuer: string; clientId: string; sealedSecret: string; updatedAt: string };
    expect(value).toMatchObject({ enabled: true, issuer: issuerB.url, clientId: 'postroom-b' });
    expect(Buffer.from(value.sealedSecret, 'base64').toString('utf8')).not.toContain(SECRET_B);
    const opened = openWithKek(kekFromBase64(KEK_BASE64), Buffer.from(value.sealedSecret, 'base64'), 'setting:auth:d3auth').toString('utf8');
    expect(opened).toBe(SECRET_B);
    // Bound to its row: under another AAD it will not open.
    expect(() => openWithKek(kekFromBase64(KEK_BASE64), Buffer.from(value.sealedSecret, 'base64'), 'totp:x')).toThrow();

    const audits = await db.auditEvent.findMany({ where: { action: { startsWith: 'auth.d3auth.' } } });
    expect(audits.map((a) => a.action)).toContain('auth.d3auth.configure');
    const configure = audits.find((a) => a.action === 'auth.d3auth.configure');
    expect(configure?.actorAccountId).toBe(operator.id);
    expect(configure?.after).toMatchObject({ enabled: true, issuer: issuerB.url, clientId: 'postroom-b', changed: ['enabled', 'issuer', 'clientId', 'clientSecret'] });
    for (const audit of audits) {
      const dump = JSON.stringify([audit.before, audit.after]);
      expect(dump).not.toContain(SECRET_B);
      expect(dump).not.toContain(value.sealedSecret);
    }
  });

  it('an update without a secret keeps the sealed one', async () => {
    const before = (await db.setting.findUniqueOrThrow({ where: { key: 'auth:d3auth' } })).value as { sealedSecret: string };
    await stepUp(app, opJar, operator.totpSecret);
    const res = await request(app).put(PATH).set(CSRF).set('cookie', cookieHeader(opJar)).send({ issuer: issuerB.url, clientId: 'postroom-b' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ secretSet: true, status: 'available' });
    const after = (await db.setting.findUniqueOrThrow({ where: { key: 'auth:d3auth' } })).value as { sealedSecret: string };
    expect(after.sealedSecret).toBe(before.sealedSecret);
    const latest = await db.auditEvent.findFirstOrThrow({ where: { action: 'auth.d3auth.configure' }, orderBy: { at: 'desc' } });
    expect(latest.after).toMatchObject({ changed: [] });
    const { location } = await oidcSignIn(app, issuerB, { sub: 'carol-b', roles: [] });
    expect(location).toBe('/');
  });

  it('a restarted server reads the saved row at boot, over its env file', async () => {
    const restarted = boot(envA());
    expect(await view(restarted)).toMatchObject({ source: 'console', issuer: issuerB.url, clientId: 'postroom-b', status: 'available' });
    expect((await startLocation(restarted)).startsWith(`${issuerB.url}/authorize?`)).toBe(true);
  });

  it('the server key not loaded: the env file applies and the reason is reported; saving is refused', async () => {
    const keyless = boot({ ...envA(), kekBase64: undefined });
    const body = await view(keyless);
    expect(body).toMatchObject({ source: 'server_file', issuer: issuerA.url, status: 'available', lastError: 'The server key is not loaded; the saved settings cannot be read' });
    await stepUp(app, opJar, operator.totpSecret);
    const res = await request(keyless).put(PATH).set(CSRF).set('cookie', cookieHeader(opJar)).send({ issuer: issuerB.url, clientId: 'postroom-b', clientSecret: SECRET_B });
    expect(res.status).toBe(503);
  });

  it('tests discovery against a given issuer or the one in force, saving nothing', async () => {
    const test = (body: Record<string, unknown>) => request(app).post(`${PATH}/test`).set(CSRF).set('cookie', cookieHeader(opJar)).send(body);
    const given = await test({ issuer: issuerA.url });
    expect(given.status).toBe(200);
    expect(given.body).toEqual({ ok: true, issuer: issuerA.url, authorizationEndpoint: `${issuerA.url}/authorize` });
    const inForce = await test({});
    expect(inForce.body).toMatchObject({ ok: true, issuer: issuerB.url });
    const closed = await test({ issuer: 'http://127.0.0.1:1' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ ok: false, issuer: 'http://127.0.0.1:1' });
    expect(typeof (closed.body as { error?: unknown }).error).toBe('string');
    expect((await test({ issuer: 'http://auth.example.com' })).status).toBe(400);
    expect(await db.auditEvent.count({ where: { action: 'auth.d3auth.test' } })).toBe(3);
    expect(((await db.setting.findUniqueOrThrow({ where: { key: 'auth:d3auth' } })).value as { issuer: string }).issuer).toBe(issuerB.url);
  });

  it('turn off: wins over the env file, the button goes, and stays gone after a restart', async () => {
    await stepUp(app, opJar, operator.totpSecret);
    const res = await request(app).delete(PATH).set(CSRF).set('cookie', cookieHeader(opJar));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'console', enabled: false, secretSet: false, status: 'not_configured', lastError: null });
    expect((res.body as View).manifest['client_id']).toBe('postroom');
    expect(await state(app)).toMatchObject({ oidcConfigured: false, oidcAvailable: false });
    expect(await startLocation(app)).toMatch(/^\/signin\?signin_error=/);
    const row = await db.setting.findUniqueOrThrow({ where: { key: 'auth:d3auth' } });
    expect(row.value).toMatchObject({ enabled: false });
    expect(row.value).not.toHaveProperty('sealedSecret');
    expect(await db.auditEvent.count({ where: { action: 'auth.d3auth.disable', actorAccountId: operator.id } })).toBe(1);

    const restarted = boot(envA());
    expect(await view(restarted)).toMatchObject({ source: 'console', enabled: false, status: 'not_configured' });
    expect(await state(restarted)).toMatchObject({ oidcConfigured: false });

    // Turned off, a save needs the secret again.
    await stepUp(app, opJar, operator.totpSecret);
    const noSecret = await request(app).put(PATH).set(CSRF).set('cookie', cookieHeader(opJar)).send({ issuer: issuerB.url, clientId: 'postroom-b' });
    expect(noSecret.status).toBe(400);
  });

  it('with the row gone the env file applies again; a server with no env flips on when saved', async () => {
    await db.setting.delete({ where: { key: 'auth:d3auth' } });
    expect(await view(boot(envA()))).toMatchObject({ source: 'server_file', issuer: issuerA.url });

    const bare = boot();
    expect(await view(bare)).toMatchObject({ source: 'none', enabled: false, issuer: null, clientId: null, secretSet: false, status: 'not_configured', lastError: null });
    expect(await state(bare)).toMatchObject({ oidcConfigured: false, oidcAvailable: false });
    await stepUp(bare, opJar, operator.totpSecret);
    const res = await request(bare).put(PATH).set(CSRF).set('cookie', cookieHeader(opJar)).send({ issuer: issuerB.url, clientId: 'postroom-b', clientSecret: SECRET_B });
    expect(res.status).toBe(200);
    expect(await state(bare)).toMatchObject({ oidcConfigured: true, oidcAvailable: true });
    expect((await startLocation(bare)).startsWith(`${issuerB.url}/authorize?`)).toBe(true);
  });

  it('a saved issuer that does not answer is configured but unavailable, with the reason', async () => {
    const bare = boot();
    await stepUp(bare, opJar, operator.totpSecret);
    const res = await request(bare).put(PATH).set(CSRF).set('cookie', cookieHeader(opJar)).send({ issuer: 'http://127.0.0.1:1', clientId: 'postroom-b', clientSecret: SECRET_B });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'console', status: 'unavailable' });
    expect(typeof (res.body as View).lastError).toBe('string');
    expect(await state(bare)).toMatchObject({ oidcConfigured: true, oidcAvailable: false });
    // Back to B for the identity tests below, through `app`.
    await stepUp(app, opJar, operator.totpSecret);
    expect((await request(app).put(PATH).set(CSRF).set('cookie', cookieHeader(opJar)).send({ issuer: issuerB.url, clientId: 'postroom-b', clientSecret: SECRET_B })).status).toBe(200);
  });

  describe('linked identities (PST-REQ-202)', () => {
    let linkId = '';
    let oidcJar: Record<string, string> = {};

    it('lists the caller’s own links after a deliberate link', async () => {
      const fresh = await signIn(app, 'operator', PASSWORD, operator.totpSecret);
      const { location } = await oidcSignIn(app, issuerB, { sub: 'op-b', email: 'operator@d3cloud.io', roles: [] }, { ...fresh }, '/api/auth/oidc/start?link=1');
      expect(location).toBe('/');
      // A D3 Auth session through that identity, to be ended by the unlink.
      oidcJar = (await oidcSignIn(app, issuerB, { sub: 'op-b', email: 'operator@d3cloud.io', roles: [] })).jar;
      expect(await state(app, oidcJar)).toMatchObject({ signedIn: true, method: 'oidc', account: { id: operator.id } });

      const res = await request(app).get('/api/account/identities').set('cookie', cookieHeader(opJar));
      expect(res.status).toBe(200);
      const list = res.body as { id: string; issuer: string; email: string | null; linkedAt: string; lastUsedAt: string | null }[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ issuer: issuerB.url, email: 'operator@d3cloud.io' });
      expect(Object.keys(list[0] ?? {}).sort()).toEqual(['email', 'id', 'issuer', 'lastUsedAt', 'linkedAt']);
      expect(typeof list[0]?.lastUsedAt).toBe('string');
      linkId = list[0]?.id ?? '';
      // Bob sees none of them.
      expect((await request(app).get('/api/account/identities').set('cookie', cookieHeader(bobJar))).body).toEqual([]);
      expect((await request(app).get('/api/account/identities')).status).toBe(401);
    });

    it('another account’s link is not found, and unlinking needs a step-up', async () => {
      await stepUp(app, bobJar, bob.totpSecret);
      const foreign = await request(app).delete(`/api/account/identities/${linkId}`).set(CSRF).set('cookie', cookieHeader(bobJar));
      expect(foreign.status).toBe(404);
      expect((await request(app).delete('/api/account/identities/not-a-uuid').set(CSRF).set('cookie', cookieHeader(bobJar))).status).toBe(404);
      // The operator's last step-up, past its five minutes.
      clock.advance(5 * 60 * 1000 + 1_000);
      const refused = await request(app).delete(`/api/account/identities/${linkId}`).set(CSRF).set('cookie', cookieHeader(opJar));
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: 'step_up_required' });
      expect(await db.identityLink.count({ where: { id: linkId } })).toBe(1);
    });

    it('unlinks, audited, and ends the sessions that signed in through it — not the password session', async () => {
      await stepUp(app, opJar, operator.totpSecret);
      const res = await request(app).delete(`/api/account/identities/${linkId}`).set(CSRF).set('cookie', cookieHeader(opJar));
      expect(res.status).toBe(200);
      // Two came through it: the one the link round trip itself signed in, and the later D3 Auth sign-in.
      expect(res.body).toEqual({ ok: true, endedSessions: 2, signedOut: false });
      expect(await db.identityLink.count({ where: { id: linkId } })).toBe(0);
      expect(await state(app, oidcJar)).toMatchObject({ signedIn: false });
      expect(await state(app, opJar)).toMatchObject({ signedIn: true });
      const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'auth.identity.unlink', entityId: linkId } });
      expect(audit.actorAccountId).toBe(operator.id);
      expect(audit.before).toMatchObject({ issuer: issuerB.url, subject: 'op-b' });
      expect(await db.auditEvent.count({ where: { action: 'auth.session.revoke-identity', entityId: linkId } })).toBe(1);
      expect((await request(app).get('/api/account/identities').set('cookie', cookieHeader(opJar))).body).toEqual([]);
    });
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
