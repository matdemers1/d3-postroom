// PST-T-9.2 (PST-REQ-144): compose templates are CRUD over the API, audited, and strictly scoped to
// the caller's own account.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode, TestClock } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

interface TemplateJson {
  id: string;
  shortcut: string;
  name: string;
  subject: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

const templateOf = (res: { body: unknown }): TemplateJson => (res.body as { template: TemplateJson }).template;
const templatesOf = (res: { body: unknown }): TemplateJson[] => (res.body as { templates: TemplateJson[] }).templates;

describe.skipIf(!baseUrl)('compose templates over HTTP (PST-T-9.2, PST-REQ-144)', () => {
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
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t92_templates');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('needs a session', async () => {
    expect((await request(app).get('/api/templates')).status).toBe(401);
    expect((await request(app).post('/api/templates').set(CSRF).send({ shortcut: 'sig', name: 'Signature', body: 'x' })).status).toBe(401);
  });

  it('needs the CSRF header for a mutation', async () => {
    const me = await person();
    const res = await request(app).post('/api/templates').set('cookie', me.cookie).send({ shortcut: 'sig', name: 'Signature', body: 'x' });
    expect(res.status).toBe(403);
  });

  it('creates, lists, gets, updates and deletes a template — audited throughout', async () => {
    const me = await person();
    const created = await request(app)
      .post('/api/templates')
      .set(CSRF)
      .set('cookie', me.cookie)
      .send({ shortcut: 'sig', name: 'Signature', subject: 'Hello {{first_name}}', body: 'Best,\n{{name}}' });
    expect(created.status).toBe(201);
    const t = templateOf(created);
    expect(t.shortcut).toBe('sig');
    expect(t.body).toBe('Best,\n{{name}}');

    expect(await db.auditEvent.count({ where: { entityId: t.id, actorAccountId: me.id, action: 'template.create' } })).toBe(1);

    const list = await request(app).get('/api/templates').set('cookie', me.cookie);
    expect(list.status).toBe(200);
    expect(templatesOf(list)).toHaveLength(1);

    const got = await request(app).get(`/api/templates/${t.id}`).set('cookie', me.cookie);
    expect(got.status).toBe(200);
    expect(templateOf(got).id).toBe(t.id);

    const updated = await request(app)
      .put(`/api/templates/${t.id}`)
      .set(CSRF)
      .set('cookie', me.cookie)
      .send({ shortcut: 'sig2', name: 'Signature v2', body: 'New body {{date}}' });
    expect(updated.status).toBe(200);
    expect(templateOf(updated).shortcut).toBe('sig2');
    expect(await db.auditEvent.count({ where: { entityId: t.id, actorAccountId: me.id, action: 'template.update' } })).toBe(1);

    const deleted = await request(app).delete(`/api/templates/${t.id}`).set(CSRF).set('cookie', me.cookie);
    expect(deleted.status).toBe(204);
    expect(await db.auditEvent.count({ where: { entityId: t.id, actorAccountId: me.id, action: 'template.delete' } })).toBe(1);
    expect(templatesOf(await request(app).get('/api/templates').set('cookie', me.cookie))).toHaveLength(0);
  });

  it('rejects a duplicate shortcut for the same account', async () => {
    const me = await person();
    const first = await request(app).post('/api/templates').set(CSRF).set('cookie', me.cookie).send({ shortcut: 'dup', name: 'One', body: 'a' });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/templates').set(CSRF).set('cookie', me.cookie).send({ shortcut: 'dup', name: 'Two', body: 'b' });
    expect(second.status).toBe(409);
  });

  it('the same shortcut is fine for two different accounts', async () => {
    const alice = await person();
    const bob = await person();
    const a = await request(app).post('/api/templates').set(CSRF).set('cookie', alice.cookie).send({ shortcut: 'shared', name: 'Alice', body: 'a' });
    const b = await request(app).post('/api/templates').set(CSRF).set('cookie', bob.cookie).send({ shortcut: 'shared', name: 'Bob', body: 'b' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it('one account never sees, updates or deletes another\'s template', async () => {
    const alice = await person();
    const bob = await person();
    const created = await request(app).post('/api/templates').set(CSRF).set('cookie', alice.cookie).send({ shortcut: 'mine', name: 'Mine', body: 'x' });
    const id = templateOf(created).id;

    expect(templatesOf(await request(app).get('/api/templates').set('cookie', bob.cookie))).toEqual([]);
    expect((await request(app).get(`/api/templates/${id}`).set('cookie', bob.cookie)).status).toBe(404);
    expect((await request(app).put(`/api/templates/${id}`).set(CSRF).set('cookie', bob.cookie).send({ shortcut: 'x', name: 'x', body: 'x' })).status).toBe(404);
    expect((await request(app).delete(`/api/templates/${id}`).set(CSRF).set('cookie', bob.cookie)).status).toBe(404);
    expect((await db.composeTemplate.findUniqueOrThrow({ where: { id } })).name).toBe('Mine');
  });

  it('left no mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
