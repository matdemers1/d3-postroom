// PST-T-19.3, the D3 App contract: D3 Auth access tokens as Bearer credentials. The manifest offers
// D3 Auth while it is configured; a token is checked against the issuer's keys for issuer, audience
// (this origin), time and algorithm; an unlinked identity is identity_not_linked until the link flow
// proves the local account; a linked token reaches the JSON API and the event stream with no cookie
// and no CSRF header; and it is never listed among the sessions this server issued itself.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setKeysForTesting } from '../../src/auth/d3auth-bearer.js';
import { request } from '../loopback.js';
import { baseConfig, createAccount, TestClock, totpCode, WEB_ORIGIN } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const ISSUER = 'http://127.0.0.1:9/d3auth';
const PROBLEM = 'https://d3cloud.io/problems/';
const PASSWORD = 'correct horse battery staple';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

describe.skipIf(!baseUrl)('D3 Auth tokens on the native contract (PST-T-19.3)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let privateKey: SigningKey;
  let strangerKey: SigningKey;
  let accountId = '';
  let secret = '';
  let guardMissesBefore = 0;

  const token = async (opts: { sub?: string; aud?: string; iss?: string; expSeconds?: number; key?: SigningKey; roles?: string[] } = {}): Promise<string> =>
    new SignJWT({ roles: opts.roles ?? ['user'] })
      .setProtectedHeader({ alg: 'ES256', kid: opts.key === undefined ? 'k1' : 'k2' })
      .setIssuer(opts.iss ?? ISSUER)
      .setSubject(opts.sub ?? 'alice-1')
      .setAudience(opts.aud ?? WEB_ORIGIN)
      .setIssuedAt(Math.floor(clock.now().getTime() / 1000))
      .setExpirationTime(Math.floor(clock.now().getTime() / 1000) + (opts.expSeconds ?? 600))
      .sign(opts.key ?? privateKey);
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const typeOf = (res: { headers: Record<string, string>; text: string }): string => {
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    return (JSON.parse(res.text) as { type: string }).type.replace(PROBLEM, '');
  };
  const me = (t: string) => request(app).get('/api/auth/native/me').set(bearer(t));

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t193');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    const made = await createAccount(db, { login: 'matt', password: PASSWORD, isAdmin: false, displayName: 'Matt' });
    accountId = made.id;
    secret = made.totpSecret;

    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    strangerKey = (await generateKeyPair('ES256')).privateKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    setKeysForTesting(() => keys);

    app = createApp({
      db,
      env: { DATABASE_URL: testDb.url },
      config: baseConfig(clock, { d3authIssuer: ISSUER, d3authClientId: 'postroom', d3authClientSecret: 'shh' }),
    });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    setKeysForTesting(null);
    await testDb.drop();
  });

  it('the manifest offers D3 Auth with this origin as the resource, and a link endpoint', async () => {
    const res = await request(app).get('/.well-known/d3-app.json');
    const manifest = res.body as { signIn: { methods: string[]; d3auth?: { issuer: string; resource: string } }; endpoints: Record<string, string | null> };
    expect(manifest.signIn.methods).toContain('d3auth');
    expect(manifest.signIn.d3auth).toEqual({ issuer: ISSUER, resource: WEB_ORIGIN });
    expect(manifest.endpoints['link']).toBe(`${WEB_ORIGIN}/api/auth/native/link`);
  });

  it('an unlinked identity is identity_not_linked, and opens nothing', async () => {
    const t = await token();
    const res = await me(t);
    expect(res.status).toBe(401);
    expect(typeOf(res)).toBe('identity_not_linked');
    expect((await request(app).get('/api/auth/sessions').set(bearer(t))).status).toBe(401);
  });

  it('a token for another audience, issuer, key or time is refused — never identity_not_linked', async () => {
    for (const t of [
      await token({ aud: 'https://bindery.d3cloud.io' }),
      await token({ iss: 'https://evil.example' }),
      await token({ key: strangerKey }),
      await token({ expSeconds: -120 }),
    ]) {
      const res = await me(t);
      expect(res.status).toBe(401);
      expect(typeOf(res)).toBe('session_revoked');
    }
    // An HS256 token is not one of the provider's, whatever it claims.
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER).setSubject('alice-1').setAudience(WEB_ORIGIN).setExpirationTime('10m').sign(new TextEncoder().encode('x'.repeat(32)));
    expect(typeOf(await me(forged))).toBe('session_revoked');
  });

  it('link proves the account with its own password and code, throttled refusals as problems', async () => {
    const t = await token();
    const wrongPassword = await request(app).post('/api/auth/native/link').set(bearer(t)).send({ email: 'matt@d3cloud.io', password: 'nope', totp: '000000' });
    expect(wrongPassword.status).toBe(401);
    expect(typeOf(wrongPassword)).toBe('invalid_credentials');
    clock.advance(31_000);
    const right = totpCode(secret, clock.now());
    const wrongCode = await request(app)
      .post('/api/auth/native/link')
      .set(bearer(t))
      .send({ email: 'matt@d3cloud.io', password: PASSWORD, totp: String((Number(right) + 1) % 1_000_000).padStart(6, '0') });
    expect(typeOf(wrongCode)).toBe('invalid_code');
    expect(await db.identityLink.count()).toBe(0);

    const noToken = await request(app).post('/api/auth/native/link').send({ email: 'matt@d3cloud.io', password: PASSWORD, totp: right });
    expect(typeOf(noToken)).toBe('session_revoked');

    const linked = await request(app).post('/api/auth/native/link').set(bearer(t)).send({ email: 'matt@d3cloud.io', password: PASSWORD, totp: right });
    expect(linked.status).toBe(200);
    expect(linked.body).toEqual({ linked: true, accountId });
    expect(await db.identityLink.findUnique({ where: { issuer_subject: { issuer: ISSUER, subject: 'alice-1' } } })).toMatchObject({ accountId });
    expect(await db.auditEvent.count({ where: { action: 'auth.identity.link' } })).toBe(1);
  });

  it('a linked token answers me with the roles it carries, and is not listed as an issued session', async () => {
    const t = await token({ roles: ['admin'] });
    const res = await me(t);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accountId, email: 'matt@d3cloud.io', roles: ['admin'] });
    const listed = await request(app).get('/api/auth/sessions').set(bearer(t));
    expect(listed.status).toBe(200);
    expect((listed.body as { sessions: unknown[] }).sessions).toHaveLength(0);
    // The same token again finds its row; it is verified once.
    expect((await me(t)).status).toBe(200);
    expect(await db.session.count({ where: { accountId, method: 'oidc', native: true } })).toBe(1);
  });

  it('the event stream connects with a Bearer token only — no cookie, no CSRF header', async () => {
    const t = await token();
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const { status, type } = await new Promise<{ status: number; type: string }>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { ...bearer(t), accept: 'text/event-stream' } }, (res) => {
          resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']) });
          req.destroy();
        });
        req.on('error', reject);
      });
      expect(status).toBe(200);
      expect(type).toMatch(/^text\/event-stream/);
      const wrong = await request(app).get('/api/events').set(bearer(await token({ aud: 'https://bindery.d3cloud.io' })));
      expect(wrong.status).toBe(401);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    }
  });

  it('wrote an audit row for every successful mutation', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
