// PST-T-5.7, HTTP half: masked alias CRUD (PST-REQ-112) — generation, listing, kill and revive, every
// mutation audited, scoped strictly to the caller's own account, and 401 without a session. The
// killed-alias-returns-550 half of this task is proven at the SMTP layer (recipients.ts, already
// covered by apps/smtp-in/test); this file proves the alias's killedAt is what that check reads.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { AddressKind, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode, TestClock } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

interface AliasJson {
  id: string;
  address: string;
  site: string;
  createdAt: string;
  killedAt: string | null;
  lastUsedAt: string | null;
  receivedCount: number;
}

const aliasOf = (res: { body: unknown }): AliasJson => (res.body as { alias: AliasJson }).alias;
const aliasesOf = (res: { body: unknown }): AliasJson[] => (res.body as { aliases: AliasJson[] }).aliases;

describe.skipIf(!baseUrl)('masked aliases over HTTP (PST-T-5.7, PST-REQ-112)', () => {
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

  const person = async (): Promise<{ id: string; login: string; cookie: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    return { id, login, cookie: await signIn(login, totpSecret) };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t57api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('needs a session', async () => {
    expect((await request(app).get('/api/aliases')).status).toBe(401);
    expect((await request(app).post('/api/aliases').set(CSRF).send({ site: 'shop.example' })).status).toBe(401);
  });

  it('needs the CSRF header for a mutation', async () => {
    const me = await person();
    const res = await request(app).post('/api/aliases').set('cookie', me.cookie).send({ site: 'shop.example' });
    expect(res.status).toBe(403);
  });

  it('rejects an empty site', async () => {
    const me = await person();
    const res = await request(app).post('/api/aliases').set(CSRF).set('cookie', me.cookie).send({ site: '' });
    expect(res.status).toBe(400);
  });

  it('generates a random masked alias, lists it, kills and revives it — audited throughout', async () => {
    const me = await person();
    const created = await request(app).post('/api/aliases').set(CSRF).set('cookie', me.cookie).send({ site: 'shop.example' });
    expect(created.status).toBe(201);
    const alias = aliasOf(created);
    expect(alias.site).toBe('shop.example');
    expect(alias.address).toMatch(/^[a-z0-9.]+@d3cloud\.io$/);
    expect(alias.killedAt).toBeNull();
    expect(alias.receivedCount).toBe(0);

    const row = await db.address.findUniqueOrThrow({ where: { id: alias.id } });
    expect(row).toMatchObject({ kind: AddressKind.masked, accountId: me.id, siteTag: 'shop.example' });

    const list = await request(app).get('/api/aliases').set('cookie', me.cookie);
    expect(list.status).toBe(200);
    expect(aliasesOf(list)).toHaveLength(1);
    expect(aliasesOf(list)[0]).toMatchObject({ id: alias.id, address: alias.address });

    const killed = await request(app).post(`/api/aliases/${alias.id}/kill`).set(CSRF).set('cookie', me.cookie);
    expect(killed.status).toBe(200);
    expect(aliasOf(killed).killedAt).not.toBeNull();
    expect((await db.address.findUniqueOrThrow({ where: { id: alias.id } })).killedAt).not.toBeNull();
    expect(await db.auditEvent.count({ where: { entityId: alias.id, actorAccountId: me.id, action: 'alias.kill' } })).toBe(1);

    const revived = await request(app).post(`/api/aliases/${alias.id}/revive`).set(CSRF).set('cookie', me.cookie);
    expect(revived.status).toBe(200);
    expect(aliasOf(revived).killedAt).toBeNull();
    expect(await db.auditEvent.count({ where: { entityId: alias.id, actorAccountId: me.id, action: 'alias.revive' } })).toBe(1);
    expect(await db.auditEvent.count({ where: { entityId: alias.id, actorAccountId: me.id, action: 'alias.create' } })).toBe(1);
  });

  it('two aliases for the same account never collide in address', async () => {
    const me = await person();
    const a = await request(app).post('/api/aliases').set(CSRF).set('cookie', me.cookie).send({ site: 'news.example' });
    const b = await request(app).post('/api/aliases').set(CSRF).set('cookie', me.cookie).send({ site: 'news.example' });
    expect(aliasOf(a).address).not.toBe(aliasOf(b).address);
  });

  it('one account never sees, kills, or revives another\'s alias', async () => {
    const alice = await person();
    const bob = await person();
    const created = await request(app).post('/api/aliases').set(CSRF).set('cookie', alice.cookie).send({ site: 'shop.example' });
    const aliasId = aliasOf(created).id;

    expect(aliasesOf(await request(app).get('/api/aliases').set('cookie', bob.cookie))).toEqual([]);
    expect((await request(app).post(`/api/aliases/${aliasId}/kill`).set(CSRF).set('cookie', bob.cookie)).status).toBe(404);
    expect((await db.address.findUniqueOrThrow({ where: { id: aliasId } })).killedAt).toBeNull();
  });

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
