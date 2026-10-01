// PST-T-16.26 doneWhen, API half (PST-REQ-200, PST-REQ-197, PST-REQ-009):
// - five recovery-shaped guesses fired at once at one sign-in challenge: at most one is checked
//   against the Argon2id hashes, and the rest are answered 429/401 without hashing;
// - a session that signed in with a recovery code is marked so, and every step-up-gated action
//   (step-up itself included) answers 403 totp_reenrol_required until it re-enrols;
// - re-enrolment enrols a new TOTP secret, invalidates the old one, issues a fresh set of recovery
//   codes and audits all three — after which step-up works with the new authenticator.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { kekFromBase64 } from '@postroom/crypto';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { recoveryCheckStats } from '../../src/auth/recovery.js';
import { openTotpSecret } from '../../src/auth/totp.js';
import { request } from '../loopback.js';
import { baseConfig, cookieHeader, cookiesOf, KEK_BASE64, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const OPERATOR = { displayName: 'Matt', login: 'matt', password: 'correct horse battery staple' };
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

describe.skipIf(!baseUrl)('TOTP re-enrolment after a recovery-code sign-in (PST-T-16.26)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let operatorId = '';
  let oldSecret = '';
  let newSecret = '';
  let issued: string[] = [];
  let fresh: string[] = [];
  let recoveryJar: Record<string, string> = {};
  let recoverySessionId = '';
  let guardMissesBefore = 0;

  const challenge = async (): Promise<string> => {
    const res = await request(app).post('/api/auth/signin').set(CSRF).send({ login: OPERATOR.login, password: OPERATOR.password });
    expect(res.status).toBe(200);
    return (res.body as { challenge: string }).challenge;
  };
  const second = (ch: string, code: string) => request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge: ch, code });

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t1626');
    db = testDb.db;
    operatorId = (await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' })).operatorId;
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;

    const begin = await request(app).post('/api/auth/setup/begin').set(CSRF).send(OPERATOR);
    expect(begin.status).toBe(200);
    const body = begin.body as { enrolToken: string; secret: string };
    oldSecret = body.secret;
    const done = await request(app)
      .post('/api/auth/setup/complete')
      .set(CSRF)
      .send({ enrolToken: body.enrolToken, code: totpCode(oldSecret, clock.now()) });
    expect(done.status).toBe(200);
    issued = (done.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(issued).toHaveLength(10);
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('five concurrent recovery-shaped guesses at one challenge: at most one hashes, the rest get 429/401 without hashing', async () => {
    const ch = await challenge();
    const checksBefore = recoveryCheckStats.checks;
    const guesses = ['AAAAA-AAAAA', 'BBBBB-BBBBB', 'CCCCC-CCCCC', 'DDDDD-DDDDD', 'EEEEE-EEEEE'];
    const results = await Promise.all(guesses.map((code) => second(ch, code)));
    const checks = recoveryCheckStats.checks - checksBefore;

    expect(checks).toBeLessThanOrEqual(1);
    for (const r of results) expect([401, 429]).toContain(r.status);
    // Only a guess that was checked is answered invalid_code; every other one was refused first.
    expect(results.filter((r) => r.status === 401 && (r.body as { error: string }).error === 'invalid_code')).toHaveLength(checks);
    for (const r of results.filter((x) => x.status === 429)) expect(r.body).toMatchObject({ error: 'too_many_attempts' });
    // One audited refusal per check, and no code was spent.
    expect(await db.auditEvent.count({ where: { action: 'auth.signin.rejected', entityId: operatorId } })).toBe(checks);
    expect(await db.recoveryCode.count({ where: { accountId: operatorId, usedAt: { not: null } } })).toBe(0);
  }, 60_000);

  it('a recovery-code sign-in is marked, and every step-up-gated action answers 403 totp_reenrol_required', async () => {
    const res = await second(await challenge(), issued[0] ?? '');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ next: 'done', reenrolRequired: true, account: { id: operatorId } });
    recoveryJar = cookiesOf(res);
    const cookie = cookieHeader(recoveryJar);

    const row = await db.session.findFirstOrThrow({ where: { accountId: operatorId }, orderBy: { createdAt: 'desc' } });
    expect(row.secondFactor).toBe('recovery_code');
    recoverySessionId = row.id;
    const state = await request(app).get('/api/auth/state').set('cookie', cookie);
    expect(state.body).toMatchObject({ signedIn: true, reenrolRequired: true });

    const regen = await request(app).post('/api/auth/recovery-codes').set(CSRF).set('cookie', cookie);
    expect(regen.status).toBe(403);
    expect(regen.body).toEqual({ error: 'totp_reenrol_required' });
    // Even a code from the old authenticator does not step this session up.
    clock.advance(31_000);
    const stepUp = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(oldSecret, clock.now()) });
    expect(stepUp.status).toBe(403);
    expect(stepUp.body).toEqual({ error: 'totp_reenrol_required' });
    const endOthers = await request(app).delete('/api/auth/sessions').set(CSRF).set('cookie', cookie);
    expect(endOthers.status).toBe(403);
    expect(endOthers.body).toEqual({ error: 'totp_reenrol_required' });
    expect(await db.recoveryCode.count({ where: { accountId: operatorId } })).toBe(10);

    const denied = await db.auditEvent.findMany({ where: { action: 'authz.denied', actorAccountId: operatorId } });
    expect(denied.filter((d) => (d.after as { reason?: string } | null)?.reason === 'totp_reenrol_required')).toHaveLength(3);

    // A TOTP sign-in is not marked.
    clock.advance(31_000);
    const totp = await second(await challenge(), totpCode(oldSecret, clock.now()));
    expect(totp.status).toBe(200);
    expect(totp.body).toMatchObject({ reenrolRequired: false });
    const totpState = await request(app).get('/api/auth/state').set('cookie', cookieHeader(cookiesOf(totp)));
    expect(totpState.body).toMatchObject({ reenrolRequired: false });
  });

  it('re-enrols: a new secret, the old one invalidated, a fresh set of recovery codes — all three audited', async () => {
    const cookie = cookieHeader(recoveryJar);
    const begin = await request(app).post('/api/auth/totp/reenrol/begin').set(CSRF).set('cookie', cookie);
    expect(begin.status).toBe(200);
    expect(begin.headers['cache-control']).toBe('no-store');
    newSecret = (begin.body as { secret: string }).secret;
    expect(newSecret).toMatch(/^[A-Z2-7]{32}$/);
    expect(newSecret).not.toBe(oldSecret);
    expect((begin.body as { otpauthUri: string }).otpauthUri).toMatch(/^otpauth:\/\/totp\/Postroom:/);

    // A wrong code changes nothing.
    const wrong = await request(app)
      .post('/api/auth/totp/reenrol/complete')
      .set(CSRF)
      .set('cookie', cookie)
      .send({ code: totpCode(newSecret, new Date(clock.now().getTime() + 10 * 60_000)) });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'invalid_code' });

    clock.advance(31_000);
    const done = await request(app).post('/api/auth/totp/reenrol/complete').set(CSRF).set('cookie', cookie).send({ code: totpCode(newSecret, clock.now()) });
    expect(done.status).toBe(200);
    expect(done.headers['cache-control']).toBe('no-store');
    fresh = (done.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    for (const code of fresh) {
      expect(code).toMatch(CODE_SHAPE);
      expect(issued).not.toContain(code);
    }

    const account = await db.account.findUniqueOrThrow({ where: { id: operatorId } });
    expect(account.totpSecret).not.toBeNull();
    expect(openTotpSecret(kekFromBase64(KEK_BASE64), account.totpSecret ?? new Uint8Array(), operatorId)).toBe(newSecret);
    const rows = await db.recoveryCode.findMany({ where: { accountId: operatorId } });
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.usedAt === null)).toBe(true);
    const session = await db.session.findUniqueOrThrow({ where: { id: recoverySessionId } });
    expect(session.secondFactor).toBe('totp');

    for (const action of ['auth.totp.invalidate', 'auth.totp.enrol', 'auth.recovery-codes.regenerate']) {
      expect(await db.auditEvent.count({ where: { action, entityId: operatorId } })).toBe(1);
    }
    const regen = await db.auditEvent.findFirstOrThrow({ where: { action: 'auth.recovery-codes.regenerate', entityId: operatorId } });
    expect(regen.before).toMatchObject({ count: 10 });
    expect(regen.after).toMatchObject({ count: 10, reason: 'reenrol' });

    const state = await request(app).get('/api/auth/state').set('cookie', cookie);
    expect(state.body).toMatchObject({ reenrolRequired: false });
    const again = await request(app).post('/api/auth/totp/reenrol/complete').set(CSRF).set('cookie', cookie).send({ code: '123456' });
    expect(again.status).toBe(409);
  }, 60_000);

  it('after re-enrolment the old authenticator and the old codes are dead, and the new authenticator steps up', async () => {
    const cookie = cookieHeader(recoveryJar);
    // Step-up with the new authenticator, then a new set behind it.
    clock.advance(31_000);
    const refusedOld = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(oldSecret, clock.now()) });
    expect(refusedOld.status).toBe(401);
    clock.advance(31_000);
    const stepUp = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(newSecret, clock.now()) });
    expect(stepUp.status).toBe(200);
    const regen = await request(app).post('/api/auth/recovery-codes').set(CSRF).set('cookie', cookie);
    expect(regen.status).toBe(200);
    fresh = (regen.body as { recoveryCodes: string[] }).recoveryCodes;

    // The old secret no longer signs in; an old recovery code no longer does either.
    clock.advance(31_000);
    expect((await second(await challenge(), totpCode(oldSecret, clock.now()))).status).toBe(401);
    expect((await second(await challenge(), issued[1] ?? '')).status).toBe(401);
    clock.advance(31_000);
    expect((await second(await challenge(), totpCode(newSecret, clock.now()))).status).toBe(200);
  }, 60_000);

  it('never writes a secret or a code into the audit trail', async () => {
    const text = JSON.stringify((await db.auditEvent.findMany()).map((e) => [e.before, e.after]));
    expect(text).not.toContain(oldSecret);
    expect(text).not.toContain(newSecret);
    for (const code of [...issued, ...fresh]) {
      expect(text).not.toContain(code);
      expect(text).not.toContain(code.replace('-', ''));
    }
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
