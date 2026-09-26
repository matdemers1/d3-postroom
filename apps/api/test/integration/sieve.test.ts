// PST-T-9.5, HTTP half: the rules builder's Sieve routes (PST-REQ-150) — list/get/put/activate/
// deactivate/delete/check, a compile error answered with its line and column, the active script not
// deletable, every mutation audited, strictly per account, and 401 without a session.
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { request } from '../loopback.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode, TestClock } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

const RULES = ['require ["fileinto", "imap4flags"];', '# rule: Invoices', 'if header :contains "subject" "invoice" {', '  fileinto "Receipts";', '  addflag "$Paid";', '}', ''].join('\n');
const BROKEN = ['require "fileinto";', '', 'fileinto "Receipts"', 'keep;', ''].join('\n');

describe.skipIf(!baseUrl)('Sieve scripts over HTTP (PST-T-9.5, PST-REQ-150)', () => {
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

  const person = async (): Promise<{ id: string; cookie: string }> => {
    const login = randomLogin();
    const { id, totpSecret } = await createAccount(db, { login, password: PASSWORD });
    return { id, cookie: await signIn(login, totpSecret) };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t95api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: {}, config: baseConfig(clock) });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('needs a session, and the CSRF header for a change', async () => {
    expect((await request(app).get('/api/sieve/scripts')).status).toBe(401);
    expect((await request(app).put('/api/sieve/scripts/rules').set(CSRF).send({ content: 'keep;' })).status).toBe(401);
    expect((await request(app).post('/api/sieve/check').set(CSRF).send({ content: 'keep;' })).status).toBe(401);
    const me = await person();
    expect((await request(app).put('/api/sieve/scripts/rules').set('cookie', me.cookie).send({ content: 'keep;' })).status).toBe(403);
  });

  it('checks a script: a compile error comes back with its line and column', async () => {
    const me = await person();
    const ok = await request(app).post('/api/sieve/check').set(CSRF).set('cookie', me.cookie).send({ content: RULES });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ valid: true, error: null });
    const bad = await request(app).post('/api/sieve/check').set(CSRF).set('cookie', me.cookie).send({ content: BROKEN });
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ valid: false, error: { line: 4, column: 1 } });
    expect((bad.body as { error: { message: string } }).error.message).toMatch(/^line 4, column 1: /);
  });

  it('stores, lists, reads back, activates, refuses to delete the active one, deactivates, deletes — all audited', async () => {
    const me = await person();
    const empty = await request(app).get('/api/sieve/scripts').set('cookie', me.cookie);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ scripts: [], maxScripts: 32, maxScriptBytes: 262144 });
    expect((empty.body as { extensions: string[] }).extensions).toEqual(expect.arrayContaining(['fileinto', 'imap4flags', 'vacation', 'vnd.postroom.bucket']));

    const refused = await request(app).put('/api/sieve/scripts/Postroom%20rules').set(CSRF).set('cookie', me.cookie).send({ content: BROKEN });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: 'invalid_script', compileError: { line: 4, column: 1 } });

    const put = await request(app).put('/api/sieve/scripts/Postroom%20rules').set(CSRF).set('cookie', me.cookie).send({ content: RULES });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ name: 'Postroom rules', active: false, size: Buffer.byteLength(RULES) });

    const got = await request(app).get('/api/sieve/scripts/Postroom%20rules').set('cookie', me.cookie);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ name: 'Postroom rules', content: RULES, active: false });

    expect((await request(app).post('/api/sieve/scripts/Postroom%20rules/activate').set(CSRF).set('cookie', me.cookie)).status).toBe(200);
    const listed = await request(app).get('/api/sieve/scripts').set('cookie', me.cookie);
    expect((listed.body as { scripts: { name: string; active: boolean }[] }).scripts).toEqual([expect.objectContaining({ name: 'Postroom rules', active: true })]);

    const del = await request(app).delete('/api/sieve/scripts/Postroom%20rules').set(CSRF).set('cookie', me.cookie);
    expect(del.status).toBe(409);
    expect(del.body).toMatchObject({ error: 'script_active' });

    expect((await request(app).post('/api/sieve/deactivate').set(CSRF).set('cookie', me.cookie)).status).toBe(200);
    expect((await request(app).delete('/api/sieve/scripts/Postroom%20rules').set(CSRF).set('cookie', me.cookie)).status).toBe(200);
    expect((await request(app).get('/api/sieve/scripts/Postroom%20rules').set('cookie', me.cookie)).status).toBe(404);

    const actions = (await db.auditEvent.findMany({ where: { actorAccountId: me.id, entityType: 'sieve_script' }, orderBy: { at: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(['sieve.script.put', 'sieve.script.activate', 'sieve.script.deactivate', 'sieve.script.delete']);
  });

  it('keeps accounts apart', async () => {
    const alice = await person();
    const bob = await person();
    expect((await request(app).put('/api/sieve/scripts/mine').set(CSRF).set('cookie', alice.cookie).send({ content: 'keep;' })).status).toBe(200);
    expect((await request(app).get('/api/sieve/scripts/mine').set('cookie', bob.cookie)).status).toBe(404);
    expect((await request(app).post('/api/sieve/scripts/mine/activate').set(CSRF).set('cookie', bob.cookie)).status).toBe(404);
    expect((await request(app).delete('/api/sieve/scripts/mine').set(CSRF).set('cookie', bob.cookie)).status).toBe(404);
    expect(((await request(app).get('/api/sieve/scripts').set('cookie', bob.cookie)).body as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it('refuses a bad name and an oversized script', async () => {
    const me = await person();
    expect((await request(app).put(`/api/sieve/scripts/${'x'.repeat(129)}`).set(CSRF).set('cookie', me.cookie).send({ content: 'keep;' })).body).toMatchObject({ error: 'invalid_name' });
    expect((await request(app).put('/api/sieve/scripts/a%09b').set(CSRF).set('cookie', me.cookie).send({ content: 'keep;' })).status).toBe(400);
    const big = `# ${'x'.repeat(300 * 1024)}\nkeep;\n`;
    expect((await request(app).put('/api/sieve/scripts/big').set(CSRF).set('cookie', me.cookie).send({ content: big })).status).toBe(413);
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
