// PST-T-4.8, the DNS checker over HTTP (PST-REQ-099): admin only; expected vs live with pass/fail
// for every record kind, through an injected fake resolver; a deliberately wrong SPF shows fail
// with its reason; no-reply subdomains and foreign domains are refused.
import { dnsRecordFor, generateDkimKeys } from '@postroom/auth-checks';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDnsResolver } from '../../src/admin-dns/index.js';
import { fakeResolver, type FakeZone } from '../../src/admin-dns/fake-resolver.js';
import { DnsReport } from '../../src/admin-dns/schemas.js';
import { createApp } from '../../src/app.js';
import type { ApiDeps } from '../../src/deps.js';
import { TestClock, baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';
const EDGE = '203.0.113.7';

describe.skipIf(!baseUrl)('admin DNS checker (PST-T-4.8, PST-REQ-099)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let deps: ApiDeps;
  const clock = new TestClock();
  let admin = '';
  let user = '';
  const zone: FakeZone = { records: {} };

  const signIn = async (isAdmin: boolean): Promise<string> => {
    const login = randomLogin();
    const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin });
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(totpSecret, clock.now()) });
    expect(second.status).toBe(200);
    return cookieHeader(cookiesOf(second));
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t48_dns');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    deps = { db, env: { EDGE_PUBLIC_IP: EDGE, MX_HOSTNAME: 'mail.d3cloud.io' }, config: baseConfig(clock, { webOrigin: 'https://mail.d3cloud.io' }) };
    app = createApp(deps);
    setDnsResolver(deps, fakeResolver(zone), 'fake:53');
    admin = await signIn(true);
    user = await signIn(false);

    // One DKIM key in the table, published correctly; everything else as a real zone would be.
    const domain = await db.domain.findUniqueOrThrow({ where: { name: 'd3cloud.io' } });
    const keys = generateDkimKeys();
    const record = dnsRecordFor('ed25519-sha256', keys.ed25519.publicKey);
    await db.dkimKey.create({ data: { domainId: domain.id, selector: 'pr20260926e', algorithm: 'ed25519_sha256', dnsRecord: record, sealedPrivate: new Uint8Array(1), kekId: 'k' } });
    Object.assign(zone.records, {
      'd3cloud.io': [{ type: 'TXT', value: 'v=spf1 ip4:198.51.100.9 -all' }],
      'mail.d3cloud.io': [{ type: 'A', value: EDGE }],
      'pr20260926e._domainkey.d3cloud.io': [{ type: 'TXT', value: record }],
      '_dmarc.d3cloud.io': [{ type: 'TXT', value: 'v=DMARC1; p=none; rua=mailto:dmarc-reports@d3cloud.io' }],
      [EDGE]: [{ type: 'PTR', value: 'mail.d3cloud.io' }],
      '_smtp._tls.d3cloud.io': [{ type: 'TXT', value: 'v=TLSRPTv1; rua=mailto:tls-reports@d3cloud.io' }],
      '_caldavs._tcp.d3cloud.io': [{ type: 'SRV', priority: 0, weight: 1, port: 443, target: 'mail.d3cloud.io' }],
      '_carddavs._tcp.d3cloud.io': [{ type: 'SRV', priority: 0, weight: 1, port: 443, target: 'mail.d3cloud.io' }],
      'autoconfig.d3cloud.io': [{ type: 'CNAME', value: 'mail.d3cloud.io' }],
      'autodiscover.d3cloud.io': [{ type: 'CNAME', value: 'mail.d3cloud.io' }],
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  it('is admin only', async () => {
    expect((await request(app).get('/api/admin/dns')).status).toBe(401);
    expect((await request(app).get('/api/admin/dns').set('cookie', user)).status).toBe(403);
  });

  it('shows expected vs live with a verdict per record; the deliberately wrong SPF fails with its reason', async () => {
    const res = await request(app).get('/api/admin/dns').set('cookie', admin);
    expect(res.status).toBe(200);
    const report = DnsReport.parse(res.body);
    expect(report.domain).toBe('d3cloud.io');
    expect(report.resolver).toBe('fake:53');
    const status = Object.fromEntries(report.rows.map((r) => [`${r.record} ${r.name}`, r.status]));
    expect(status).toEqual({
      'MX d3cloud.io': 'pending',
      'SPF d3cloud.io': 'fail',
      'DKIM pr20260926e._domainkey.d3cloud.io': 'pass',
      'DMARC _dmarc.d3cloud.io': 'pass',
      'PTR 7.113.0.203.in-addr.arpa': 'pass',
      'MTA-STS _mta-sts.d3cloud.io': 'pending',
      'MTA-STS host mta-sts.d3cloud.io': 'pending',
      'TLS-RPT _smtp._tls.d3cloud.io': 'pass',
      'SRV _submissions._tcp.d3cloud.io': 'pending',
      'SRV _imaps._tcp.d3cloud.io': 'pending',
      'SRV _caldavs._tcp.d3cloud.io': 'pass',
      'SRV _carddavs._tcp.d3cloud.io': 'pass',
      'autoconfig autoconfig.d3cloud.io': 'pass',
      'autodiscover autodiscover.d3cloud.io': 'pass',
    });
    const spf = report.rows.find((r) => r.record === 'SPF');
    expect(spf?.expected).toBe(`v=spf1 ip4:${EDGE} -all`);
    expect(spf?.live).toEqual(['v=spf1 ip4:198.51.100.9 -all']);
    expect(spf?.reason).toMatch(/fail .*not authorised/);
    expect(report.summary).toMatchObject({ fail: 1, pass: 8, pending: 5 });
  });

  it('fixing the SPF record turns it green on re-check', async () => {
    zone.records['d3cloud.io'] = [{ type: 'TXT', value: `v=spf1 ip4:${EDGE} -all` }];
    const report = DnsReport.parse((await request(app).get('/api/admin/dns').set('cookie', admin)).body);
    expect(report.rows.find((r) => r.record === 'SPF')?.status).toBe('pass');
  });

  it('refuses no-reply subdomains and domains Postroom does not serve', async () => {
    const noReply = await request(app).get('/api/admin/dns?domain=no-reply.d3cloud.io').set('cookie', admin);
    expect(noReply.status).toBe(400);
    expect(noReply.body).toMatchObject({ error: 'forbidden_domain' });
    const foreign = await request(app).get('/api/admin/dns?domain=demers.dev').set('cookie', admin);
    expect(foreign.status).toBe(404);
  });
});
