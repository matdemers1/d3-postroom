// Who may claim first-run setup on a public hostname: SETUP_TOKEN when set, private client
// addresses only when it is not (fails closed on a public deploy that forgot the token).
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { baseConfig, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const SETUP_TOKEN = 'setup-token-7f3a9c2e41';
const OPERATOR = { displayName: 'Op', login: 'op', password: 'a long operator password' };

describe.skipIf(!baseUrl)('setup gate (PST-T-0.8)', () => {
  let testDb: TestDatabase;
  let db: Db;
  const clock = new TestClock();

  const denials = async (): Promise<{ reason: string; raw: string }[]> =>
    (await db.auditEvent.findMany({ where: { action: 'auth.setup.denied' }, orderBy: { at: 'asc' } })).map((r) => ({
      reason: String((r.after as { reason?: unknown } | null)?.reason),
      raw: JSON.stringify(r),
    }));

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t08');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  describe('with SETUP_TOKEN set', () => {
    let app: Express;
    beforeAll(() => {
      app = createApp({ db, env: {}, config: baseConfig(clock, { setupToken: SETUP_TOKEN }) });
    });

    it('refuses a missing token, even from loopback, and audits it', async () => {
      const res = await request(app).post('/api/auth/setup/begin').set(CSRF).send(OPERATOR);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'setup_token_required' });
      const rows = await denials();
      expect(rows.map((r) => r.reason)).toEqual(['token_missing']);
      expect(rows[0]?.raw).toContain('"actorKind":"anonymous"');
    });

    it('refuses a wrong token, without recording what was presented', async () => {
      const res = await request(app)
        .post('/api/auth/setup/begin')
        .set(CSRF)
        .send({ ...OPERATOR, setupToken: 'guess-guess-guess' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'setup_token_required' });
      const rows = await denials();
      expect(rows.map((r) => r.reason)).toEqual(['token_missing', 'token_mismatch']);
      for (const row of rows) {
        expect(row.raw).not.toContain('guess-guess-guess');
        expect(row.raw).not.toContain(SETUP_TOKEN);
        expect(row.raw).not.toContain(OPERATOR.password);
      }
    });

    it('accepts the token on both steps, and refuses complete without it', async () => {
      const begin = await request(app)
        .post('/api/auth/setup/begin')
        .set(CSRF)
        .send({ ...OPERATOR, setupToken: SETUP_TOKEN });
      expect(begin.status).toBe(200);
      const { enrolToken, secret } = begin.body as { enrolToken: string; secret: string };

      const noToken = await request(app)
        .post('/api/auth/setup/complete')
        .set(CSRF)
        .send({ enrolToken, code: totpCode(secret, clock.now()) });
      expect(noToken.status).toBe(403);
      expect(noToken.body).toEqual({ error: 'setup_token_required' });

      const done = await request(app)
        .post('/api/auth/setup/complete')
        .set(CSRF)
        .send({ setupToken: SETUP_TOKEN, enrolToken, code: totpCode(secret, clock.now()) });
      expect(done.status).toBe(200);

      // Undo, so the unset-token tests below see a setup-required database again.
      const operator = await db.account.findFirstOrThrow({ where: { isAdmin: true } });
      await db.session.deleteMany({ where: { accountId: operator.id } });
      await db.address.deleteMany({ where: { accountId: operator.id } });
      await db.account.update({
        where: { id: operator.id },
        data: { passwordHash: null, totpSecret: null, totpEnabled: false, totpLastStep: null },
      });
    });
  });

  describe('with SETUP_TOKEN unset: private client addresses only', () => {
    let app: Express;
    beforeAll(() => {
      app = createApp({ db, env: {}, config: baseConfig(clock) });
    });

    it('accepts setup from loopback (supertest connects from 127.0.0.1)', async () => {
      const res = await request(app).post('/api/auth/setup/begin').set(CSRF).send(OPERATOR);
      expect(res.status).toBe(200);
    });

    it('accepts a private client address reported by the proxy', async () => {
      const res = await request(app).post('/api/auth/setup/begin').set(CSRF).set('x-forwarded-for', '10.1.2.3').send(OPERATOR);
      expect(res.status).toBe(200);
    });

    it('refuses a public client address reported by the proxy (trust proxy), and audits it', async () => {
      const before = (await denials()).length;
      const res = await request(app)
        .post('/api/auth/setup/begin')
        .set(CSRF)
        .set('x-forwarded-for', '203.0.113.9')
        .send(OPERATOR);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'setup_token_required' });
      const complete = await request(app)
        .post('/api/auth/setup/complete')
        .set(CSRF)
        .set('x-forwarded-for', '2001:db8::1')
        .send({ enrolToken: 'x', code: '123456' });
      expect(complete.status).toBe(403);
      const rows = await denials();
      expect(rows.slice(before).map((r) => r.reason)).toEqual(['address_not_private', 'address_not_private']);
      expect(rows[before]?.raw).toContain('203.0.113.9');
    });
  });
});
