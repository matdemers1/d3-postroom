// PST-T-1.3, HTTP half: create / list / revoke with a signed-in session; the plaintext appears in
// the create response and nowhere else; every mutation audited; an admin reaches a service
// account's passwords and nobody reaches another person's.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { verifyProtocolLogin } from '@postroom/credentials';
import { AccountKind, AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { PEPPER, TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

interface Listed {
  id: string;
  label: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  password?: string;
}

describe.skipIf(!baseUrl)('app passwords over HTTP (PST-T-1.3)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let guardMissesBefore = 0;

  const signIn = async (login: string, secret: string): Promise<string> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    expect(first.status).toBe(200);
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  const person = async (isAdmin = false): Promise<{ id: string; login: string; address: string; cookie: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin });
    return { id, login, address: `${login}@d3cloud.io`, cookie: await signIn(login, totpSecret) };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t13');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('needs a session and the CSRF header', async () => {
    expect((await request(app).get('/api/app-passwords')).status).toBe(401);
    const me = await person();
    const noCsrf = await request(app).post('/api/app-passwords').set('cookie', me.cookie).send({ label: 'x', scopes: ['smtp'] });
    expect(noCsrf.status).toBe(403);
  });

  it('creates, shows the password once, lists without it, and revokes immediately', async () => {
    const me = await person();
    const created = await request(app)
      .post('/api/app-passwords')
      .set(CSRF)
      .set('cookie', me.cookie)
      .send({ label: 'iPhone Mail', scopes: ['imap', 'smtp'] });
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const body = created.body as Listed & { password: string };
    expect(body.password).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){6}$/);
    expect(body).toMatchObject({ label: 'iPhone Mail', scopes: ['imap', 'smtp'], lastUsedAt: null });
    expect(body).not.toHaveProperty('hash');

    const secretPart = body.password.replaceAll('-', '').slice(8);
    const auditRows = await db.auditEvent.findMany({ where: { entityId: body.id } });
    expect(auditRows.map((r) => r.action)).toEqual(['app_password.create']);
    expect(auditRows[0]?.actorAccountId).toBe(me.id);
    expect(JSON.stringify(auditRows)).not.toContain(secretPart);

    // It works over the protocol path the submission daemon will use.
    const verify = () => verifyProtocolLogin(db, { username: me.address, password: body.password, scope: 'smtp', ip: '127.0.0.1' }, { pepper: PEPPER });
    expect((await verify()).ok).toBe(true);

    const listed = await request(app).get('/api/app-passwords').set('cookie', me.cookie);
    expect(listed.status).toBe(200);
    const list = (listed.body as { appPasswords: Listed[] }).appPasswords;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: body.id, prefix: body.prefix });
    expect(list[0]?.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(listed.body)).not.toContain(secretPart);
    expect(JSON.stringify(listed.body)).not.toContain('argon2');

    const revoked = await request(app).delete(`/api/app-passwords/${body.id}`).set(CSRF).set('cookie', me.cookie);
    expect(revoked.status).toBe(200);
    expect(await verify()).toEqual({ ok: false, reason: 'revoked' });
    expect(await db.auditEvent.count({ where: { entityId: body.id, action: 'app_password.revoke', actorAccountId: me.id } })).toBe(1);
    expect(((await request(app).get('/api/app-passwords').set('cookie', me.cookie)).body as { appPasswords: Listed[] }).appPasswords).toEqual([]);

    // A second revoke is a 404, not a second audit row.
    expect((await request(app).delete(`/api/app-passwords/${body.id}`).set(CSRF).set('cookie', me.cookie)).status).toBe(404);
  });

  it('refuses bad input, and a self-serve recipient cap', async () => {
    const me = await person();
    const post = (payload: unknown) => request(app).post('/api/app-passwords').set(CSRF).set('cookie', me.cookie).send(payload as object);
    expect((await post({ label: '', scopes: ['smtp'] })).status).toBe(400);
    expect((await post({ label: 'x', scopes: [] })).status).toBe(400);
    expect((await post({ label: 'x', scopes: ['pop3'] })).status).toBe(400);
    expect((await post({ label: 'x', scopes: ['smtp'], dailyRecipientCap: 10 })).status).toBe(400);
    expect(await db.appPassword.count({ where: { accountId: me.id } })).toBe(0);
  });

  it('never reaches another person’s passwords', async () => {
    const alice = await person();
    const bob = await person();
    const created = await request(app).post('/api/app-passwords').set(CSRF).set('cookie', alice.cookie).send({ label: 'a', scopes: ['imap'] });
    const id = (created.body as Listed).id;
    expect((await request(app).delete(`/api/app-passwords/${id}`).set(CSRF).set('cookie', bob.cookie)).status).toBe(404);
    expect((await request(app).get(`/api/app-passwords?accountId=${alice.id}`).set('cookie', bob.cookie)).status).toBe(403);
    // Not even an admin: only service accounts are managed on someone's behalf.
    const admin = await person(true);
    expect((await request(app).get(`/api/app-passwords?accountId=${alice.id}`).set('cookie', admin.cookie)).status).toBe(404);
    expect((await db.appPassword.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull();
  });

  it('lets an admin manage a service account’s passwords, with a recipient cap (PST-REQ-046)', async () => {
    const admin = await person(true);
    const domain = await db.domain.findFirstOrThrow({ where: { isPrimary: true } });
    const svc = await db.account.create({ data: { displayName: 'Foreman', kind: AccountKind.service } });
    const local = `svc-${randomLogin()}`;
    await db.address.create({ data: { localPart: local, domainId: domain.id, kind: AddressKind.service, accountId: svc.id } });

    const created = await request(app)
      .post(`/api/app-passwords?accountId=${svc.id}`)
      .set(CSRF)
      .set('cookie', admin.cookie)
      .send({ label: 'foreman alerts', scopes: ['smtp'], dailyRecipientCap: 200 });
    expect(created.status).toBe(201);
    const body = created.body as Listed & { password: string; accountId: string; dailyRecipientCap: number };
    expect(body).toMatchObject({ accountId: svc.id, dailyRecipientCap: 200 });
    expect(await verifyProtocolLogin(db, { username: `${local}@d3cloud.io`, password: body.password, scope: 'smtp', ip: null }, { pepper: PEPPER })).toMatchObject({
      ok: true,
      accountId: svc.id,
    });

    const listed = await request(app).get(`/api/app-passwords?accountId=${svc.id}`).set('cookie', admin.cookie);
    expect((listed.body as { appPasswords: Listed[] }).appPasswords.map((p) => p.id)).toEqual([body.id]);
    // The admin's own list is separate.
    expect(((await request(app).get('/api/app-passwords').set('cookie', admin.cookie)).body as { appPasswords: Listed[] }).appPasswords).toEqual([]);

    const nonAdmin = await person();
    expect((await request(app).post(`/api/app-passwords?accountId=${svc.id}`).set(CSRF).set('cookie', nonAdmin.cookie).send({ label: 'x', scopes: ['smtp'] })).status).toBe(403);
    expect((await request(app).delete(`/api/app-passwords/${body.id}`).set(CSRF).set('cookie', nonAdmin.cookie)).status).toBe(404);

    expect((await request(app).delete(`/api/app-passwords/${body.id}?accountId=${svc.id}`).set(CSRF).set('cookie', admin.cookie)).status).toBe(200);
    expect(await db.auditEvent.count({ where: { entityId: body.id, actorAccountId: admin.id } })).toBe(2);
  });

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
