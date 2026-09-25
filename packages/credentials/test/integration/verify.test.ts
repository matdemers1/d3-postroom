// verifyProtocolLogin against a real database (PST-REQ-027): each scope, every refusal, the web
// password never accepted, revocation immediate, and one Argon2 verify on every path.
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import argon2 from 'argon2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  APP_PASSWORD_SCOPES,
  CredentialError,
  createAppPassword,
  generateAppPassword,
  groupForDisplay,
  listAppPasswords,
  revokeAppPassword,
  verifyProtocolLogin,
} from '../../src/index.js';
import { OPERATOR, PEPPER, makeAccount } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(!baseUrl)('app passwords against PostgreSQL (PST-T-1.3)', () => {
  let testDb: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t13');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const login = (username: string, password: string, scope: (typeof APP_PASSWORD_SCOPES)[number] = 'smtp') =>
    verifyProtocolLogin(db, { username, password, scope, ip: '192.0.2.7' }, { pepper: PEPPER });

  it('creates a password, stores only its hash, and audits the creation', async () => {
    const acct = await makeAccount(db);
    const created = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: ' Phone ', scopes: ['smtp', 'imap'] }, { pepper: PEPPER });
    expect(created.password).toMatch(/^[a-z2-7]{4}(-[a-z2-7]{4}){6}$/);
    expect(created.appPassword).toMatchObject({ label: 'Phone', scopes: ['imap', 'smtp'], revokedAt: null });
    expect(created.appPassword).not.toHaveProperty('hash');

    const row = await db.appPassword.findUniqueOrThrow({ where: { id: created.appPassword.id } });
    expect(row.hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(row.hash).not.toContain(created.password.replaceAll('-', '').slice(8));
    expect(row.prefix).toBe(created.appPassword.prefix);

    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'app_password.create', entityId: row.id } });
    expect(JSON.stringify(audit.after)).not.toContain(created.password.replaceAll('-', '').slice(8));
    expect(JSON.stringify(audit.after)).not.toContain('argon2');

    const listed = await listAppPasswords(db, acct.id);
    expect(listed.map((p) => p.id)).toEqual([row.id]);
    expect(listed[0]).not.toHaveProperty('hash');
  });

  it('refuses bad input', async () => {
    const acct = await makeAccount(db);
    const make = (label: string, scopes: never[] | ('smtp' | 'imap')[], cap?: number) =>
      createAppPassword(db, OPERATOR, { accountId: acct.id, label, scopes, ...(cap === undefined ? {} : { dailyRecipientCap: cap }) }, { pepper: PEPPER });
    await expect(make('  ', ['smtp'])).rejects.toMatchObject({ code: 'invalid_label' });
    await expect(make('x', [])).rejects.toBeInstanceOf(CredentialError);
    await expect(make('x', ['smtp'], 0)).rejects.toMatchObject({ code: 'invalid_cap' });
    await expect(
      createAppPassword(db, OPERATOR, { accountId: '00000000-0000-0000-0000-000000000000', label: 'x', scopes: ['smtp'] }, { pepper: PEPPER }),
    ).rejects.toMatchObject({ code: 'account_not_found' });
  });

  it.each(APP_PASSWORD_SCOPES)('authenticates for its own scope: %s', async (scope) => {
    const acct = await makeAccount(db);
    const { password, appPassword } = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: scope, scopes: [scope] }, { pepper: PEPPER });
    const result = await login(acct.address, password, scope);
    expect(result).toEqual({ ok: true, accountId: acct.id, appPasswordId: appPassword.id, addresses: [acct.address] });
    const row = await db.appPassword.findUniqueOrThrow({ where: { id: appPassword.id } });
    expect(row.lastUsedAt).not.toBeNull();
    expect(row.lastUsedIp).toBe('192.0.2.7');
    // Last-used is not an audited mutation.
    expect(await db.auditEvent.count({ where: { entityId: appPassword.id } })).toBe(1);
  });

  it('accepts the username in any case and the password however it is typed', async () => {
    const acct = await makeAccount(db);
    const { password } = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'x', scopes: ['imap'] }, { pepper: PEPPER });
    expect((await login(acct.address.toUpperCase(), password.toUpperCase().replaceAll('-', ' '), 'imap')).ok).toBe(true);
    expect((await login(acct.address, password.replaceAll('-', ''), 'imap')).ok).toBe(true);
  });

  it('logs a service account in by its service address', async () => {
    const svc = await makeAccount(db, { kind: 'service', addressKind: 'service' });
    const { password } = await createAppPassword(db, OPERATOR, { accountId: svc.id, label: 'foreman', scopes: ['smtp'], dailyRecipientCap: 50 }, { pepper: PEPPER });
    expect(await login(svc.address, password)).toMatchObject({ ok: true, accountId: svc.id });
  });

  it('refuses the wrong scope, a wrong password, an unknown user and another account’s password', async () => {
    const a = await makeAccount(db);
    const b = await makeAccount(db);
    const { password } = await createAppPassword(db, OPERATOR, { accountId: a.id, label: 'x', scopes: ['imap'] }, { pepper: PEPPER });
    expect(await login(a.address, password, 'smtp')).toEqual({ ok: false, reason: 'wrong_scope' });
    expect(await login(a.address, password, 'dav')).toEqual({ ok: false, reason: 'wrong_scope' });
    // Same prefix, different secret.
    const tampered = password.slice(0, -1) + (password.endsWith('a') ? 'b' : 'a');
    expect(await login(a.address, tampered, 'imap')).toEqual({ ok: false, reason: 'bad_password' });
    expect(await login(a.address, generateAppPassword().display, 'imap')).toEqual({ ok: false, reason: 'bad_password' });
    expect(await login('nobody@d3cloud.io', password, 'imap')).toEqual({ ok: false, reason: 'unknown_user' });
    expect(await login('not-an-address', password, 'imap')).toEqual({ ok: false, reason: 'unknown_user' });
    expect(await login(a.address.replace('@d3cloud.io', '@example.com'), password, 'imap')).toEqual({ ok: false, reason: 'unknown_user' });
    // A's password presented under B's username.
    expect(await login(b.address, password, 'imap')).toEqual({ ok: false, reason: 'bad_password' });
  });

  it('never accepts the account’s web password (PST-REQ-027)', async () => {
    const acct = await makeAccount(db);
    await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'x', scopes: [...APP_PASSWORD_SCOPES] }, { pepper: PEPPER });
    // The web password really is this account's password…
    const account = await db.account.findUniqueOrThrow({ where: { id: acct.id } });
    expect(await argon2.verify(account.passwordHash ?? '', acct.webPassword, { secret: Buffer.from(PEPPER, 'utf8') })).toBe(true);
    // …and no protocol scope accepts it.
    for (const scope of APP_PASSWORD_SCOPES) {
      expect(await login(acct.address, acct.webPassword, scope)).toEqual({ ok: false, reason: 'bad_password' });
    }

    // Even a web password shaped exactly like an app password, sharing a live prefix.
    const shaped = await makeAccount(db, { webPassword: groupForDisplay(generateAppPassword().normalized) });
    const live = await createAppPassword(db, OPERATOR, { accountId: shaped.id, label: 'x', scopes: ['smtp'] }, { pepper: PEPPER });
    const samePrefix = `${live.appPassword.prefix}${shaped.webPassword.replaceAll('-', '').slice(8)}`;
    await db.account.update({
      where: { id: shaped.id },
      data: { passwordHash: await argon2.hash(samePrefix, { type: argon2.argon2id, secret: Buffer.from(PEPPER, 'utf8') }) },
    });
    expect(await login(shaped.address, shaped.webPassword)).toEqual({ ok: false, reason: 'bad_password' });
    expect(await login(shaped.address, samePrefix)).toEqual({ ok: false, reason: 'bad_password' });
    expect((await login(shaped.address, live.password)).ok).toBe(true);
  });

  it('refuses a disabled account and a frozen password for smtp only', async () => {
    const acct = await makeAccount(db);
    const { password, appPassword } = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'x', scopes: ['smtp', 'imap'] }, { pepper: PEPPER });
    await db.appPassword.update({ where: { id: appPassword.id }, data: { frozenAt: new Date() } });
    expect(await login(acct.address, password, 'smtp')).toEqual({ ok: false, reason: 'frozen' });
    expect((await login(acct.address, password, 'imap')).ok).toBe(true);
    await db.account.update({ where: { id: acct.id }, data: { disabledAt: new Date() } });
    expect(await login(acct.address, password, 'imap')).toEqual({ ok: false, reason: 'account_disabled' });
    await expect(
      createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'x', scopes: ['smtp'] }, { pepper: PEPPER }),
    ).rejects.toMatchObject({ code: 'account_disabled' });
  });

  it('revokes immediately: the very next verify fails, and revocation is audited once', async () => {
    const acct = await makeAccount(db);
    const other = await makeAccount(db);
    const { password, appPassword } = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'x', scopes: ['smtp'] }, { pepper: PEPPER });
    expect((await login(acct.address, password)).ok).toBe(true);

    // Not someone else's to revoke.
    expect(await revokeAppPassword(db, OPERATOR, { id: appPassword.id, accountId: other.id })).toBeNull();
    expect((await login(acct.address, password)).ok).toBe(true);

    const revoked = await revokeAppPassword(db, OPERATOR, { id: appPassword.id, accountId: acct.id });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);
    expect(await login(acct.address, password)).toEqual({ ok: false, reason: 'revoked' });
    expect(await revokeAppPassword(db, OPERATOR, { id: appPassword.id })).toBeNull();
    expect(await db.auditEvent.count({ where: { action: 'app_password.revoke', entityId: appPassword.id } })).toBe(1);
    expect(await listAppPasswords(db, acct.id)).toEqual([]);
    expect((await listAppPasswords(db, acct.id, { includeRevoked: true })).map((p) => p.id)).toEqual([appPassword.id]);
  });

  it('runs exactly one Argon2 verify on every path, hits and misses alike', async () => {
    const acct = await makeAccount(db);
    const { password } = await createAppPassword(db, OPERATOR, { accountId: acct.id, label: 'x', scopes: ['smtp'] }, { pepper: PEPPER });
    // Warm the decoy so its one-off hash() is not in the count.
    await login('nobody@d3cloud.io', password);
    const spy = vi.spyOn(argon2, 'verify');
    const cases: [string, string][] = [
      [acct.address, password],
      [acct.address, generateAppPassword().display],
      ['nobody@d3cloud.io', password],
      [acct.address, 'not an app password at all'],
      ['garbage', ''],
    ];
    for (const [username, pw] of cases) {
      spy.mockClear();
      await login(username, pw);
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });
});
