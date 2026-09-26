// PST-REQ-027 and PST-REQ-075 on the DAV surface: app passwords only (the account password is
// refused even when it is right), the dav scope is required, failures are tarpitted, throttled and
// audited, credentials are refused unless they arrived over HTTPS through the tunnel, an account
// never sees another's tree, and a revoked app password stops working on the very next request.
import { createAuthThrottle } from '@postroom/auth-throttle';
import { revokeAppPassword } from '@postroom/credentials';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IOS_PROPFIND_PRINCIPAL } from '../fixtures.js';
import { WEB_PASSWORD, client, makeAccount, startHarness, type Account, type Harness } from './harness.js';

let h: Harness;
let account: Account;

beforeAll(async () => {
  h = await startHarness('pst_dav_auth');
  account = await makeAccount(h);
});
afterAll(async () => {
  await h.close();
});

const propfind = { body: IOS_PROPFIND_PRINCIPAL, headers: { Depth: '0' } };

async function failures(ip: string): Promise<{ protocol: unknown; reason: unknown }[]> {
  const rows = await h.db.auditEvent.findMany({ where: { action: 'auth.failure', ip }, orderBy: { at: 'asc' } });
  return rows.map((r) => {
    const after = r.after as { protocol?: unknown; reason?: unknown };
    return { protocol: after.protocol, reason: after.reason };
  });
}

describe('credentials', () => {
  it('accepts an app password scoped to dav', async () => {
    expect((await client(h.base, account).request('PROPFIND', '/dav/', propfind)).status).toBe(207);
  });

  it('refuses the account password, even though it is correct, and audits the failure', async () => {
    const c = client(h.base, null, { 'CF-Connecting-IP': '198.51.100.21' });
    const r = await c.request('PROPFIND', '/dav/', { ...propfind, auth: { user: account.address, pass: WEB_PASSWORD } });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('Basic');
    expect(await failures('198.51.100.21')).toEqual([{ protocol: 'dav', reason: 'bad_password' }]);
  });

  it('refuses an app password without the dav scope, and a wrong or malformed one', async () => {
    const imapOnly = await makeAccount(h, ['imap']);
    const c = client(h.base, null, { 'CF-Connecting-IP': '198.51.100.22' });
    expect((await c.request('PROPFIND', '/dav/', { ...propfind, auth: { user: imapOnly.address, pass: imapOnly.appPassword } })).status).toBe(401);
    expect((await c.request('PROPFIND', '/dav/', { ...propfind, auth: { user: account.address, pass: `${account.appPassword.slice(0, -1)}x` } })).status).toBe(401);
    expect((await c.request('PROPFIND', '/dav/', { ...propfind, auth: { user: 'nobody@d3cloud.io', pass: account.appPassword } })).status).toBe(401);
    expect((await c.request('PROPFIND', '/dav/', { ...propfind, headers: { ...propfind.headers, Authorization: 'Basic !!!' }, auth: false })).status).toBe(401);
    expect((await failures('198.51.100.22')).map((f) => f.reason)).toEqual(['wrong_scope', 'bad_password', 'unknown_user', 'malformed']);
  });

  it('tarpits a failing streak and then refuses the source outright', async () => {
    const c = client(h.base, null, { 'CF-Connecting-IP': '192.0.2.23' });
    h.sleeps.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push((await c.request('PROPFIND', '/dav/', { ...propfind, auth: { user: account.address, pass: `wrong-${String(i)}` } })).status);
    }
    // Three free failures, then the tarpit doubles; at the source ceiling (12 in the harness) it refuses.
    expect(h.sleeps.slice(0, 3)).toEqual([1000, 2000, 4000]);
    expect(statuses.slice(0, 12).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(12)).toEqual([429, 429]);
    // Refused without looking at the credentials: even a right app password, not yet verified, from that source.
    const fresh = await makeAccount(h);
    expect((await client(h.base, fresh, { 'CF-Connecting-IP': '192.0.2.23' }).request('PROPFIND', '/dav/', propfind)).status).toBe(429);
    // Another client is unaffected.
    expect((await client(h.base, account, { 'CF-Connecting-IP': '203.0.113.99' }).request('PROPFIND', '/dav/', propfind)).status).toBe(207);
  });

  it('stops accepting a revoked app password on the next request, despite the verified-login cache', async () => {
    const a = await makeAccount(h);
    const c = client(h.base, a);
    expect((await c.request('PROPFIND', '/dav/', propfind)).status).toBe(207);
    expect((await c.request('PROPFIND', '/dav/', propfind)).status).toBe(207);
    await revokeAppPassword(h.db, { kind: 'system', label: 'test' }, { id: a.appPasswordId });
    expect((await c.request('PROPFIND', '/dav/', propfind)).status).toBe(401);
  });

  it('stops accepting a disabled account on the next request', async () => {
    const a = await makeAccount(h);
    const c = client(h.base, a);
    expect((await c.request('PROPFIND', '/dav/', propfind)).status).toBe(207);
    await h.db.account.update({ where: { id: a.id }, data: { disabledAt: new Date() } });
    expect((await c.request('PROPFIND', '/dav/', propfind)).status).toBe(401);
  });
});

describe('transport', () => {
  it('refuses credentials that did not arrive over HTTPS, without checking them', async () => {
    const before = await h.db.auditEvent.count({ where: { action: 'auth.failure' } });
    const plain = client(h.base, account, { 'X-Forwarded-Proto': 'http' });
    const r = await plain.request('PROPFIND', '/dav/', propfind);
    expect(r.status).toBe(403);
    expect(r.text).toContain('HTTPS');
    expect(await h.db.auditEvent.count({ where: { action: 'auth.failure' } })).toBe(before);
  });

  it('believes X-Forwarded-Proto and CF-Connecting-IP only from a trusted proxy', async () => {
    const other = await h.serverWith({ trustedProxies: ['10.9.9.9/32'] }, createAuthThrottle({ db: h.db, sleep: () => Promise.resolve() }));
    const r = await client(other.base, account).request('PROPFIND', '/dav/', propfind);
    expect(r.status).toBe(403);
  });

  it('never lets one account see another account’s tree', async () => {
    const other = await makeAccount(h);
    const c = client(h.base, account);
    for (const path of [`/dav/principals/${other.id}/`, `/dav/calendars/${other.id}/`, `/dav/calendars/${other.id}/calendar/`, `/dav/addressbooks/${other.id}/contacts/`]) {
      expect((await c.request('PROPFIND', path, propfind)).status).toBe(404);
    }
    expect((await c.request('DELETE', `/dav/calendars/${other.id}/calendar/`)).status).toBe(404);
    expect(await h.db.davCollection.count({ where: { accountId: other.id } })).toBe(2);
  });

  it('answers OPTIONS and the well-known redirects without credentials, and nothing else', async () => {
    const anon = client(h.base, null);
    expect((await anon.request('OPTIONS', '/dav/')).headers.get('dav')).toBe('1, 3, extended-mkcol, calendar-access, addressbook');
    expect((await anon.request('GET', '/.well-known/carddav')).status).toBe(301);
    expect((await anon.request('PROPFIND', `/dav/calendars/${account.id}/`, propfind)).status).toBe(401);
    expect((await anon.request('GET', '/etc/passwd')).status).toBe(404);
    expect((await anon.request('GET', '/dav/../etc/passwd')).status).toBe(404);
  });
});
