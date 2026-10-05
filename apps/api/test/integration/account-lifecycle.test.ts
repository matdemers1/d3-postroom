// PST-P-20, the D3 App contract's account lifecycle (`spec/account-lifecycle.md`):
//   PST-T-20.2  an admin invites; the invite makes an account, enrols a second factor and signs in —
//               natively (problem+json, native tokens + recovery codes) or on the web page (cookie);
//               the token then dies, and unknown/used/revoked/expired are one invite_invalid.
//   PST-T-20.3  deletion from the app: Bearer only, the host name typed, a current code checked
//               before the last-owner rule, then 202 {graceUntil} a week out with every session, app
//               password and push registration ended; an admin can restore it in the grace period.
//               The purge after the grace period is apps/worker/test/integration/account-purge.test.ts.
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
const DEVICE = { name: "Sam's iPhone", platform: 'ios' };
const PROBLEM = 'https://d3cloud.io/problems/';
const HOST = new URL(WEB_ORIGIN).hostname;
const DAY_MS = 24 * 60 * 60 * 1000;

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  session: { id: string };
  recoveryCodes?: string[];
}
interface Enrolment {
  challenge: string;
  enrolment: { secret: string; otpauthUri: string; digits: number; period: number };
}

const problemOf = (res: { status: number; headers: Record<string, string>; text: string }): { name: string; detail?: string } => {
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = JSON.parse(res.text) as { type: string; status: number; detail?: string };
  expect(body.status).toBe(res.status);
  return { name: body.type.startsWith(PROBLEM) ? body.type.slice(PROBLEM.length) : body.type, ...(body.detail === undefined ? {} : { detail: body.detail }) };
};

