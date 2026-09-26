import { request } from '../loopback.js';
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { createApp } from '../../src/app.js';
import { openTransaction, sealTransaction } from '../../src/auth/oidc.js';
import { isSecureOrigin } from '../../src/auth/sessions.js';
import { delayFor, SignInThrottle } from '../../src/auth/throttle.js';
import { matchStep } from '../../src/auth/totp.js';

const config = { webDist: undefined, webOrigin: 'https://mail.d3cloud.io', revision: 'x' };

describe('auth pieces', () => {
  it('marks the cookie Secure except on a plain-http loopback origin', () => {
    expect(isSecureOrigin('https://mail.d3cloud.io')).toBe(true);
    expect(isSecureOrigin('http://mail.d3cloud.io')).toBe(true);
    expect(isSecureOrigin('http://localhost:3300')).toBe(false);
    expect(isSecureOrigin('http://127.0.0.1:3399')).toBe(false);
  });

  it('seals the OIDC transaction so it can be neither read nor forged', () => {
    const tx = { verifier: 'v', state: 's', nonce: 'n', exp: 123 };
    const sealed = sealTransaction('secret-one', tx);
    expect(sealed).not.toContain('verifier');
    expect(openTransaction('secret-one', sealed)).toEqual(tx);
    expect(openTransaction('secret-two', sealed)).toBeNull();
    const flipped = Buffer.from(sealed, 'base64url');
    flipped[14] = (flipped[14] ?? 0) ^ 1;
    expect(openTransaction('secret-one', flipped.toString('base64url'))).toBeNull();
  });

  it('throttles with doubling after five free failures and never locks out for good', () => {
    expect([1, 4, 5, 6, 7].map(delayFor)).toEqual([0, 0, 1000, 2000, 4000]);
    expect(delayFor(100)).toBe(5 * 60 * 1000);
    const t = new SignInThrottle();
    for (let i = 0; i < 5; i++) t.recordFailure('Matt', '1.2.3.4', 1000);
    expect(t.retryAfter('matt', '1.2.3.4', 1000)).toBe(1000);
    expect(t.retryAfter('matt', '5.6.7.8', 1000)).toBe(0);
    expect(t.retryAfter('matt', '1.2.3.4', 2000)).toBe(0);
  });

  it('accepts only six-digit codes', () => {
    expect(matchStep('JBSWY3DPEHPK3PXP', 'abcdef', new Date())).toBeNull();
    expect(matchStep('JBSWY3DPEHPK3PXP', '12345', new Date())).toBeNull();
  });

  it('refuses a cross-site POST under /api before any handler runs', async () => {
    const app = createApp({ db: {} as Db, env: {}, config });
    const res = await request(app).post('/api/auth/signout').set('origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'csrf' });
  });

  it('answers 503, not a hash without a pepper, when auth secrets are missing', async () => {
    const db = { account: { count: () => Promise.resolve(0) } } as unknown as Db;
    const app = createApp({ db, env: {}, config });
    const res = await request(app).post('/api/auth/signin').set('x-postroom-csrf', '1').send({ login: 'a', password: 'b' });
    expect(res.status).toBe(503);
  });
});

describe('setup gate', () => {
  it('recognises loopback and private addresses, and nothing public', async () => {
    const { isPrivateAddress, checkSetupGate } = await import('../../src/auth/setup-gate.js');
    for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1', '10.9.8.7', '172.16.0.1', '172.31.255.255', '192.168.1.1', 'fd12::1', 'fc00::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['203.0.113.9', '172.32.0.1', '8.8.8.8', '::ffff:8.8.8.8', '2001:db8::1', '', undefined]) {
      expect(isPrivateAddress(ip), String(ip)).toBe(false);
    }
    expect(checkSetupGate('tok', 'tok', '8.8.8.8')).toEqual({ ok: true });
    expect(checkSetupGate('tok', 'nope', '127.0.0.1')).toEqual({ ok: false, reason: 'token_mismatch' });
    expect(checkSetupGate('tok', undefined, '127.0.0.1')).toEqual({ ok: false, reason: 'token_missing' });
    expect(checkSetupGate(null, undefined, '8.8.8.8')).toEqual({ ok: false, reason: 'address_not_private' });
  });
});
