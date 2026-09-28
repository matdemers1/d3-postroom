// PST-T-4.15, PST-REQ-186 against a real database: the reconciler gives every served domain
// postmaster@ and abuse@ (aliases to the first admin) and the DMARC / TLS-RPT report mailboxes
// (service mailboxes), idempotently, one audited transaction per creation, never touching an
// address that already exists; and the admin DNS checker fails a row for each one that is missing.
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDnsResolver } from '../../src/admin-dns/index.js';
import { fakeResolver } from '../../src/admin-dns/fake-resolver.js';
import { DnsReport } from '../../src/admin-dns/schemas.js';
import { createApp } from '../../src/app.js';
import type { ApiDeps } from '../../src/deps.js';
import { reconcileAtStart, reconcileRoleAddresses } from '../../src/role-addresses/index.js';
import { TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!baseUrl)('role addresses (PST-T-4.15, PST-REQ-186)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  const clock = new TestClock();
  let operatorId = '';
  let admin = '';
  let otherId = '';

  const rowsOf = async (domain = 'd3cloud.io'): Promise<Record<string, { status: string; reason: string; live: string[] }>> => {
    const res = await request(app).get(`/api/admin/dns?domain=${domain}`).set('cookie', admin);
    expect(res.status).toBe(200);
    const report = DnsReport.parse(res.body);
    return Object.fromEntries(report.rows.filter((r) => r.type === 'RCPT').map((r) => [`${r.record} ${r.name}`, { status: r.status, reason: r.reason, live: r.live }]));
  };

  const addressOf = (localPart: string, domain = 'd3cloud.io') =>
    db.address.findFirst({ where: { localPart, domain: { name: domain } }, include: { targets: true, account: true } });

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t415_roles');
    db = testDb.db;
    // A fresh install: the seed's primary domain and its (earliest) admin operator.
    operatorId = (await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' })).operatorId;
    await db.domain.create({ data: { name: 'second.test' } });
    const deps: ApiDeps = { db, env: {}, config: baseConfig(clock) };
    app = createApp(deps);
    setDnsResolver(deps, fakeResolver({ records: {} }), 'fake:53');
    const login = randomLogin();
    const { totpSecret, id } = await createAccount(db, { login, password: PASSWORD, isAdmin: true });
    otherId = id;
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(totpSecret, clock.now()) });
    expect(second.status).toBe(200);
    admin = cookieHeader(cookiesOf(second));
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('the DNS checker fails a row for each missing role address and report mailbox', async () => {
    const rows = await rowsOf();
    expect(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.status]))).toEqual({
      'Role address postmaster@d3cloud.io': 'fail',
      'Role address abuse@d3cloud.io': 'fail',
      'Report mailbox dmarc-reports@d3cloud.io': 'fail',
      'Report mailbox tls-reports@d3cloud.io': 'fail',
    });
    expect(rows['Role address postmaster@d3cloud.io']?.reason).toMatch(/does not exist/);
  });

  it('leaves an existing address alone, even one that is not what it would have made', async () => {
    // abuse@second.test already exists as someone else's primary address.
    const second = await db.domain.findUniqueOrThrow({ where: { name: 'second.test' } });
    await db.address.create({ data: { localPart: 'abuse', domainId: second.id, kind: 'primary', accountId: otherId } });
  });

  it('creates postmaster@ and abuse@ as aliases to the first admin, and the report mailboxes as service mailboxes, on every domain', async () => {
    const auditBefore = await db.auditEvent.count();
    const result = await reconcileRoleAddresses(db, {});
    expect(result.created.sort()).toEqual(
      [
        'postmaster@d3cloud.io',
        'abuse@d3cloud.io',
        'dmarc-reports@d3cloud.io',
        'tls-reports@d3cloud.io',
        'postmaster@second.test',
        'dmarc-reports@second.test',
        'tls-reports@second.test',
      ].sort(),
    );
    expect(result.skipped).toEqual([{ address: 'abuse@second.test', reason: 'exists' }]);

    for (const [local, domain] of [['postmaster', 'd3cloud.io'], ['abuse', 'd3cloud.io'], ['postmaster', 'second.test']] as const) {
      const row = await addressOf(local, domain);
      expect(row).toMatchObject({ kind: 'alias', accountId: null, killedAt: null });
      // The seeded operator, the earliest admin — not the admin created after it.
      expect(row?.targets.map((t) => t.accountId)).toEqual([operatorId]);
    }
    for (const [local, name] of [['dmarc-reports', 'DMARC reports'], ['tls-reports', 'TLS reports']] as const) {
      const row = await addressOf(local);
      expect(row).toMatchObject({ kind: 'service', killedAt: null, account: { kind: 'service', isAdmin: false, displayName: name, passwordHash: null } });
      const boxes = await db.mailbox.findMany({ where: { accountId: row?.accountId ?? '' }, select: { name: true } });
      expect(boxes.map((b) => b.name)).toContain('INBOX');
    }
    // Untouched.
    expect(await addressOf('abuse', 'second.test')).toMatchObject({ kind: 'primary', accountId: otherId });

    // One audit row per creation, by the system, in the same transaction.
    const audits = await db.auditEvent.findMany({ where: { action: { startsWith: 'role_address.' } }, orderBy: { at: 'asc' } });
    expect(audits).toHaveLength(7);
    expect(await db.auditEvent.count()).toBe(auditBefore + 7);
    expect(audits.every((a) => a.actorKind === 'system' && a.actorAccountId === null)).toBe(true);
    expect(audits.filter((a) => a.action === 'role_address.alias.create')).toHaveLength(3);
    expect(audits.filter((a) => a.action === 'role_address.service_mailbox.create')).toHaveLength(4);
  });

  it('is idempotent: a second run (the next api start) creates nothing and audits nothing', async () => {
    const auditBefore = await db.auditEvent.count();
    const addressesBefore = await db.address.count();
    const [a, b] = await Promise.all([reconcileRoleAddresses(db, {}), reconcileRoleAddresses(db, {})]);
    expect(a.created).toEqual([]);
    expect(b.created).toEqual([]);
    expect(await db.address.count()).toBe(addressesBefore);
    expect(await db.auditEvent.count()).toBe(auditBefore);
  });

  it('the DNS checker now passes every row, naming who receives it', async () => {
    const rows = await rowsOf();
    expect(Object.values(rows).map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(rows['Role address postmaster@d3cloud.io']?.reason).toBe('Delivers to Operator.');
    expect(rows['Role address postmaster@d3cloud.io']?.live).toEqual(['alias → Operator']);
    expect(rows['Report mailbox dmarc-reports@d3cloud.io']?.reason).toBe('Delivers to DMARC reports.');
    // An existing address that delivers is a pass; the reason shows where it goes.
    expect((await rowsOf('second.test'))['Role address abuse@second.test']).toMatchObject({ status: 'pass', live: ['primary → ' + (await db.account.findUniqueOrThrow({ where: { id: otherId } })).displayName] });
  });

  it('a killed role address, or one delivering to no enabled account, fails its row', async () => {
    const abuse = await addressOf('abuse');
    await db.address.update({ where: { id: abuse?.id ?? '' }, data: { killedAt: new Date() } });
    const disabledAt = new Date();
    await db.account.update({ where: { id: operatorId }, data: { disabledAt } });
    const rows = await rowsOf();
    expect(rows['Role address abuse@d3cloud.io']?.status).toBe('fail');
    expect(rows['Role address abuse@d3cloud.io']?.reason).toMatch(/killed/);
    expect(rows['Role address postmaster@d3cloud.io']?.status).toBe('fail');
    expect(rows['Role address postmaster@d3cloud.io']?.reason).toMatch(/no enabled account/);
    // And the reconciler still never touches them.
    expect((await reconcileRoleAddresses(db, {})).created).toEqual([]);
    expect((await addressOf('abuse'))?.killedAt).toBeInstanceOf(Date);
    await db.account.update({ where: { id: operatorId }, data: { disabledAt: null } });
  });

  it('REPORTS_MAILBOX / TLSRPT_MAILBOX override the report mailboxes; one at a domain Postroom does not serve is left alone', async () => {
    const result = await reconcileRoleAddresses(db, { REPORTS_MAILBOX: 'rua@d3cloud.io', TLSRPT_MAILBOX: 'tls@elsewhere.example' });
    expect(result.created).toEqual(['rua@d3cloud.io']);
    expect(result.skipped).toContainEqual({ address: 'tls@elsewhere.example', reason: 'not_served' });
    expect(await addressOf('rua')).toMatchObject({ kind: 'service' });
  });

  it('at api start it is best effort: a failure is logged, never thrown', async () => {
    const logs: { event: string; fields?: Record<string, unknown> }[] = [];
    const broken = { domain: { findMany: () => Promise.reject(new Error('database is down')) } } as unknown as Db;
    await expect(reconcileAtStart(broken, {}, (event, fields) => logs.push({ event, ...(fields === undefined ? {} : { fields }) }))).resolves.toBeUndefined();
    expect(logs).toEqual([{ event: 'role_addresses.failed', fields: { error: 'database is down' } }]);
    await reconcileAtStart(db, {}, (event, fields) => logs.push({ event, ...(fields === undefined ? {} : { fields }) }));
    expect(logs.at(-1)?.event).toBe('role_addresses.reconciled');
  });

  it('with no admin yet, postmaster@ and abuse@ wait; the report mailboxes do not', async () => {
    const fresh = await createTestDatabase(baseUrl ?? '', 'pst_t415_noadmin');
    try {
      await fresh.db.domain.create({ data: { name: 'd3cloud.io', isPrimary: true } });
      const result = await reconcileRoleAddresses(fresh.db, {});
      expect(result.created.sort()).toEqual(['dmarc-reports@d3cloud.io', 'tls-reports@d3cloud.io']);
      expect(result.skipped).toEqual([
        { address: 'postmaster@d3cloud.io', reason: 'no_admin' },
        { address: 'abuse@d3cloud.io', reason: 'no_admin' },
      ]);
    } finally {
      await fresh.drop();
    }
  });
});
