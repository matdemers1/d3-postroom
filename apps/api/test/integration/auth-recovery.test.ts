// PST-T-16.7 doneWhen, API half (PST-REQ-197, PST-REQ-005, PST-REQ-075, PST-REQ-009): completing
// TOTP enrolment issues ten recovery codes, stored as peppered Argon2id hashes; at sign-in a code is
// accepted once in place of the TOTP code and refused the second time — even when two requests race
// for it — each use audited; regenerating needs a step-up and invalidates the old set; and the
// sign-in throttle counts recovery-code guesses exactly as it counts TOTP guesses.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { request } from '../loopback.js';
import { baseConfig, cookieHeader, cookiesOf, PEPPER, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const OPERATOR = { displayName: 'Matt', login: 'matt', password: 'correct horse battery staple' };
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

describe.skipIf(!baseUrl)('TOTP recovery codes (PST-T-16.7)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let operatorId = '';
  let secret = '';
  let issued: string[] = [];
  let guardMissesBefore = 0;

  /** The password step: a fresh challenge for the operator. */
  const challenge = async (): Promise<string> => {
    const res = await request(app).post('/api/auth/signin').set(CSRF).send({ login: OPERATOR.login, password: OPERATOR.password });
    expect(res.status).toBe(200);
    return (res.body as { challenge: string }).challenge;
  };

  const second = (ch: string, code: string) => request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge: ch, code });

  /** Password then TOTP, a step later so the code is never a replay. */
  const signInTotp = async (): Promise<Record<string, string>> => {
    clock.advance(31_000);
    const res = await second(await challenge(), totpCode(secret, clock.now()));
    expect(res.status).toBe(200);
    return cookiesOf(res);
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t167');
    db = testDb.db;
    operatorId = (await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' })).operatorId;
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('completing enrolment returns ten distinct codes, once, and stores only peppered Argon2id hashes', async () => {
    const begin = await request(app).post('/api/auth/setup/begin').set(CSRF).send(OPERATOR);
    expect(begin.status).toBe(200);
    const body = begin.body as { enrolToken: string; secret: string };
    secret = body.secret;
    // No code exists before the authenticator is proven.
    expect(await db.recoveryCode.count()).toBe(0);

    const done = await request(app)
      .post('/api/auth/setup/complete')
      .set(CSRF)
      .send({ enrolToken: body.enrolToken, code: totpCode(secret, clock.now()) });
    expect(done.status).toBe(200);
    expect(done.headers['cache-control']).toBe('no-store');
    issued = (done.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(issued).toHaveLength(10);
    expect(new Set(issued).size).toBe(10);
    for (const code of issued) expect(code).toMatch(CODE_SHAPE);

    const rows = await db.recoveryCode.findMany({ where: { accountId: operatorId } });
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.codeHash).toMatch(/^\$argon2id\$v=19\$m=65536,(?:t=3,p=1|p=1,t=3)\$/);
      expect(row.usedAt).toBeNull();
      for (const code of issued) {
        expect(row.codeHash).not.toContain(code);
        expect(row.codeHash).not.toContain(code.replace('-', ''));
      }
    }
    // The pepper is argon2's secret: a hash does not verify without it.
    const argon2 = (await import('argon2')).default;
    const plain = (issued[0] ?? '').replace('-', '');
    const match = await Promise.all(rows.map((r) => argon2.verify(r.codeHash, plain, { secret: Buffer.from(PEPPER) })));
    expect(match.filter(Boolean)).toHaveLength(1);
    const withoutPepper = await Promise.all(rows.map((r) => argon2.verify(r.codeHash, plain).catch(() => false)));
    expect(withoutPepper.filter(Boolean)).toHaveLength(0);

    expect(await db.auditEvent.count({ where: { action: 'auth.recovery-codes.issue', entityId: operatorId } })).toBe(1);
    const status = await request(app).get('/api/auth/recovery-codes').set('cookie', cookieHeader(cookiesOf(done)));
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ total: 10, remaining: 10 });
    // Nothing that reads the set back ever carries a code.
    expect(JSON.stringify(status.body)).not.toMatch(/[0-9A-Z]{5}-[0-9A-Z]{5}/);
  });

  it('a six-digit TOTP code still signs in: it is never taken for a recovery code', async () => {
    const jar = await signInTotp();
    expect(jar['postroom_session']).toBeDefined();
    expect(await db.recoveryCode.count({ where: { usedAt: { not: null } } })).toBe(0);
  });

  it('accepts a recovery code once in place of the TOTP code — forgiving case, spaces and dashes — and audits the use', async () => {
    const code = issued[0] ?? '';
    const typed = ` ${code.toLowerCase().replace('-', ' - ')} `;
    const res = await second(await challenge(), typed);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ next: 'done', account: { id: operatorId } });
    const jar = cookiesOf(res);
    expect(jar['postroom_session']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = await request(app).get('/api/auth/state').set('cookie', cookieHeader(jar));
    expect(state.body).toMatchObject({ signedIn: true, account: { id: operatorId } });

    const used = await db.recoveryCode.findMany({ where: { accountId: operatorId, usedAt: { not: null } } });
    expect(used).toHaveLength(1);
    const uses = await db.auditEvent.findMany({ where: { action: 'auth.recovery-code.use' } });
    expect(uses).toHaveLength(1);
    expect(uses[0]?.entityId).toBe(used[0]?.id);
    expect(uses[0]?.after).toMatchObject({ remaining: 9 });
    const signins = await db.auditEvent.findMany({ where: { action: 'auth.signin', actorAccountId: operatorId }, orderBy: { at: 'desc' } });
    expect(signins[0]?.after).toMatchObject({ method: 'password', factor: 'recovery_code' });

    const status = await request(app).get('/api/auth/recovery-codes').set('cookie', cookieHeader(jar));
    expect(status.body).toMatchObject({ total: 10, remaining: 9 });
  });

  it('refuses the same code the second time, and audits the refusal', async () => {
    const res = await second(await challenge(), issued[0] ?? '');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_code' });
    expect(res.headers['set-cookie']).toBeUndefined();
    const rejected = await db.auditEvent.findMany({ where: { action: 'auth.signin.rejected', entityId: operatorId }, orderBy: { at: 'desc' } });
    expect(rejected[0]?.after).toMatchObject({ factor: 'recovery_code', attempts: 1 });
    expect(await db.auditEvent.count({ where: { action: 'auth.recovery-code.use' } })).toBe(1);
  });

  it('two sign-ins racing with one code: exactly one wins', async () => {
    const code = issued[1] ?? '';
    const [a, b] = await Promise.all([challenge(), challenge()]);
    const results = await Promise.all([second(a, code), second(b, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await db.recoveryCode.count({ where: { accountId: operatorId, usedAt: { not: null } } })).toBe(2);
    expect(await db.auditEvent.count({ where: { action: 'auth.recovery-code.use' } })).toBe(2);
  });

  it('a code that is not one of the set is refused', async () => {
    const res = await second(await challenge(), 'ZZZZZ-ZZZZZ');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_code' });
  });

  it('regenerating needs a step-up, replaces the whole set, and the old codes stop working', async () => {
    const jar = await signInTotp();
    const cookie = cookieHeader(jar);

    const refused = await request(app).post('/api/auth/recovery-codes').set(CSRF).set('cookie', cookie);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'step_up_required' });
    expect(await db.recoveryCode.count({ where: { accountId: operatorId } })).toBe(10);

    clock.advance(31_000);
    const stepUp = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(secret, clock.now()) });
    expect(stepUp.status).toBe(200);

    const regen = await request(app).post('/api/auth/recovery-codes').set(CSRF).set('cookie', cookie);
    expect(regen.status).toBe(200);
    expect(regen.headers['cache-control']).toBe('no-store');
    const fresh = (regen.body as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    for (const code of fresh) {
      expect(code).toMatch(CODE_SHAPE);
      expect(issued).not.toContain(code);
    }
    const rows = await db.recoveryCode.findMany({ where: { accountId: operatorId } });
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.usedAt === null)).toBe(true);
    const regenerated = await db.auditEvent.findMany({ where: { action: 'auth.recovery-codes.regenerate', entityId: operatorId } });
    expect(regenerated).toHaveLength(1);
    expect(regenerated[0]?.before).toMatchObject({ count: 10 });

    // An old code that was never used is dead now.
    const old = await second(await challenge(), issued[2] ?? '');
    expect(old.status).toBe(401);
    // A new one works, once.
    const ok = await second(await challenge(), fresh[0] ?? '');
    expect(ok.status).toBe(200);
    const status = await request(app).get('/api/auth/recovery-codes').set('cookie', cookieHeader(cookiesOf(ok)));
    expect(status.body).toMatchObject({ total: 10, remaining: 9 });
    issued = fresh;
  });

  it('never writes a code into the audit trail', async () => {
    const events = await db.auditEvent.findMany();
    const text = JSON.stringify(events.map((e) => [e.before, e.after]));
    for (const code of issued) {
      expect(text).not.toContain(code);
      expect(text).not.toContain(code.replace('-', ''));
    }
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });

  // Last: it leaves the operator's (login, IP) throttled.
  it('recovery-code guesses count toward the same throttle and attempt cap as TOTP guesses (PST-REQ-075)', async () => {
    const ch = await challenge();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await second(ch, `WRONG-${String(i).padStart(5, '0')}`)).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    // The fifth miss burnt the challenge…
    expect((await second(ch, issued[1] ?? '')).status).toBe(401);
    expect(await db.recoveryCode.count({ where: { accountId: operatorId, usedAt: { not: null } } })).toBe(1);
    // …and the (login, IP) pair is now delayed, before any hashing.
    const next = await request(app).post('/api/auth/signin').set(CSRF).send({ login: OPERATOR.login, password: OPERATOR.password });
    expect(next.status).toBe(429);
    expect(next.body).toMatchObject({ error: 'too_many_attempts' });
  }, 60_000);
});
