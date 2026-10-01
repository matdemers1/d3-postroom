// PST-T-16.16 (PST-DA-039, PST-REQ-139): the one-time profile link's token is unguessable, bound to
// one account and one expiry, unforgeable without the server's secret, and gives one answer for
// every way it can be wrong. And the Connect a device screen's copyable settings are the same hosts
// and ports the Thunderbird autoconfig document advertises, for the same environment.
import { randomUUID } from 'node:crypto';
import { auditContext } from '@postroom/audit';
import type { Db } from '@postroom/db';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { LINK_ID_RE, LINK_TTL_MS, WindowLimiter, linkKey, mintLinkToken, readLinkToken } from '../../src/mobileconfig/link.js';
import { mailHostsOf, mailSettingsOf, mobileconfigOnceRoutes } from '../../src/mobileconfig/index.js';
import { request } from '../loopback.js';

const KEY = linkKey('test-session-secret-0123456789abcdef');
const ACCOUNT = '0b6f1e9a-3c1d-4f6e-9a2b-7c8d9e0f1a2b';
const NOW = new Date('2026-09-30T12:00:00.000Z');

describe('one-time profile link tokens', () => {
  it('round-trips the account, expiry and link id', () => {
    const minted = mintLinkToken(KEY, ACCOUNT, NOW);
    expect(minted.expiresAt.getTime() - NOW.getTime()).toBe(LINK_TTL_MS);
    expect(minted.linkId).toMatch(LINK_ID_RE);
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{98}$/);
    expect(readLinkToken(KEY, minted.token, NOW)).toEqual({ accountId: ACCOUNT, linkId: minted.linkId, expiresAt: minted.expiresAt });
  });

  it('carries 128 random bits: two links for the same account and instant differ, token and id', () => {
    const a = mintLinkToken(KEY, ACCOUNT, NOW);
    const b = mintLinkToken(KEY, ACCOUNT, NOW);
    expect(a.token).not.toBe(b.token);
    expect(a.linkId).not.toBe(b.linkId);
  });

  it('never puts the nonce or the token in the link id', () => {
    const nonce = Buffer.alloc(16, 0xab);
    const minted = mintLinkToken(KEY, ACCOUNT, NOW, LINK_TTL_MS, nonce);
    expect(minted.linkId).not.toContain(nonce.toString('hex'));
    expect(minted.token).not.toContain(minted.linkId);
  });

  it('expires at the expiry instant, not a millisecond later', () => {
    const minted = mintLinkToken(KEY, ACCOUNT, NOW);
    expect(readLinkToken(KEY, minted.token, new Date(minted.expiresAt.getTime() - 1))).not.toBeNull();
    expect(readLinkToken(KEY, minted.token, minted.expiresAt)).toBeNull();
    expect(readLinkToken(KEY, minted.token, new Date(minted.expiresAt.getTime() + 60_000))).toBeNull();
  });

  it('refuses a token made with another key', () => {
    const minted = mintLinkToken(linkKey('some-other-secret'), ACCOUNT, NOW);
    expect(readLinkToken(KEY, minted.token, NOW)).toBeNull();
  });

  it('refuses a token with any byte changed — the account, the expiry, the nonce or the MAC', () => {
    const minted = mintLinkToken(KEY, ACCOUNT, NOW);
    const raw = Buffer.from(minted.token, 'base64url');
    for (const offset of [1, 17, 20, 30, raw.length - 1]) {
      const tampered = Buffer.from(raw);
      tampered[offset] = (tampered[offset] ?? 0) ^ 0x01;
      expect(readLinkToken(KEY, tampered.toString('base64url'), NOW), `byte ${String(offset)}`).toBeNull();
    }
  });

  it('refuses a later expiry spliced in without re-signing', () => {
    const minted = mintLinkToken(KEY, ACCOUNT, NOW);
    const raw = Buffer.from(minted.token, 'base64url');
    raw.writeBigUInt64BE(BigInt(NOW.getTime() + 24 * 3600_000), 17);
    expect(readLinkToken(KEY, raw.toString('base64url'), NOW)).toBeNull();
  });

  it('refuses anything not shaped like a token before doing any crypto', () => {
    for (const token of ['', 'x', 'a'.repeat(97), 'a'.repeat(99), `${'a'.repeat(97)}=`, `${'a'.repeat(97)}/`, '../../etc/passwd']) {
      expect(readLinkToken(KEY, token, NOW)).toBeNull();
    }
  });

  it('refuses to mint for a non-UUID account or a short nonce', () => {
    expect(() => mintLinkToken(KEY, 'not-a-uuid', NOW)).toThrow();
    expect(() => mintLinkToken(KEY, ACCOUNT, NOW, LINK_TTL_MS, Buffer.alloc(8))).toThrow();
  });

  it('a different character anywhere but the padding bits is a different, refused token', () => {
    const minted = mintLinkToken(KEY, ACCOUNT, NOW);
    for (const at of [0, 10, 40, 96]) {
      const swapped = minted.token[at] === 'A' ? 'B' : 'A';
      const forged = `${minted.token.slice(0, at)}${swapped}${minted.token.slice(at + 1)}`;
      expect(readLinkToken(KEY, forged, NOW), `char ${String(at)}`).toBeNull();
    }
  });

  it('works for any account id', () => {
    const id = randomUUID();
    expect(readLinkToken(KEY, mintLinkToken(KEY, id, NOW).token, NOW)?.accountId).toBe(id);
  });
});

