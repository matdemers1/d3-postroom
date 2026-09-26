// PST-T-10.3 / PST-REQ-153: the web app's "revoke" button leaves nothing to catch — a revoked
// app password fails on the very next protocol login, over a real IMAP connection, and last-used
// is recorded on the login that preceded it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extraAppPassword, hasOpenssl, makeAccount, revoke, startHarness, type Harness } from './harness.js';
import { ImapClient } from './client.js';

const baseUrl = process.env['DATABASE_URL'];
const canRun = baseUrl !== undefined && (await hasOpenssl());

describe.skipIf(!canRun)('app password revocation over IMAP (PST-T-10.3)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness('pst_t103_imap');
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  async function overStartTls(): Promise<ImapClient> {
    const c = await ImapClient.plain(h.port);
    await c.next(); // greeting
    expect((await c.startTls()).tagged).toMatch(/OK Begin TLS/);
    return c;
  }

  it('logs in, records last-used, then fails immediately once revoked', async () => {
    const account = await makeAccount(h, ['imap']);
    const extra = await extraAppPassword(h, account, ['imap']);

    const before = await h.db.appPassword.findUniqueOrThrow({ where: { id: extra.id } });
    expect(before.lastUsedAt).toBeNull();
    expect(before.lastUsedIp).toBeNull();

    // A successful login records last-used time and address.
    const c1 = await overStartTls();
    expect((await c1.command(`LOGIN ${account.address} ${extra.password}`, 'A1')).tagged).toMatch(/^A1 OK/);
    expect((await c1.command('LOGOUT', 'A2')).tagged).toBe('A2 OK LOGOUT completed');
    c1.close();

    const afterLogin = await h.db.appPassword.findUniqueOrThrow({ where: { id: extra.id } });
    expect(afterLogin.lastUsedAt).not.toBeNull();
    expect(afterLogin.lastUsedIp).toBe('127.0.0.1');

    // Revoke it (the API's DELETE calls the same credentials function under a step-up session).
    await revoke(h, extra.id);

    // The very next login attempt fails — nothing is cached anywhere in the path.
    const c2 = await overStartTls();
    expect((await c2.command(`LOGIN ${account.address} ${extra.password}`, 'B1')).tagged).toBe(
      'B1 NO [AUTHENTICATIONFAILED] Authentication failed',
    );
    c2.close();

    const afterRevoke = await h.db.appPassword.findUniqueOrThrow({ where: { id: extra.id } });
    expect(afterRevoke.revokedAt).not.toBeNull();
    // The failed attempt did not touch last-used again (it never got past the revoked check).
    expect(afterRevoke.lastUsedAt).toEqual(afterLogin.lastUsedAt);
  });
});
