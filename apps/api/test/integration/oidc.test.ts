// PST-T-0.8 doneWhen, D3 Auth half: the full authorization-code flow against a hand-rolled issuer
// (PKCE, client_secret_basic, RS256), identity linking by (iss, sub) and never by email, the roles
// claim as an admin source, and back-channel logout. PST-T-17.16 (PST-ADR-015): D3 Auth links to an
// existing account and never creates one, and linking repairs a stray auto-provisioned account.
import { waitForAuditGuard, missingAuditCount } from '@postroom/audit';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { request } from '../loopback.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeIssuer, type FakeIssuer, type FakeIssuerUser } from '../../../../e2e/fake-issuer/server.mjs';
import { createApp } from '../../src/app.js';
import {
  baseConfig,
  cookieHeader,
  cookiesOf,
  createAccount,
  createD3AuthAccount,
  TestClock,
  totpCode,
  WEB_ORIGIN,
} from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const NOT_LINKED = 'No Postroom account is linked to this D3 Auth account yet. Sign in with your password once, and D3 Auth will be linked to it.';

interface StateBody {
  oidcConfigured: boolean;
  oidcAvailable: boolean;
  signedIn: boolean;
  method?: string;
  account?: { id: string; isAdmin: boolean };
}

describe.skipIf(!baseUrl)('Sign in with D3 Auth (PST-REQ-005, PST-REQ-007)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let issuer: FakeIssuer;
  const clock = new TestClock();
  let operator: { id: string; totpSecret: string };
  let guardMissesBefore = 0;
  const OPERATOR_PASSWORD = 'operator password, long enough';

  const state = async (jar: Record<string, string>): Promise<StateBody> => {
    const res = await request(app).get('/api/auth/state').set('cookie', cookieHeader(jar));
    return res.body as StateBody;
  };

  /** Browser round trip: /oidc/start → issuer /authorize → our /oidc/callback, cookies carried. */
  const oidcSignIn = async (
    user: FakeIssuerUser,
    jar: Record<string, string> = {},
    startPath = '/api/auth/oidc/start',
    tamper?: (callback: URL) => void,
  ): Promise<{ location: string; jar: Record<string, string> }> => {
    issuer.setUser(user);
    const start = await request(app).get(startPath).set('cookie', cookieHeader(jar));
    expect(start.status).toBe(302);
    const authorizeUrl = String(start.headers['location']);
    expect(authorizeUrl.startsWith(`${issuer.url}/authorize?`)).toBe(true);
    const params = new URL(authorizeUrl).searchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('openid profile email d3:roles');
    cookiesOf(start, jar);
    expect(jar['postroom_oidc']).toBeDefined();

    const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const callback = new URL(authorized.headers.get('location') ?? '');
    expect(callback.origin).toBe(WEB_ORIGIN);
    tamper?.(callback);

    const done = await request(app).get(`${callback.pathname}${callback.search}`).set('cookie', cookieHeader(jar));
    expect(done.status).toBe(302);
    cookiesOf(done, jar);
    return { location: String(done.headers['location']), jar };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t08');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    // The operator as setup would leave it: admin, password, TOTP, operator@d3cloud.io.
    const seeded = await db.account.findFirstOrThrow({ where: { isAdmin: true } });
    await db.account.delete({ where: { id: seeded.id } });
    operator = await createAccount(db, { login: 'operator', password: OPERATOR_PASSWORD, isAdmin: true });

    issuer = await startFakeIssuer({ port: 0, clientId: 'postroom', clientSecret: 'shh-basic-only' });
    app = createApp({
      db,
      env: {},
      config: baseConfig(clock, {
        d3authIssuer: issuer.url,
        d3authClientId: 'postroom',
        d3authClientSecret: 'shh-basic-only',
      }),
    });
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await issuer.close();
    await testDb.drop();
  });

  it('discovers the issuer and offers the button', async () => {
    expect(await state({})).toMatchObject({ oidcConfigured: true, oidcAvailable: true, signedIn: false });
  });

  /** Every audit row of this action whose `after.reason` is `reason`. */
  const rejections = async (reason: string) =>
    (await db.auditEvent.findMany({ where: { action: 'auth.oidc.rejected' }, orderBy: { at: 'asc' } })).filter(
      (row) => (row.after as { reason?: unknown } | null)?.reason === reason,
    );

  /** Password + TOTP, a fresh session. The clock moves on a step so a TOTP code is never reused. */
  const passwordSignIn = async (login: string, password: string, secret: string): Promise<Record<string, string>> => {
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post('/api/auth/signin/totp')
      .set(CSRF)
      .send({ challenge: (first.body as { challenge: string }).challenge, code: totpCode(secret, clock.now()) });
    expect(second.status).toBe(200);
    return cookiesOf(second);
  };

  const linkOf = (subject: string) => db.identityLink.findUnique({ where: { issuer_subject: { issuer: issuer.url, subject } } });

  it('refuses an unlinked identity: back to sign-in with the reason and link_after_signin, and no account is made', async () => {
    const accountsBefore = await db.account.count();
    const { location, jar } = await oidcSignIn({ sub: 'alice-1', email: 'alice@example.com', name: 'Alice', roles: [] });
    expect(location).toBe(`/signin?${new URLSearchParams({ signin_error: NOT_LINKED, link_after_signin: '1' }).toString()}`);
    expect(jar['postroom_session']).toBeUndefined();
    expect(await db.account.count()).toBe(accountsBefore);
    expect(await linkOf('alice-1')).toBeNull();
    const [row] = await rejections('not_linked');
    expect(row?.after).toEqual({ reason: 'not_linked', issuer: issuer.url, subject: 'alice-1', email: 'alice@example.com' });
  });

  it('completes the code flow for a linked identity, by (iss, sub), and signs in', async () => {
    await createD3AuthAccount(db, issuer.url, 'alice-1', { displayName: 'Alice', email: 'alice@example.com' });
    const { location, jar } = await oidcSignIn({ sub: 'alice-1', email: 'alice@example.com', name: 'Alice', roles: [] });
    expect(location).toBe('/');
    expect(jar['postroom_oidc']).toBeUndefined();
    const body = await state(jar);
    expect(body).toMatchObject({ signedIn: true, method: 'oidc', account: { isAdmin: false } });

    const link = await db.identityLink.findUniqueOrThrow({
      where: { issuer_subject: { issuer: issuer.url, subject: 'alice-1' } },
    });
    expect(link.accountId).toBe(body.account?.id);
    expect(issuer.stats.token).toBeGreaterThan(0);
    // Sign-in metadata lives on the session row, not in `setting`.
    const row = await db.session.findFirstOrThrow({ where: { accountId: link.accountId } });
    expect(row).toMatchObject({ method: 'oidc', roles: [], oidcIssuer: issuer.url, oidcSubject: 'alice-1' });
    expect(await db.setting.count({ where: { key: { startsWith: 'auth.' } } })).toBe(0);
    expect(await db.auditEvent.count({ where: { action: 'auth.signin', actorAccountId: link.accountId } })).toBe(1);

    // No admin role and no admin flag: the admin API refuses.
    expect((await request(app).get('/api/admin/sessions').set('cookie', cookieHeader(jar))).status).toBe(403);
  });

  it('the same subject with a changed email is the same account', async () => {
    const first = await db.identityLink.findUniqueOrThrow({
      where: { issuer_subject: { issuer: issuer.url, subject: 'alice-1' } },
    });
    const { jar } = await oidcSignIn({ sub: 'alice-1', email: 'alice.new@example.com', roles: [] });
    expect((await state(jar)).account?.id).toBe(first.accountId);
    const after = await db.identityLink.findUniqueOrThrow({ where: { id: first.id } });
    expect(after.email).toBe('alice.new@example.com');
  });

  it('a different subject asserting the same email is refused as unlinked — never matched by email', async () => {
    const accountsBefore = await db.account.count();
    const { location, jar } = await oidcSignIn({ sub: 'impostor-2', email: 'alice.new@example.com', roles: [] });
    expect(location).toMatch(/^\/signin\?signin_error=.+&link_after_signin=1$/);
    expect(jar['postroom_session']).toBeUndefined();
    expect(await db.account.count()).toBe(accountsBefore);
    expect(await linkOf('impostor-2')).toBeNull();
  });

  it('an identity asserting an address a local account holds is refused the same way, without a 5xx', async () => {
    const accountsBefore = await db.account.count();
    const { location, jar } = await oidcSignIn({ sub: 'mallory-3', email: 'operator@d3cloud.io', roles: [] });
    expect(location).toMatch(/^\/signin\?signin_error=.+&link_after_signin=1$/);
    expect(jar['postroom_session']).toBeUndefined();
    expect(await db.account.count()).toBe(accountsBefore);
    expect(await linkOf('mallory-3')).toBeNull();
    expect((await rejections('not_linked')).map((r) => (r.after as { subject: string }).subject)).toEqual(['alice-1', 'impostor-2', 'mallory-3']);
  });

  it('unlinked, then the password, then the link: D3 Auth reaches the password account from then on', async () => {
    // What the sign-in page does with link_after_signin=1: password + TOTP, then /oidc/start?link=1.
    const refused = await oidcSignIn({ sub: 'op-d3', email: 'matthew@example.net', roles: [] });
    expect(refused.location).toMatch(/link_after_signin=1$/);
    const accountsBefore = await db.account.count();

    const jar = await passwordSignIn('operator', OPERATOR_PASSWORD, operator.totpSecret);
    const { location } = await oidcSignIn({ sub: 'op-d3', email: 'matthew@example.net', roles: [] }, { ...jar }, '/api/auth/oidc/start?link=1');
    expect(location).toBe('/');
    const link = await db.identityLink.findUniqueOrThrow({ where: { issuer_subject: { issuer: issuer.url, subject: 'op-d3' } } });
    expect(link.accountId).toBe(operator.id);
    expect(await db.account.count()).toBe(accountsBefore);
    expect(await db.auditEvent.count({ where: { action: 'auth.identity.link', actorAccountId: operator.id } })).toBe(1);

    // From now on D3 Auth alone reaches the operator, who is an admin by the native flag.
    const fresh = await oidcSignIn({ sub: 'op-d3', email: 'matthew@example.net', roles: [] });
    expect(fresh.location).toBe('/');
    expect(await state(fresh.jar)).toMatchObject({ signedIn: true, method: 'oidc', account: { id: operator.id, isAdmin: true } });
  });

  it('linking an identity already linked to this account changes nothing', async () => {
    const before = await db.identityLink.findUniqueOrThrow({ where: { issuer_subject: { issuer: issuer.url, subject: 'op-d3' } } });
    const linksBefore = await db.identityLink.count();
    const linkAudits = await db.auditEvent.count({ where: { action: 'auth.identity.link' } });

    const jar = await passwordSignIn('operator', OPERATOR_PASSWORD, operator.totpSecret);
    const { location, jar: after } = await oidcSignIn({ sub: 'op-d3', email: 'matthew@example.net', roles: [] }, { ...jar }, '/api/auth/oidc/start?link=1');
    expect(location).toBe('/');
    expect(await state(after)).toMatchObject({ signedIn: true, account: { id: operator.id } });
    const link = await db.identityLink.findUniqueOrThrow({ where: { id: before.id } });
    expect({ id: link.id, accountId: link.accountId, createdAt: link.createdAt }).toEqual({ id: before.id, accountId: operator.id, createdAt: before.createdAt });
    expect(await db.identityLink.count()).toBe(linksBefore);
    expect(await db.auditEvent.count({ where: { action: 'auth.identity.link' } })).toBe(linkAudits);
    expect(await db.auditEvent.count({ where: { action: 'auth.identity.move' } })).toBe(0);
    const last = await db.auditEvent.findFirstOrThrow({ where: { action: 'auth.signin', actorAccountId: operator.id }, orderBy: { at: 'desc' } });
    expect(last.after).toMatchObject({ method: 'oidc', outcome: 'existing', subject: 'op-d3' });
  });

  it('linking repairs a stray auto-provisioned account: the link moves, the stray is disabled and signed out', async () => {
    // The production case: a first D3 Auth sign-in, before PST-ADR-015, made an empty account.
    const stray = await createD3AuthAccount(db, issuer.url, 'stray-6', { displayName: 'Matthew Demers', email: 'matthew@demers.example' });
    const strayJar = (await oidcSignIn({ sub: 'stray-6', email: 'matthew@demers.example', roles: [] })).jar;
    expect(await state(strayJar)).toMatchObject({ signedIn: true, account: { id: stray } });

    const owner = await createAccount(db, { login: 'owner', password: OPERATOR_PASSWORD });
    const jar = await passwordSignIn('owner', OPERATOR_PASSWORD, owner.totpSecret);
    const { location, jar: linked } = await oidcSignIn({ sub: 'stray-6', email: 'matthew@demers.example', roles: [] }, { ...jar }, '/api/auth/oidc/start?link=1');
    expect(location).toBe('/');
    expect(await state(linked)).toMatchObject({ signedIn: true, method: 'oidc', account: { id: owner.id } });

    expect((await linkOf('stray-6'))?.accountId).toBe(owner.id);
    expect((await db.account.findUniqueOrThrow({ where: { id: stray } })).disabledAt).not.toBeNull();
    expect(await db.session.count({ where: { accountId: stray } })).toBe(0);
    expect((await state(strayJar)).signedIn).toBe(false);
    const move = await db.auditEvent.findFirstOrThrow({ where: { action: 'auth.identity.move' } });
    expect(move.actorAccountId).toBe(owner.id);
    expect(move.after).toMatchObject({ from: stray, to: owner.id, issuer: issuer.url, subject: 'stray-6' });
    expect((move.after as { ended: string[] }).ended).toHaveLength(1);
    expect(await db.auditEvent.count({ where: { action: 'auth.identity.link', actorAccountId: owner.id } })).toBe(1);

    // D3 Auth now lands on the owner.
    const again = await oidcSignIn({ sub: 'stray-6', email: 'matthew@demers.example', roles: [] });
    expect(await state(again.jar)).toMatchObject({ signedIn: true, account: { id: owner.id } });
  });

  // Anything that makes an account real keeps it: a way in of its own, mail it owns or receives, an
  // admin flag, or a non-person kind (PST-ADR-015; the predicate is isEmptyAccount in oidc.ts).
  const SHAPES = {
    'a password': { key: 'pw', data: () => ({ passwordHash: 'argon2id-stand-in' }) },
    'an address': { key: 'addr', data: (localPart: string, domainId: string) => ({ addresses: { create: { localPart, domainId, kind: 'primary' as const } } }) },
    'an authenticator': { key: 'totp', data: () => ({ totpEnabled: true }) },
    'the admin flag': { key: 'admin', data: () => ({ isAdmin: true }) },
    'a service kind': { key: 'svc', data: () => ({ kind: 'service' as const }) },
    'a mailbox': { key: 'mbox', data: () => ({ mailboxes: { create: { name: 'INBOX', uidvalidity: 1 } } }) },
  } as const;
  for (const [shape, { key, data }] of Object.entries(SHAPES)) {
    it(`refuses to take a link from an account with ${shape}, and changes nothing`, async () => {
      const subject = `real-7-${key}`;
      const domain = await db.domain.findFirstOrThrow({ where: { isPrimary: true } });
      const holder = await db.account.create({
        data: {
          displayName: 'Holder',
          ...data(subject, domain.id),
          identityLinks: { create: { issuer: issuer.url, subject } },
        },
      });
      const holderSession = (await oidcSignIn({ sub: subject, roles: [] })).jar;
      const login = `asker${key}`;
      const asker = await createAccount(db, { login, password: OPERATOR_PASSWORD });
      const jar = await passwordSignIn(login, OPERATOR_PASSWORD, asker.totpSecret);
      const linksBefore = await db.identityLink.count();

      const { location, jar: after } = await oidcSignIn({ sub: subject, roles: [] }, { ...jar }, '/api/auth/oidc/start?link=1');
      // A code, not words: the Account screen holds the copy.
      expect(location).toBe('/settings/account?link_error=linked_elsewhere');
      // Still signed in as the account that asked, and nothing moved.
      expect(await state(after)).toMatchObject({ signedIn: true, method: 'password', account: { id: asker.id } });
      expect((await linkOf(subject))?.accountId).toBe(holder.id);
      expect(await db.identityLink.count()).toBe(linksBefore);
      expect((await db.account.findUniqueOrThrow({ where: { id: holder.id } })).disabledAt).toBeNull();
      expect((await state(holderSession)).signedIn).toBe(true);
      const [row] = (await rejections('linked_elsewhere')).filter((r) => (r.after as { subject: string }).subject === subject);
      expect(row?.actorAccountId).toBe(asker.id);
      expect(row?.after).toMatchObject({ issuer: issuer.url, subject, linkedAccountId: holder.id });
    });
  }

  it("grants admin from the roles claim ('admin' on this client) without the native flag", async () => {
    await createD3AuthAccount(db, issuer.url, 'role-admin-4');
    const { jar } = await oidcSignIn({ sub: 'role-admin-4', email: 'ra@example.com', roles: ['admin'] });
    const body = await state(jar);
    expect(body.account?.isAdmin).toBe(true);
    const account = await db.account.findUniqueOrThrow({ where: { id: body.account?.id ?? '' } });
    expect(account.isAdmin).toBe(false);
    expect((await db.session.findFirstOrThrow({ where: { accountId: account.id } })).roles).toEqual(['admin']);
    expect((await request(app).get('/api/admin/sessions').set('cookie', cookieHeader(jar))).status).toBe(200);
  });

  it('refuses a callback whose state does not match the one this browser started', async () => {
    const { location, jar } = await oidcSignIn({ sub: 'alice-1', roles: [] }, {}, '/api/auth/oidc/start', (cb) => {
      cb.searchParams.set('state', 'forged');
    });
    expect(location).toMatch(/^\/signin\?signin_error=/);
    expect(jar['postroom_session']).toBeUndefined();
  });

  it('refuses a callback from a browser that never started a sign-in', async () => {
    const res = await request(app).get('/api/auth/oidc/callback?code=abc&state=def');
    expect(res.status).toBe(302);
    expect(String(res.headers['location'])).toMatch(/^\/signin\?signin_error=/);
  });

  it('back-channel logout ends the D3 Auth sessions of that subject, once', async () => {
    await createD3AuthAccount(db, issuer.url, 'bcl-5');
    const { jar } = await oidcSignIn({ sub: 'bcl-5', email: 'bcl@example.com', roles: [] });
    expect((await state(jar)).signedIn).toBe(true);
    // A second D3 Auth session for the same subject: back-channel logout ends both, looked up by
    // (oidcIssuer, oidcSubject).
    const second = await oidcSignIn({ sub: 'bcl-5', email: 'bcl@example.com', roles: [] });
    expect((await state(second.jar)).signedIn).toBe(true);

    const bad = await request(app).post('/api/auth/oidc/backchannel-logout').type('form').send({ logout_token: 'nope' });
    expect(bad.status).toBe(400);

    const token = issuer.logoutToken('bcl-5');
    // Server-to-server: no CSRF header, no cookie — the signed token is the authentication.
    const res = await request(app).post('/api/auth/oidc/backchannel-logout').type('form').send({ logout_token: token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ended: 2, repeated: false });
    expect((await state(jar)).signedIn).toBe(false);
    expect((await state(second.jar)).signedIn).toBe(false);

    const again = await request(app).post('/api/auth/oidc/backchannel-logout').type('form').send({ logout_token: token });
    expect(again.body).toMatchObject({ ok: true, ended: 0, repeated: true });
  });

  it('left no successful mutation unaudited', async () => {
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });
});
