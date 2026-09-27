// PST-T-4.12, PST-REQ-094: the MTA-STS policy route against a real database, and its linkage to
// the admin DNS checker's expected _mta-sts TXT id.
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dnsReport } from '../../src/admin-dns/index.js';
import { createApp } from '../../src/app.js';
import type { ApiDeps } from '../../src/deps.js';
import { mtaStsPolicyId } from '../../src/mta-sts/policy.js';
import { request } from '../loopback.js';
import { TestClock, baseConfig } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(!baseUrl)('MTA-STS policy against the domain table (PST-T-4.12, PST-REQ-094)', () => {
  let testDb: TestDatabase;
  let db: Db;
  let app: Express;
  let deps: ApiDeps;
  const clock = new TestClock();

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t412_mtasts');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    deps = { db, env: {}, config: baseConfig(clock, { webOrigin: 'https://mail.d3cloud.io' }) };
    app = createApp(deps);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it('serves the default policy for a domain in the table', async () => {
    const res = await request(app).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.d3cloud.io');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['location']).toBeUndefined();
    expect(res.text).toBe('version: STSv1\nmode: testing\nmx: mx.d3cloud.io\nmax_age: 86400\n');
  });

  it('404s for a Host naming a domain Postroom does not serve', async () => {
    const res = await request(app).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.example.org');
    expect(res.status).toBe(404);
  });

  it('404s for any other Host at the same path', async () => {
    const res = await request(app).get('/.well-known/mta-sts.txt').set('Host', 'd3cloud.io');
    expect(res.status).toBe(404);
  });

  it("the admin DNS checker's expected _mta-sts id matches the id the route actually serves", async () => {
    const served = await request(app).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.d3cloud.io');
    const report = await dnsReport(deps, 'd3cloud.io', clock.now());
    const row = report.rows.find((r) => r.record === 'MTA-STS');
    expect(row?.expected).toBe(`v=STSv1; id=${mtaStsPolicyId(served.text)}`);
  });

  it('the expected id changes when MTA_STS_MODE changes, and so does the served policy', async () => {
    const before = await dnsReport(deps, 'd3cloud.io', clock.now());
    deps.env['MTA_STS_MODE'] = 'enforce';
    const after = await dnsReport(deps, 'd3cloud.io', clock.now());
    expect(after.rows.find((r) => r.record === 'MTA-STS')?.expected).not.toBe(before.rows.find((r) => r.record === 'MTA-STS')?.expected);
    const served = await request(app).get('/.well-known/mta-sts.txt').set('Host', 'mta-sts.d3cloud.io');
    expect(served.text).toContain('mode: enforce');
    expect(after.rows.find((r) => r.record === 'MTA-STS')?.expected).toBe(`v=STSv1; id=${mtaStsPolicyId(served.text)}`);
    delete deps.env['MTA_STS_MODE'];
  });
});