describe('WindowLimiter', () => {
  it('blocks a key at its allowance, per key, until the window passes', () => {
    const limiter = new WindowLimiter(2, 1_000);
    limiter.hit('a', 0);
    expect(limiter.blocked('a', 10)).toBe(false);
    limiter.hit('a', 20);
    expect(limiter.blocked('a', 30)).toBe(true);
    expect(limiter.blocked('b', 30)).toBe(false);
    expect(limiter.blocked('a', 1_000)).toBe(false);
    limiter.hit('a', 1_000);
    expect(limiter.blocked('a', 1_001)).toBe(false);
  });

  it('forgets its oldest key past the key limit', () => {
    const limiter = new WindowLimiter(1, 1_000, 2);
    limiter.hit('a', 0);
    limiter.hit('b', 0);
    limiter.hit('c', 0);
    expect(limiter.blocked('a', 1)).toBe(false);
    expect(limiter.blocked('c', 1)).toBe(true);
  });
});

/** The ports and hosts named in a Thunderbird autoconfig document, as `host:port/socket` strings. */
function serversIn(xml: string): string[] {
  return [...xml.matchAll(/<hostname>([^<]+)<\/hostname>\s*<port>(\d+)<\/port>\s*<socketType>([^<]+)<\/socketType>/g)].map((m) => `${m[1] ?? ''}:${m[2] ?? ''}/${m[3] ?? ''}`);
}

describe('the copyable settings agree with autoconfig', () => {
  const fakeDb = {
    domain: { findFirst: () => Promise.resolve({ id: 'dom-1', name: 'd3cloud.io', isPrimary: true, createdAt: new Date() }) },
  } as unknown as Db;
  const config = { webDist: undefined, webOrigin: 'https://mail.d3cloud.io', revision: 'abc123' };

  for (const env of [{}, { IMAP_HOSTNAME: 'imap.example.test', SUBMISSION_HOSTNAME: 'smtp.example.test' }] as NodeJS.ProcessEnv[]) {
    it(`for ${env['IMAP_HOSTNAME'] === undefined ? 'the defaults' : 'configured hosts'}`, async () => {
      const res = await request(createApp({ db: fakeDb, env, config })).get('/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=me%40d3cloud.io');
      expect(res.status).toBe(200);
      const settings = mailSettingsOf(mailHostsOf(env), 'me@d3cloud.io');
      const socket = (s: string): string => (s === 'starttls' ? 'STARTTLS' : 'SSL');
      expect(serversIn(res.text)).toEqual([
        `${settings.imap.host}:${String(settings.imap.port)}/${socket(settings.imap.security)}`,
        ...settings.smtp.map((s) => `${s.host}:${String(s.port)}/${socket(s.security)}`),
      ]);
      expect(settings.username).toBe('me@d3cloud.io');
      expect(settings.imap.port).toBe(993);
      expect(settings.smtp.map((s) => s.port)).toEqual([465, 587]);
    });
  }
});

describe('the one-time route, before it touches the database', () => {
  // Any database call here is a failure: a malformed, forged or HEAD request must be answered
  // without a query (the account lookup and the spend come only after the MAC checks out).
  const db = new Proxy({}, { get: () => { throw new Error('the database was touched'); } }) as unknown as Db;
  const app = express();
  app.use('/api/mobileconfig/once', auditContext(), mobileconfigOnceRoutes({ db, env: {}, config: { webDist: undefined, webOrigin: 'https://mail.d3cloud.io', revision: 'test', passwordPepper: 'p'.repeat(32), sessionSecret: 's'.repeat(32), now: () => NOW } }));
  const forged = mintLinkToken(linkKey('not-the-server-secret'), ACCOUNT, NOW).token;

  it('answers 410 in plain text, the same body, for a malformed, a forged or an expired token', async () => {
    const real = linkKey('s'.repeat(32));
    const expired = mintLinkToken(real, ACCOUNT, new Date(NOW.getTime() - LINK_TTL_MS - 1)).token;
    const bodies = new Set<string>();
    for (const token of ['not-a-token', forged, expired]) {
      const res = await request(app).get(`/api/mobileconfig/once/${token}`);
      expect(res.status).toBe(410);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['cache-control']).toBe('no-store');
      bodies.add(res.text);
    }
    expect(bodies.size).toBe(1);
  });

  it('answers HEAD with 405 and never spends anything', async () => {
    const res = await request(app).head(`/api/mobileconfig/once/${forged}`);
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET');
  });

  it('says 503 when no session secret is configured, rather than accepting unsigned links', async () => {
    const bare = express();
    bare.use('/once', auditContext(), mobileconfigOnceRoutes({ db, env: {}, config: { webDist: undefined, webOrigin: 'https://mail.d3cloud.io', revision: 'test', passwordPepper: 'p'.repeat(32), now: () => NOW } }));
    expect((await request(bare).get(`/once/${forged}`)).status).toBe(503);
  });
});
