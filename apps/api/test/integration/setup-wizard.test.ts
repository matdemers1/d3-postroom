// PST-T-4.8, the setup wizard over HTTP (PST-REQ-098): admin only, every step behind a fresh
// step-up and audited, in order, persisted (resumable) — domain → DKIM keys → the live DNS check →
// mailbox → a test sent through the composer's submission path → its delivery timeline → done.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { missingAuditCount, waitForAuditGuard } from '@postroom/audit';
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
import { WizardView } from '../../src/setup-wizard/schemas.js';
import { TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

describe.skipIf(!baseUrl)('setup wizard (PST-T-4.8, PST-REQ-098)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let blobRoot = '';
  const clock = new TestClock();
  let admin = { cookie: '', secret: '', login: '' };
  let user = '';
  let guardMissesBefore = 0;

  const signIn = async (isAdmin: boolean): Promise<{ cookie: string; secret: string; login: string }> => {
    const login = randomLogin();
    const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin });
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(totpSecret, clock.now()) });
    expect(second.status).toBe(200);
    return { cookie: cookieHeader(cookiesOf(second)), secret: totpSecret, login };
  };

  const stepUp = async (): Promise<void> => {
    clock.advance(31_000);
    const res = await request(app).post('/api/auth/step-up').set(CSRF).set('cookie', admin.cookie).send({ code: totpCode(admin.secret, clock.now()) });
    expect(res.status).toBe(200);
  };

  const post = (path: string, body: object = {}) => request(app).post(`/api/admin/setup-wizard${path}`).set(CSRF).set('cookie', admin.cookie).send(body);
  const view = async () => WizardView.parse((await request(app).get('/api/admin/setup-wizard').set('cookie', admin.cookie)).body);

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t48_wizard');
    db = testDb.db;
    blobRoot = await mkdtemp(join(tmpdir(), 'pst-t48-'));
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    const deps: ApiDeps = { db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot }, config: baseConfig(clock) };
    app = createApp(deps);
    // The DNS step reads the live check; here the "internet" has nothing published yet.
    setDnsResolver(deps, fakeResolver({ records: {} }));
    admin = await signIn(true);
    user = (await signIn(false)).cookie;
    guardMissesBefore = missingAuditCount.value;
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
    await rm(blobRoot, { recursive: true, force: true });
  });

  it('is admin only, and starts at the domain step', async () => {
    expect((await request(app).get('/api/admin/setup-wizard')).status).toBe(401);
    expect((await request(app).get('/api/admin/setup-wizard').set('cookie', user)).status).toBe(403);
    expect((await request(app).post('/api/admin/setup-wizard/domain').set(CSRF).set('cookie', user).send({ domain: 'd3cloud.io' })).status).toBe(403);
    const v = await view();
    expect(v).toMatchObject({ step: 'domain', completed: false, domain: null, suggestedDomain: 'd3cloud.io', dkim: [], test: null });
  });

  it('every step needs a fresh step-up, and steps cannot be skipped', async () => {
    const refused = await post('/domain', { domain: 'd3cloud.io' });
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: 'step_up_required' });
    await stepUp();
    const skipped = await post('/dkim');
    expect(skipped.status).toBe(409);
    expect(skipped.body).toMatchObject({ error: 'step_not_reached' });
  });

  it('refuses the no-reply subdomain and demers.dev', async () => {
    expect((await post('/domain', { domain: 'no-reply.d3cloud.io' })).body).toMatchObject({ error: 'forbidden_domain' });
    expect((await post('/domain', { domain: 'demers.dev' })).body).toMatchObject({ error: 'out_of_scope' });
    expect(await db.domain.count({ where: { name: { in: ['no-reply.d3cloud.io', 'demers.dev'] } } })).toBe(0);
  });

  it('walks domain → DKIM → DNS → mailbox → test → done, persisted and audited', async () => {
    const domain = await post('/domain', { domain: 'D3Cloud.io' });
    expect(domain.status).toBe(200);
    expect(WizardView.parse(domain.body)).toMatchObject({ step: 'dkim', domain: 'd3cloud.io' });

    const dkim = await post('/dkim');
    expect(dkim.status).toBe(200);
    const keys = WizardView.parse(dkim.body).dkim;
    expect(keys.map((k) => k.algorithm).sort()).toEqual(['ed25519-sha256', 'rsa-sha256']);
    for (const k of keys) {
      expect(k.dnsName).toBe(`${k.selector}._domainkey.d3cloud.io`);
      expect(k.dnsRecord).toMatch(/^v=DKIM1; k=(ed25519|rsa); p=/);
    }
    // Idempotent: a second press keeps the same keys.
    expect(WizardView.parse((await post('/dkim')).body).dkim.map((k) => k.selector).sort()).toEqual(keys.map((k) => k.selector).sort());

    // The DNS step's live check sees every new selector — and, with nothing published, no pass.
    const report = DnsReport.parse((await request(app).get('/api/admin/dns').set('cookie', admin.cookie)).body);
    expect(report.rows.filter((r) => r.record === 'DKIM').map((r) => r.name).sort()).toEqual(keys.map((k) => k.dnsName).sort());
    expect(report.rows.every((r) => r.status !== 'pass')).toBe(true);
    const dns = await post('/dns');
    expect(WizardView.parse(dns.body)).toMatchObject({ step: 'mailbox' });
    expect(WizardView.parse(dns.body).dnsAcknowledgedAt).not.toBeNull();

    // A mailbox that belongs to someone else is refused; a new one of the operator's is created.
    const taken = await db.address.findFirstOrThrow({ where: { account: { isAdmin: false } } });
    expect((await post('/mailbox', { localPart: taken.localPart })).status).toBe(409);
    const mailbox = await post('/mailbox', { localPart: 'postmaster' });
    expect(mailbox.status).toBe(200);
    const mv = WizardView.parse(mailbox.body);
    expect(mv).toMatchObject({ step: 'test', mailbox: 'postmaster@d3cloud.io' });
    expect(mv.addresses).toContain('postmaster@d3cloud.io');

    // Resumable: a fresh GET (another device) sees the same place.
    expect(await view()).toMatchObject({ step: 'test', mailbox: 'postmaster@d3cloud.io', completed: false });

    // Finishing before a test is sent is refused.
    expect((await post('/complete')).body).toMatchObject({ error: 'step_not_reached' });

    // The test goes through the composer, i.e. the submission path; the wizard records it.
    const sent = await request(app)
      .post('/api/compose/send')
      .set(CSRF)
      .set('cookie', admin.cookie)
      .send({ from: 'postmaster@d3cloud.io', to: ['someone@example.net'], subject: 'Postroom test', text: 'Hello from the setup wizard.' });
    expect(sent.status).toBe(201);
    const { outboundId } = sent.body as { outboundId: string };
    expect((await post('/test', { outboundId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    const test = await post('/test', { outboundId });
    expect(test.status).toBe(200);
    expect(WizardView.parse(test.body).test).toMatchObject({ outboundId, to: ['someone@example.net'] });

    // Its timeline is the delivery-attempts API: queued, signed, waiting for the delivery daemon.
    const timeline = await request(app).get(`/api/messages/${outboundId}/delivery`).set('cookie', admin.cookie);
    expect(timeline.status).toBe(200);
    expect(timeline.body).toMatchObject({ recipients: [{ address: 'someone@example.net', state: 'queued' }] });

    const done = await post('/complete');
    expect(done.status).toBe(200);
    expect(WizardView.parse(done.body)).toMatchObject({ step: 'done', completed: true });
    expect(await view()).toMatchObject({ step: 'done', completed: true });

    const actions = (await db.auditEvent.findMany({ where: { action: { startsWith: 'setup_wizard.' } }, orderBy: { at: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['setup_wizard.domain', 'setup_wizard.dkim', 'setup_wizard.dns', 'setup_wizard.mailbox', 'setup_wizard.test', 'setup_wizard.complete']));
    await waitForAuditGuard();
    expect(missingAuditCount.value).toBe(guardMissesBefore);
  });

  it('the e2e-only fake-delivery stub records one delivered attempt, marked e2e-stub, and only with POSTROOM_E2E_SEED=1', async () => {
    const send = async (target: Express): Promise<string> => {
      const sent = await request(target)
        .post('/api/compose/send')
        .set(CSRF)
        .set('cookie', admin.cookie)
        .send({ from: 'postmaster@d3cloud.io', to: ['stub@example.net'], subject: 'stub', text: 'x' });
      expect(sent.status).toBe(201);
      return (sent.body as { outboundId: string }).outboundId;
    };
    const outboundId = await send(app);
    expect((await request(app).post('/api/admin/dev/fake-delivery').set(CSRF).set('cookie', admin.cookie).send({ outboundId })).status).toBe(404);
    const devApp = createApp({ db, env: { DATABASE_URL: testDb.url, BLOB_ROOT: blobRoot, POSTROOM_E2E_SEED: '1' }, config: baseConfig(clock) });
    const stub = await request(devApp).post('/api/admin/dev/fake-delivery').set(CSRF).set('cookie', admin.cookie).send({ outboundId });
    expect(stub.status).toBe(200);
    expect(stub.body).toEqual({ delivered: ['stub@example.net'] });
    const timeline = await request(app).get(`/api/messages/${outboundId}/delivery`).set('cookie', admin.cookie);
    expect(timeline.body).toMatchObject({ recipients: [{ state: 'delivered', attemptsLog: [{ transport: 'e2e-stub', outcome: 'delivered', remote: { code: 250 } }] }] });
    // Nothing left to stub the second time.
    expect((await request(devApp).post('/api/admin/dev/fake-delivery').set(CSRF).set('cookie', admin.cookie).send({ outboundId })).body).toEqual({ delivered: [] });
  });

  it('choosing a different domain starts the later steps over', async () => {
    await stepUp();
    const changed = await post('/domain', { domain: 'example-two.test' });
    expect(changed.status).toBe(200);
    expect(WizardView.parse(changed.body)).toMatchObject({ step: 'dkim', domain: 'example-two.test', mailbox: null, test: null, completed: false });
  });
});