describe.skipIf(!baseUrl)('account lifecycle (PST-P-20)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let operatorId = '';
  let secret = '';
  let jar: Record<string, string> = {};
  let guardMissesBefore = 0;

  const native = (path: string) => request(app).post(`/api/auth/native/${path}`);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const web = () => ({ ...CSRF, cookie: cookieHeader(jar) });
  /** The next unburned step of `s`'s authenticator. */
  const nextCode = (s: string): string => {
    clock.advance(31_000);
    return totpCode(s, clock.now());
  };
  const stepUp = async (): Promise<void> => {
    const res = await request(app).post('/api/auth/step-up').set(web()).send({ code: nextCode(secret) });
    expect(res.status).toBe(200);
  };
  const invite = async (address: string, extra: { isAdmin?: boolean; displayName?: string } = {}): Promise<{ id: string; token: string; url: string }> => {
    await stepUp();
    const res = await request(app).post('/api/admin/people/invites').set(web()).send({ address, ...extra });
    expect(res.status).toBe(201);
    const body = res.body as { id: string; url: string };
    const token = body.url.slice(`${WEB_ORIGIN}/invite/`.length);
    return { id: body.id, token, url: body.url };
  };
  /** Accept natively: both steps. */
  const acceptNatively = async (token: string, password: string): Promise<{ tokens: Tokens; secret: string }> => {
    const first = await native('invite').send({ token, displayName: 'Sam', password, device: DEVICE });
    expect(first.status).toBe(200);
    const e = first.body as Enrolment;
    const second = await native('invite').send({ challenge: e.challenge, enrolTotp: totpCode(e.enrolment.secret, clock.now()) });
    expect(second.status).toBe(200);
    return { tokens: second.body as Tokens, secret: e.enrolment.secret };
  };
  const signInNatively = async (login: string, password: string, s: string): Promise<Tokens> => {
    const first = await native('signin').send({ email: login, password, device: DEVICE });
    expect(first.status).toBe(202);
    const second = await native('signin').send({ challenge: (first.body as { challenge: string }).challenge, totp: nextCode(s) });
    expect(second.status).toBe(200);
    return second.body as Tokens;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_p20');
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
    jar = cookiesOf(done);
  }, 60_000);

  afterAll(async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
    await testDb.drop();
  });

  it('names both endpoints in the manifest', async () => {
    const res = await request(app).get('/.well-known/d3-app.json');
    const endpoints = (res.body as { endpoints: Record<string, string | null> }).endpoints;
    expect(endpoints['inviteAccept']).toBe(`${WEB_ORIGIN}/api/auth/native/invite`);
    expect(endpoints['deleteAccount']).toBe(`${WEB_ORIGIN}/api/auth/native/delete-account`);
  });

  describe('invites (PST-T-20.2)', () => {
    it('an admin invites with a fresh step-up; the link is an /invite/<token> page on this origin', async () => {
      await stepUp();
      clock.advance(6 * 60 * 1000); // the step-up goes stale
      const stale = await request(app).post('/api/admin/people/invites').set(web()).send({ address: 'stale' });
      expect(stale.status).toBe(403);
      expect(stale.body).toMatchObject({ error: 'step_up_required' });

      const made = await invite('alex@d3cloud.io', { displayName: 'Alex' });
      expect(made.url).toMatch(new RegExp(`^${WEB_ORIGIN}/invite/[A-Za-z0-9_-]{40,}$`));
      const row = await db.accountInvite.findUniqueOrThrow({ where: { id: made.id } });
      expect(row.tokenHash).not.toContain(made.token);
      expect(row.localPart).toBe('alex');

      const again = await request(app).post('/api/admin/people/invites').set(web()).send({ address: 'alex' });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ error: 'invite_pending' });
      const taken = await request(app).post('/api/admin/people/invites').set(web()).send({ address: 'matt' });
      expect(taken.body).toMatchObject({ error: 'address_taken' });
      const foreign = await request(app).post('/api/admin/people/invites').set(web()).send({ address: 'x@example.org' });
      expect(foreign.body).toMatchObject({ error: 'foreign_domain' });

      const listed = await request(app).get('/api/admin/people').set(web());
      const invites = (listed.body as { invites: { id: string; address: string; state: string }[] }).invites;
      expect(invites.find((i) => i.id === made.id)).toMatchObject({ address: 'alex@d3cloud.io', state: 'pending' });
      expect(await db.auditEvent.count({ where: { action: 'account.invite.create', entityId: made.id } })).toBe(1);
    });

    it('an unknown token is 410 invite_invalid, never a hint that an account exists', async () => {
      const res = await native('invite').send({ token: 'conformance-nope', displayName: 'X', password: 'a long enough password 1!', device: DEVICE });
      expect(res.status).toBe(410);
      expect(problemOf(res).name).toBe('invite_invalid');
    });

    it('a weak password is 422 weak_password with words a person can act on, and spends nothing', async () => {
      const made = await invite('weak');
      const res = await native('invite').send({ token: made.token, displayName: 'W', password: 'short', device: DEVICE });
      expect(res.status).toBe(422);
      expect(problemOf(res)).toEqual({ name: 'weak_password', detail: 'Use at least 12 characters.' });
      expect((await db.accountInvite.findUniqueOrThrow({ where: { id: made.id } })).acceptedAt).toBeNull();
    });

    it('makes the account at the first step, enrols at the second, signs in natively, and the token dies', async () => {
      const made = await invite('sam');
      const password = 'a sturdy invite password';
      const first = await native('invite').send({ token: made.token, displayName: 'Sam', password, device: DEVICE });
      expect(first.status).toBe(200);
      const e = first.body as Enrolment;
      expect(e.enrolment).toMatchObject({ digits: 6, period: 30 });
      expect(e.enrolment.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

      // The account exists already, its second factor still to come.
      const account = await db.account.findFirstOrThrow({ where: { addresses: { some: { localPart: 'sam' } } }, include: { mailboxes: true } });
      expect(account).toMatchObject({ displayName: 'Sam', isAdmin: false, totpEnabled: false });
      expect(account.mailboxes.map((m) => m.name)).toContain('INBOX');

      // A wrong code leaves the challenge valid.
      const wrong = await native('invite').send({ challenge: e.challenge, enrolTotp: '000000' });
      expect(wrong.status).toBe(401);
      expect(problemOf(wrong).name).toBe('invalid_code');
      const second = await native('invite').send({ challenge: e.challenge, enrolTotp: totpCode(e.enrolment.secret, clock.now()) });
      expect(second.status).toBe(200);
      const tokens = second.body as Tokens;
      expect(tokens.recoveryCodes).toHaveLength(10);
      const me = await request(app).get('/api/auth/native/me').set(bearer(tokens.accessToken));
      expect(me.body).toMatchObject({ accountId: account.id, email: 'sam@d3cloud.io', roles: ['member'] });
      expect(await db.session.findUniqueOrThrow({ where: { id: tokens.session.id } })).toMatchObject({ native: true, deviceName: DEVICE.name });

      const reused = await native('invite').send({ token: made.token, displayName: 'Again', password, device: DEVICE });
      expect(reused.status).toBe(410);
      expect(problemOf(reused).name).toBe('invite_invalid');
      // The challenge is spent too.
      const replay = await native('invite').send({ challenge: e.challenge, enrolTotp: totpCode(e.enrolment.secret, clock.now()) });
      expect(replay.status).toBe(401);
    });

    it('an account left without its second factor is finished by the same token and the same password only', async () => {
      const made = await invite('pat');
      const password = 'pat chooses a long one';
      const first = await native('invite').send({ token: made.token, displayName: 'Pat', password, device: DEVICE });
      expect(first.status).toBe(200);
      clock.advance(16 * 60 * 1000); // the challenge expires
      const expired = await native('invite').send({ challenge: (first.body as Enrolment).challenge, enrolTotp: '123456' });
      expect(problemOf(expired).name).toBe('invalid_code');

      const otherPassword = await native('invite').send({ token: made.token, displayName: 'Pat', password: 'somebody else entirely', device: DEVICE });
      expect(otherPassword.status).toBe(410);
      const resumed = await native('invite').send({ token: made.token, displayName: 'Pat', password, device: DEVICE });
      expect(resumed.status).toBe(200);
      const e = resumed.body as Enrolment;
      const done = await native('invite').send({ challenge: e.challenge, enrolTotp: totpCode(e.enrolment.secret, clock.now()) });
      expect(done.status).toBe(200);
      expect(await db.account.count({ where: { addresses: { some: { localPart: 'pat' } } } })).toBe(1);
      // Finished: the token is dead for good.
      expect((await native('invite').send({ token: made.token, displayName: 'Pat', password, device: DEVICE })).status).toBe(410);
    });

    it('a withdrawn or expired invite is invite_invalid', async () => {
      const withdrawn = await invite('drew');
      await stepUp();
      const revoke = await request(app).delete(`/api/admin/people/invites/${withdrawn.id}`).set(web());
      expect(revoke.status).toBe(200);
      const res = await native('invite').send({ token: withdrawn.token, displayName: 'Drew', password: 'a fine long password', device: DEVICE });
      expect(problemOf(res).name).toBe('invite_invalid');

      const lapsing = await invite('lee');
      clock.advance(8 * DAY_MS);
      const late = await native('invite').send({ token: lapsing.token, displayName: 'Lee', password: 'a fine long password', device: DEVICE });
      expect(problemOf(late).name).toBe('invite_invalid');
      // The operator's web session aged out over those days: sign in again.
      const pw = await request(app).post('/api/auth/signin').set(CSRF).send({ login: OPERATOR.login, password: OPERATOR.password });
      const code = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge: (pw.body as { challenge: string }).challenge, code: nextCode(secret) });
      expect(code.status).toBe(200);
      jar = cookiesOf(code);
    });

    it('the web page takes the same steps and ends in the session cookie; a native challenge does not finish there', async () => {
      const made = await invite('robin');
      const first = await request(app).post('/api/auth/invite').set(CSRF).send({ token: made.token, displayName: 'Robin', password: 'robin likes long passwords' });
      expect(first.status).toBe(200);
      const e = first.body as Enrolment & { address: string };
      expect(e.address).toBe('robin@d3cloud.io');
      const crossed = await native('invite').send({ challenge: e.challenge, enrolTotp: totpCode(e.enrolment.secret, clock.now()) });
      expect(crossed.status).toBe(401);
      const second = await request(app).post('/api/auth/invite').set(CSRF).send({ challenge: e.challenge, enrolTotp: totpCode(e.enrolment.secret, clock.now()) });
      expect(second.status).toBe(200);
      expect((second.body as { recoveryCodes: string[] }).recoveryCodes).toHaveLength(10);
      const robinJar = cookiesOf(second);
      const state = await request(app).get('/api/auth/state').set('cookie', cookieHeader(robinJar));
      expect(state.body).toMatchObject({ signedIn: true, account: { address: 'robin@d3cloud.io', isAdmin: false } });

      const bad = await request(app).post('/api/auth/invite').set(CSRF).send({ token: 'nope', displayName: 'X', password: 'a long enough password' });
      expect(bad.status).toBe(410);
      expect(bad.body).toMatchObject({ error: 'invite_invalid' });
      // Without the CSRF header the web route is refused before anything is read.
      expect((await request(app).post('/api/auth/invite').send({ token: 'nope', displayName: 'X', password: 'x' })).status).toBe(403);
    });
  });

  describe('deletion (PST-T-20.3)', () => {
    const del = (token: string | null, body: Record<string, unknown>) => {
      const req = native('delete-account');
      return (token === null ? req : req.set(bearer(token))).send(body);
    };

    it('needs a Bearer session: none, or a console cookie, is session_revoked', async () => {
      const none = await del(null, { confirmation: HOST, totp: '123456' });
      expect(none.status).toBe(401);
      expect(problemOf(none).name).toBe('session_revoked');
      const cookie = await native('delete-account').set('cookie', cookieHeader(jar)).send({ confirmation: HOST, totp: '123456' });
      expect(cookie.status).toBe(401);
      expect(problemOf(cookie).name).toBe('session_revoked');
    });

    it('a mismatched confirmation is 422 naming the host; a wrong code is invalid_code; the last owner is 409 last_owner', async () => {
      const tokens = await signInNatively(OPERATOR.login, OPERATOR.password, secret);
      const mismatch = await del(tokens.accessToken, { confirmation: 'example.org', totp: '123456' });
      expect(mismatch.status).toBe(422);
      expect(problemOf(mismatch)).toEqual({ name: 'about:blank', detail: `Type ${HOST} exactly to confirm.` });

      const wrong = await del(tokens.accessToken, { confirmation: HOST, totp: '000000' });
      expect(wrong.status).toBe(401);
      expect(problemOf(wrong).name).toBe('invalid_code');

      // The code is checked before the last-owner rule: the right one, as the only admin, is 409.
      const last = await del(tokens.accessToken, { confirmation: HOST.toUpperCase(), totp: nextCode(secret) });
      expect(last.status).toBe(409);
      expect(problemOf(last).name).toBe('last_owner');
      expect((await db.account.findUniqueOrThrow({ where: { id: operatorId } })).disabledAt).toBeNull();
      // A credential-less seeded admin is no owner; another enabled admin who can sign in is.
    });

    it('schedules a week out and ends every session, app password and push registration at once; an admin can restore it', async () => {
      const made = await invite('kim');
      const { tokens, secret: kimSecret } = await acceptNatively(made.token, 'kim has a long password');
      const kim = await db.account.findFirstOrThrow({ where: { addresses: { some: { localPart: 'kim' } } } });
      // A web session, an app password and a push registration, beside the native session.
      const pw = await request(app).post('/api/auth/signin').set(CSRF).send({ login: 'kim', password: 'kim has a long password' });
      const code = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge: (pw.body as { challenge: string }).challenge, code: nextCode(kimSecret) });
      expect(code.status).toBe(200);
      const kimJar = cookiesOf(code);
      await db.appPassword.create({ data: { accountId: kim.id, label: 'Mail', prefix: `pfx${String(Date.now())}`, hash: 'x', scopes: ['imap'] } });
      await db.relayRegistration.create({
        data: { accountId: kim.id, sessionId: tokens.session.id, devicePublicKey: Buffer.alloc(65, 4), relayUrl: 'https://relay.example', registration: 'reg-kim', sendKeySealed: Buffer.alloc(8), categories: ['postroom.priority'] },
      });

      const before = clock.now().getTime();
      const res = await del(tokens.accessToken, { confirmation: HOST, totp: nextCode(kimSecret) });
      expect(res.status).toBe(202);
      const graceUntil = Date.parse((res.body as { graceUntil: string }).graceUntil);
      expect(graceUntil).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 5_000);

      expect((await request(app).get('/api/auth/native/me').set(bearer(tokens.accessToken))).status).toBe(401);
      expect((await request(app).get('/api/auth/state').set('cookie', cookieHeader(kimJar))).body).toMatchObject({ signedIn: false });
      expect(await db.session.count({ where: { accountId: kim.id } })).toBe(0);
      expect(await db.appPassword.count({ where: { accountId: kim.id, revokedAt: null } })).toBe(0);
      expect(await db.relayRegistration.count({ where: { accountId: kim.id } })).toBe(0);
      const disabled = await db.account.findUniqueOrThrow({ where: { id: kim.id } });
      expect(disabled.disabledAt).not.toBeNull();
      expect(disabled.deleteAfter?.getTime()).toBe(graceUntil);
      expect(await db.auditEvent.count({ where: { action: 'account.delete.request', entityId: kim.id } })).toBe(1);
      // Signing in again is refused while it waits.
      expect((await native('signin').send({ email: 'kim', password: 'kim has a long password', device: DEVICE })).status).toBe(401);

      const people = await request(app).get('/api/admin/people').set(web());
      const listed = (people.body as { accounts: { id: string; deleteAfter: string | null }[] }).accounts.find((a) => a.id === kim.id);
      expect(listed?.deleteAfter).not.toBeNull();
      await stepUp();
      const restore = await request(app).post(`/api/admin/people/accounts/${kim.id}/restore`).set(web());
      expect(restore.status).toBe(200);
      expect(await db.account.findUniqueOrThrow({ where: { id: kim.id } })).toMatchObject({ disabledAt: null, deleteAfter: null, deletionRequestedAt: null });
      const twice = await request(app).post(`/api/admin/people/accounts/${kim.id}/restore`).set(web());
      expect(twice.status).toBe(409);
      // Restored, it signs in again.
      await signInNatively('kim', 'kim has a long password', kimSecret);
    });

    it('an admin who is not the last owner can delete themselves', async () => {
      const made = await invite('ops', { isAdmin: true });
      const { tokens, secret: opsSecret } = await acceptNatively(made.token, 'ops admin long password');
      const res = await del(tokens.accessToken, { confirmation: HOST, totp: nextCode(opsSecret) });
      expect(res.status).toBe(202);
    });
  });
});
