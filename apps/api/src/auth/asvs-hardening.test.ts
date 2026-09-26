// Unit proofs for the fixes the ASVS 5.0 L2 self-assessment made (PST-T-4.3, PST-REQ-091;
// docs/security/asvs-l2.md). The database-backed routes are covered by apps/api's integration suite.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { createApp, HSTS } from '../app.js';
import { openTransaction, sealTransaction, SECURE_TX_COOKIE, TX_COOKIE, txCookieName } from './oidc.js';
import { checkPassword, CONTEXT_WORDS } from './password-policy.js';
import { SECURE_SESSION_COOKIE, SESSION_COOKIE, sessionCookieName } from './sessions.js';

const db = {} as Db;
const secure = { webDist: undefined, webOrigin: 'https://mail.d3cloud.io', revision: 'x' };
const loopback = { webDist: undefined, webOrigin: 'http://127.0.0.1:3300', revision: 'x' };

describe('password policy (ASVS 6.1.2, 6.2.1, 6.2.4, 6.2.9, 6.2.11, 6.2.12)', () => {
  it('refuses short, common and context-word passwords, and says why', () => {
    expect(checkPassword('eleven char')).toEqual(['too_short']);
    expect(checkPassword('q1w2e3r4t5y6')).toEqual(['common']);
    expect(checkPassword('Q1W2E3R4T5Y6')).toEqual(['common']);
    expect(checkPassword('my Postroom-2026 spring')).toEqual(['context_word']);
    expect(checkPassword('long enough but examplemail', { domain: 'examplemail.test' })).toEqual(['context_word']);
    expect(checkPassword('x'.repeat(1025))).toContain('too_long');
    expect(CONTEXT_WORDS).toContain('postroom');
  });

  it('accepts 64+ characters and any composition, counting what a person sees', () => {
    expect(checkPassword('a'.repeat(12) + ' '.repeat(52) + 'z')).toEqual([]);
    expect(checkPassword('🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒')).toEqual([]);
    expect(checkPassword('🔒🔒🔒🔒🔒🔒')).toEqual(['too_short']);
  });

  it('leaves the passwords the test suites set up with alone', () => {
    for (const password of ['correct horse battery staple', 'e2e operator password 4912', 'a long operator password', 'operator password, long enough']) {
      expect(checkPassword(password, { domain: 'd3cloud.test' }), password).toEqual([]);
    }
  });
});

describe('cookies (ASVS 3.3.1, 3.3.3)', () => {
  it('uses the __Host- prefix on a secure origin and the bare name on plain-http loopback', () => {
    expect(sessionCookieName(true)).toBe(SECURE_SESSION_COOKIE);
    expect(SECURE_SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    expect(sessionCookieName(false)).toBe(SESSION_COOKIE);
    expect(txCookieName(true)).toBe(SECURE_TX_COOKIE);
    expect(SECURE_TX_COOKIE.startsWith('__Host-')).toBe(true);
    expect(txCookieName(false)).toBe(TX_COOKIE);
  });

  it('refuses a truncated GCM tag on the transaction cookie', () => {
    const sealed = Buffer.from(sealTransaction('s', { verifier: 'v', state: 's', nonce: 'n', exp: 1 }), 'base64url');
    const short = sealed.subarray(0, sealed.length - 4).toString('base64url');
    expect(openTransaction('s', short)).toBeNull();
  });
});

describe('transport headers (ASVS 3.4.1)', () => {
  it('sends HSTS for two years with subdomains on a secure origin', async () => {
    const res = await request(createApp({ db, env: {}, config: secure })).get('/api/nothing');
    expect(res.headers['strict-transport-security']).toBe(HSTS);
    expect(HSTS).toMatch(/max-age=(\d+); includeSubDomains/);
    expect(Number(/max-age=(\d+)/.exec(HSTS)?.[1])).toBeGreaterThanOrEqual(31_536_000);
  });

  it('does not send HSTS from a plain-http loopback stack', async () => {
    const res = await request(createApp({ db, env: {}, config: loopback })).get('/api/nothing');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('new routes sit behind the session and CSRF guards', () => {
  const app = createApp({ db, env: {}, config: loopback });
  it.each([
    ['post', '/api/auth/password'],
    ['delete', '/api/auth/sessions'],
    ['delete', '/api/auth/sessions/00000000-0000-4000-8000-000000000000'],
    ['delete', '/api/admin/sessions?all=1'],
  ] as const)('%s %s: 403 cross-site, 401 without a session', async (method, path) => {
    expect((await request(app)[method](path).set('origin', 'https://evil.example')).status).toBe(403);
    expect((await request(app)[method](path).set('x-postroom-csrf', '1')).status).toBe(401);
  });
});
