// PST-P-19, the D3 App contract (PST-T-19.1, PST-T-19.2): the manifest; a native sign-in in JSON —
// password, then the code — that leaves an ordinary session named by its device and reached with a
// Bearer token; refresh rotation where a rotated token presented again ends the session; revoke;
// a recovery code that enrols a new authenticator inside the sign-in (CON-ADR-014); and every
// refusal as problem+json with the contract's registered type.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { request } from '../loopback.js';
import { baseConfig, cookieHeader, cookiesOf, TestClock, totpCode, WEB_ORIGIN } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const OPERATOR = { displayName: 'Matt', login: 'matt', password: 'correct horse battery staple' };
const DEVICE = { name: "Matt's iPhone", platform: 'ios' };
const PROBLEM = 'https://d3cloud.io/problems/';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  session: { id: string };
}

const problemOf = (res: { status: number; headers: Record<string, string>; text: string }): string => {
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = JSON.parse(res.text) as { type: string; status: number };
  expect(body.status).toBe(res.status);
  return body.type.startsWith(PROBLEM) ? body.type.slice(PROBLEM.length) : body.type;
};

describe.skipIf(!baseUrl)('the D3 App contract (PST-P-19)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let operatorId = '';
  let secret = '';
  let codes: string[] = [];
  let guardMissesBefore = 0;

  const native = (path: string) => request(app).post(`/api/auth/native/${path}`);
  const passwordStep = async (): Promise<string> => {
    const res = await native('signin').send({ email: OPERATOR.login, password: OPERATOR.password, device: DEVICE });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ next: 'totp' });
    return (res.body as { challenge: string }).challenge;
  };
  const signIn = async (): Promise<Tokens> => {
    const challenge = await passwordStep();
    clock.advance(31_000);
    const res = await native('signin').send({ challenge, totp: totpCode(secret, clock.now()) });
    expect(res.status).toBe(200);
    return res.body as Tokens;
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_p19');
    db = testDb.db;
    operatorId = (await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' })).operatorId;
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;

    const begin = await request(app).post('/api/auth/setup/begin').set(CSRF).send(OPERATOR);
    expect(begin.status).toBe(200);
    const body = begin.body as { enrolToken: string; secret: string };
    secret = body.secret;
    const done = await request(app).post('/api/auth/setup/complete').set(CSRF).send({ enrolToken: body.enrolToken, code: totpCode(secret, clock.now()) });
    expect(done.status).toBe(200);
    codes = (done.body as { recoveryCodes: string[] }).recoveryCodes;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('serves the manifest at the root, naming the native endpoints on this origin', async () => {
    const res = await request(app).get('/.well-known/d3-app.json');
    expect(res.status).toBe(200);
    const manifest = res.body as { product: string; contract: number; capabilities: string[]; signIn: { methods: string[] }; endpoints: Record<string, string | null> };
    expect(manifest.product).toBe('postroom');
    expect(manifest.contract).toBe(1);
    expect(manifest.capabilities).toContain('postroom.mail');
    expect(manifest.signIn.methods).toEqual(expect.arrayContaining(['password', 'totp', 'recovery_code']));
    expect(manifest.endpoints['nativeSignIn']).toBe(`${WEB_ORIGIN}/api/auth/native/signin`);
    expect(manifest.endpoints['nativeRefresh']).toBe(`${WEB_ORIGIN}/api/auth/native/refresh`);
    expect(manifest.endpoints['me']).toBe(`${WEB_ORIGIN}/api/auth/native/me`);
  });

  it('password then code gives a named session, reached with a Bearer token and no cookie', async () => {
    const tokens = await signIn();
    expect(tokens.expiresIn).toBeLessThanOrEqual(15 * 60);
    expect(tokens.accessToken).not.toBe(tokens.refreshToken);

    const me = await request(app).get('/api/auth/native/me').set(bearer(tokens.accessToken));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ accountId: operatorId, displayName: OPERATOR.displayName, roles: ['admin'] });

    // The same token reaches the ordinary API, and passes CSRF without a header: it is not a cookie.
    const listed = await request(app).get('/api/auth/sessions').set(bearer(tokens.accessToken));
    expect(listed.status).toBe(200);
    const row = (listed.body as { sessions: { id: string; deviceName: string | null; devicePlatform: string | null; current: boolean }[] }).sessions.find((s) => s.id === tokens.session.id);
    expect(row).toMatchObject({ deviceName: DEVICE.name, devicePlatform: 'ios', current: true });

    const stored = await db.session.findUniqueOrThrow({ where: { id: tokens.session.id } });
    expect(stored.native).toBe(true);
    expect(stored.idHash).not.toBe(tokens.accessToken);

    // A native token is never a cookie: presented as one, it opens nothing.
    const asCookie = await request(app).get('/api/auth/sessions').set('cookie', `postroom_session=${tokens.accessToken}`);
    expect(asCookie.status).toBe(401);

    const audit = await db.auditEvent.findFirst({ where: { action: 'auth.signin', entityId: tokens.session.id } });
    expect(audit?.after).toMatchObject({ via: 'native', device: DEVICE.name });
  });

  it('refresh rotates; a rotated token presented again ends the session', async () => {
    const tokens = await signIn();
    const rotated = await native('refresh').send({ refreshToken: tokens.refreshToken });
    expect(rotated.status).toBe(200);
    const next = rotated.body as Tokens;
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect(next.accessToken).not.toBe(tokens.accessToken);
    // The old access token died with the rotation.
    expect((await request(app).get('/api/auth/native/me').set(bearer(tokens.accessToken))).status).toBe(401);
    expect((await request(app).get('/api/auth/native/me').set(bearer(next.accessToken))).status).toBe(200);

    const replay = await native('refresh').send({ refreshToken: tokens.refreshToken });
    expect(replay.status).toBe(401);
    expect(problemOf(replay)).toBe('refresh_reused');
    expect(await db.session.findUnique({ where: { id: tokens.session.id } })).toBeNull();
    const after = await native('refresh').send({ refreshToken: next.refreshToken });
    expect(problemOf(after)).toBe('session_revoked');
    expect(await db.auditEvent.count({ where: { action: 'auth.native.refresh_reused', entityId: tokens.session.id } })).toBe(1);
  });

  it('an idle phone stays listed after its access token lapses, and refresh still works', async () => {
    const tokens = await signIn();
    clock.advance(16 * 60 * 1000);
    expect((await request(app).get('/api/auth/native/me').set(bearer(tokens.accessToken))).status).toBe(401);
    const web = await signIn();
    const listed = await request(app).get('/api/auth/sessions').set(bearer(web.accessToken));
    expect((listed.body as { sessions: { id: string }[] }).sessions.map((s) => s.id)).toContain(tokens.session.id);
    expect((await native('refresh').send({ refreshToken: tokens.refreshToken })).status).toBe(200);
  });

  it('revoke ends the session and its refresh token', async () => {
    const tokens = await signIn();
    const revoked = await native('revoke').set(bearer(tokens.accessToken));
    expect(revoked.status).toBe(204);
    const again = await native('refresh').send({ refreshToken: tokens.refreshToken });
    expect(problemOf(again)).toBe('session_revoked');
  });

  it('revoking the phone from the web signs the app out, and both session lists name it (PST-T-19.4)', async () => {
    const phone = await signIn();
    const pw = await request(app).post('/api/auth/signin').set(CSRF).send({ login: OPERATOR.login, password: OPERATOR.password });
    expect(pw.status).toBe(200);
    clock.advance(31_000);
    const web = await request(app)
      .post('/api/auth/signin/totp')
      .set(CSRF)
      .send({ challenge: (pw.body as { challenge: string }).challenge, code: totpCode(secret, clock.now()) });
    expect(web.status).toBe(200);
    const cookie = cookieHeader(cookiesOf(web));

    const admin = await request(app).get('/api/admin/sessions').set('cookie', cookie);
    expect(admin.status).toBe(200);
    expect((admin.body as { sessions: { id: string; deviceName: string | null }[] }).sessions.find((s) => s.id === phone.session.id)?.deviceName).toBe(DEVICE.name);

    // Ending a session is step-up gated (ASVS 5.0 7.5.2), for a phone as for a browser.
    clock.advance(31_000);
    const stepUp = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(secret, clock.now()) });
    expect(stepUp.status).toBe(200);
    const ended = await request(app).delete(`/api/auth/sessions/${phone.session.id}`).set(CSRF).set('cookie', cookie);
    expect(ended.status).toBe(200);
    expect((await request(app).get('/api/auth/native/me').set(bearer(phone.accessToken))).status).toBe(401);
    expect(problemOf(await native('refresh').send({ refreshToken: phone.refreshToken }))).toBe('session_revoked');
  });

  it('refusals are registered problems, and an unknown login reads like a wrong password', async () => {
    const wrong = await native('signin').send({ email: OPERATOR.login, password: 'nope', device: DEVICE });
    expect(wrong.status).toBe(401);
    expect(problemOf(wrong)).toBe('invalid_credentials');
    const unknown = await native('signin').send({ email: 'nobody@example.test', password: 'nope' });
    expect(problemOf(unknown)).toBe('invalid_credentials');

    const challenge = await passwordStep();
    clock.advance(31_000);
    const right = totpCode(secret, clock.now());
    const bad = String((Number(right) + 1) % 1_000_000).padStart(6, '0');
    const code = await native('signin').send({ challenge, totp: bad });
    expect(code.status).toBe(401);
    expect(problemOf(code)).toBe('invalid_code');
    const forged = await native('signin').send({ challenge: 'not-a-challenge', totp: right });
    expect(problemOf(forged)).toBe('invalid_code');

    const me = await request(app).get('/api/auth/native/me');
    expect(me.status).toBe(401);
    expect(problemOf(me)).toBe('session_revoked');
    clock.advance(60 * 60 * 1000); // past the throttle window for the next test
  });

  it('a recovery code enrols a new authenticator inside the sign-in, and ends every other session', async () => {
    const other = await signIn();
    const challenge = await passwordStep();
    const recovery = await native('signin').send({ challenge, recoveryCode: codes[0] });
    expect(recovery.status).toBe(403);
    expect(problemOf(recovery)).toBe('reenrol_required');
    const body = JSON.parse(recovery.text) as { challenge: string; enrolment: { secret: string; otpauthUri: string; digits: number; period: number } };
    expect(body.enrolment).toMatchObject({ digits: 6, period: 30 });
    expect(body.enrolment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // The code is spent now, whatever happens next.
    expect(await db.recoveryCode.count({ where: { accountId: operatorId, usedAt: { not: null } } })).toBe(1);

    // A wrong first code leaves the challenge usable.
    const fresh = body.enrolment.secret;
    clock.advance(31_000);
    const good = totpCode(fresh, clock.now());
    const wrongCode = await native('signin').send({ challenge: body.challenge, enrolTotp: String((Number(good) + 1) % 1_000_000).padStart(6, '0') });
    expect(problemOf(wrongCode)).toBe('invalid_code');

    const enrolled = await native('signin').send({ challenge: body.challenge, enrolTotp: good });
    expect(enrolled.status).toBe(200);
    const done = enrolled.body as Tokens & { recoveryCodes: string[] };
    expect(done.recoveryCodes).toHaveLength(10);
    expect((await request(app).get('/api/auth/native/me').set(bearer(done.accessToken))).status).toBe(200);
    // The other phone is signed out; the old authenticator no longer works.
    expect((await request(app).get('/api/auth/native/me').set(bearer(other.accessToken))).status).toBe(401);
    expect(problemOf(await native('refresh').send({ refreshToken: other.refreshToken }))).toBe('session_revoked');
    secret = fresh;
    await signIn();
    // The old sheet of codes is gone with the old authenticator.
    expect(await db.recoveryCode.count({ where: { accountId: operatorId, usedAt: null } })).toBe(10);
  });

  it('wrote an audit row for every successful mutation', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
