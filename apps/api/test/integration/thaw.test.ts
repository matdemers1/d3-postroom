// PST-T-1.10, HTTP half: POST /api/app-passwords/:id/thaw is admin-only, needs a fresh step-up (the
// same gate as other destructive admin mutations), and clears the freeze with an audited mutation.
import { createAppPassword } from '@postroom/credentials';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, PEPPER, randomLogin, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const OPERATOR = { kind: 'system', label: 'test' } as const;

describe.skipIf(!baseUrl)('POST /api/app-passwords/:id/thaw (PST-T-1.10)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();

  const signIn = async (login: string, secret: string): Promise<Record<string, string>> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookiesOf(second);
  };

  const person = async (isAdmin = false): Promise<{ id: string; cookie: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin });
    return { id, cookie: cookieHeader(await signIn(login, totpSecret)) };
  };

  const stepUp = async (cookie: string, secret: string): Promise<void> => {
    clock.advance(31_000);
    const res = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', cookie).send({ code: totpCode(secret, clock.now()) });
    expect(res.status).toBe(200);
  };

  const frozenAppPassword = async (): Promise<{ id: string; accountId: string }> => {
    const owner = randomLogin();
    const account = await db.account.create({ data: { displayName: owner, isAdmin: false } });
    const created = await createAppPassword(db, OPERATOR, { accountId: account.id, label: 'held', scopes: ['smtp'] }, { pepper: PEPPER });
    await db.appPassword.update({ where: { id: created.appPassword.id }, data: { frozenAt: clock.now() } });
    return { id: created.appPassword.id, accountId: account.id };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t110_thaw');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('401 without a session', async () => {
    const { id } = await frozenAppPassword();
    expect((await request(app).post(`/api/app-passwords/${id}/thaw`).set(CSRF)).status).toBe(401);
  });

  it('403 for a non-admin', async () => {
    const { id } = await frozenAppPassword();
    const nonAdmin = await person(false);
    const res = await request(app).post(`/api/app-passwords/${id}/thaw`).set(CSRF).set('cookie', nonAdmin.cookie);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('403 step_up_required for an admin with no fresh second factor', async () => {
    const { id } = await frozenAppPassword();
    const login = randomLogin();
    const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: true });
    const cookie = cookieHeader(await signIn(login, totpSecret));
    const res = await request(app).post(`/api/app-passwords/${id}/thaw`).set(CSRF).set('cookie', cookie);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'step_up_required' });
  });

  it('200 + audited mutation for an admin with a fresh step-up', async () => {
    const { id, accountId } = await frozenAppPassword();
    const login = randomLogin();
    const { id: adminId, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: true });
    const cookie = cookieHeader(await signIn(login, totpSecret));
    await stepUp(cookie, totpSecret);

    const before = await db.appPassword.findUniqueOrThrow({ where: { id } });
    expect(before.frozenAt).not.toBeNull();

    const res = await request(app).post(`/api/app-passwords/${id}/thaw`).set(CSRF).set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    const after = await db.appPassword.findUniqueOrThrow({ where: { id } });
    expect(after.frozenAt).toBeNull();

    const audit = await db.auditEvent.findFirst({ where: { action: 'app_password.thaw', entityId: id } });
    expect(audit).toMatchObject({ actorKind: 'account', actorAccountId: adminId });

    // A second thaw of an already-thawed credential is a no-op: not found, nothing re-audited.
    const again = await request(app).post(`/api/app-passwords/${id}/thaw`).set(CSRF).set('cookie', cookie);
    expect(again.status).toBe(404);
    expect(await db.auditEvent.count({ where: { action: 'app_password.thaw', entityId: id } })).toBe(1);

    // Untouched: the credential's own account, not the admin's.
    expect(accountId).not.toBe(adminId);
  });

  it('404 for an unknown id, even for an admin with step-up', async () => {
    const login = randomLogin();
    const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: true });
    const cookie = cookieHeader(await signIn(login, totpSecret));
    await stepUp(cookie, totpSecret);
    const res = await request(app).post('/api/app-passwords/00000000-0000-0000-0000-000000000000/thaw').set(CSRF).set('cookie', cookie);
    expect(res.status).toBe(404);
  });
});
