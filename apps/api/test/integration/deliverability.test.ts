// PST-T-7.1 / PST-REQ-122: the Deliverability API aggregates DMARC rows by day, by source and by
// reporting org (pass/fail on DMARC alignment, dispositions) and TLS-RPT rows by policy and failure
// type. The rows are the ones the worker stores for the Google and Microsoft fixtures.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { ProposalResult } from '../../src/deliverability/index.js';
import { reverseNames } from '../../src/deliverability/rdns.js';
import { request } from '../loopback.js';
import { baseConfig, cookieHeader, cookiesOf, createAccount, randomLogin, TestClock, totpCode } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const CSRF = { 'x-postroom-csrf': '1' };
const PASSWORD = 'correct horse battery staple';

interface Body {
  range: { days: number };
  mailboxes: { dmarc: string | null };
  dmarc: {
    totals: { reports: number; messages: number; pass: number; fail: number; dkimPass: number; spfPass: number; dispositions: Record<string, number> };
    byDay: { day: string; pass: number; fail: number }[];
    bySource: { sourceIp: string; reverseDns: string | null; messages: number; pass: number; fail: number; passRate: number; orgs: string[] }[];
    byOrg: { org: string; reports: number; messages: number; pass: number; fail: number }[];
    reports: { org: string; reportId: string }[];
  };
  tlsrpt: {
    totals: { reports: number; successful: number; failed: number };
    byPolicy: { policyDomain: string; policyType: string; successful: number; failed: number }[];
    byFailureType: { resultType: string; sessions: number }[];
  };
}

const rec = (sourceIp: string, count: number, disposition: string, dkim: string, spf: string) => ({
  sourceIp,
  count,
  disposition,
  dkim,
  spf,
  headerFrom: 'd3cloud.io',
  authResults: {},
});

describe.skipIf(!baseUrl)('deliverability (PST-T-7.1, PST-REQ-122)', () => {
  let testDb: TestDatabase;
  let db: Db;
  const clock = new TestClock();
  let app: Express;
  let seedApp: Express;
  let admin = '';
  let user = '';
  let blobRoot = '';

  const person = async (isAdmin: boolean): Promise<string> => {
    const login = randomLogin();
    const { totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin });
    clock.advance(31_000);
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(totpSecret, clock.now()) });
    return cookieHeader(cookiesOf(second));
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t71_api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t71-api-'));
    app = createApp({ db, env: { DELIVERABILITY_RDNS: '0' }, config: baseConfig(clock) });
    seedApp = createApp({ db, env: { DELIVERABILITY_RDNS: '0', POSTROOM_E2E_SEED: '1', BLOB_ROOT: blobRoot }, config: baseConfig(clock) });
    admin = await person(true);
    user = await person(false);

    const day = (d: string): Date => new Date(`${d}T00:00:00Z`);
    const now = clock.now();
    const recent = (offsetDays: number): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offsetDays));
    // The Google fixture, dated two days ago; the Microsoft fixture, yesterday.
    await db.dmarcReport.create({
      data: {
        orgName: 'google.com',
        reportId: '4817259360124789153',
        domain: 'd3cloud.io',
        rangeBegin: recent(2),
        rangeEnd: new Date(recent(1).getTime() - 1000),
        policyPublished: { domain: 'd3cloud.io', p: 'quarantine' },
        records: { create: [rec('203.0.113.25', 42, 'none', 'pass', 'pass'), rec('198.51.100.77', 3, 'quarantine', 'fail', 'fail'), rec('192.0.2.10', 5, 'none', 'pass', 'fail')] },
      },
    });
    await db.dmarcReport.create({
      data: {
        orgName: 'Enterprise Outlook',
        reportId: '7f3c2a9e1b6d4c0e8a5f9d2b3c4e5f60',
        domain: 'd3cloud.io',
        rangeBegin: recent(1),
        rangeEnd: recent(0),
        policyPublished: { domain: 'd3cloud.io', p: 'quarantine' },
        records: { create: [rec('203.0.113.25', 17, 'none', 'pass', 'pass'), rec('2001:db8::25', 2, 'quarantine', 'fail', 'fail')] },
      },
    });
    // Out of range: a year ago.
    await db.dmarcReport.create({
      data: { orgName: 'old.example', reportId: 'x', domain: 'd3cloud.io', rangeBegin: day('2020-01-01'), rangeEnd: day('2020-01-02'), policyPublished: {}, records: { create: [rec('192.0.2.99', 1000, 'reject', 'fail', 'fail')] } },
    });
    // Foreign (PST-T-7.9, PST-REQ-122): a report about example.org, filed to our mailbox by mistake.
    // In range, clean-looking records — it must never move a single aggregate number.
    await db.dmarcReport.create({
      data: {
        orgName: 'reports.example.net',
        reportId: 'foreign-1',
        domain: 'example.org',
        status: 'foreign',
        reason: 'policy_published domain "example.org" is not one of our domains',
        rangeBegin: recent(1),
        rangeEnd: recent(0),
        policyPublished: { domain: 'example.org', p: 'none' },
        records: { create: [{ ...rec('203.0.113.9', 999, 'none', 'pass', 'pass'), headerFrom: 'example.org' }] },
      },
    });
    await db.tlsRptReport.create({
      data: {
        orgName: 'Google Inc.',
        reportId: '2026-09-24T00:00:00Z_d3cloud.io',
        rangeBegin: recent(2),
        rangeEnd: recent(1),
        policies: {
          create: [
            { policyType: 'sts', policyDomain: 'd3cloud.io', mxHost: ['mx.d3cloud.io'], successCount: 58, failureCount: 2, failures: { create: [{ resultType: 'certificate-expired', failedSessionCount: 2, sendingMtaIp: '198.51.100.40' }] } },
            { policyType: 'no-policy-found', policyDomain: 'lists.d3cloud.io', successCount: 4, failureCount: 0 },
          ],
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('is admin only', async () => {
    expect((await request(app).get('/api/admin/deliverability')).status).toBe(401);
    expect((await request(app).get('/api/admin/deliverability').set('cookie', user)).status).toBe(403);
  });

  it('aggregates DMARC pass/fail and dispositions over the range', async () => {
    const res = await request(app).get('/api/admin/deliverability').set('cookie', admin);
    expect(res.status).toBe(200);
    const body = res.body as Body;
    expect(body.range.days).toBe(30);
    expect(body.mailboxes.dmarc).toBe('dmarc@d3cloud.io');
    expect(body.dmarc.totals).toEqual({ reports: 2, messages: 69, pass: 64, fail: 5, dkimPass: 64, spfPass: 59, dispositions: { none: 64, quarantine: 5, reject: 0 } });
    expect(body.dmarc.byDay.map((d) => [d.pass, d.fail])).toEqual([
      [47, 3],
      [17, 2],
    ]);
    expect(body.dmarc.byOrg).toEqual([
      { org: 'google.com', reports: 1, messages: 50, pass: 47, fail: 3 },
      { org: 'Enterprise Outlook', reports: 1, messages: 19, pass: 17, fail: 2 },
    ]);
  });

  it('a foreign report never moves an aggregate, though the d3cloud.io reports still render (PST-T-7.9, PST-REQ-122)', async () => {
    const body = (await request(app).get('/api/admin/deliverability').set('cookie', admin)).body as Body;
    // Same totals as the "aggregates DMARC pass/fail" test: the foreign report (999 "clean"
    // messages, in range) contributes nothing.
    expect(body.dmarc.totals).toEqual({ reports: 2, messages: 69, pass: 64, fail: 5, dkimPass: 64, spfPass: 59, dispositions: { none: 64, quarantine: 5, reject: 0 } });
    expect(body.dmarc.bySource.find((s) => s.sourceIp === '203.0.113.9')).toBeUndefined();
    expect(body.dmarc.byOrg.find((o) => o.org === 'reports.example.net')).toBeUndefined();
    expect(body.dmarc.reports.find((r) => r.reportId === 'foreign-1')).toBeUndefined();
    // The d3cloud.io reports still render.
    expect(body.dmarc.reports.map((r) => r.reportId).sort()).toEqual(['4817259360124789153', '7f3c2a9e1b6d4c0e8a5f9d2b3c4e5f60'].sort());
  });

  it('by source: messages, pass rate and the orgs that saw it', async () => {
    const body = (await request(app).get('/api/admin/deliverability').set('cookie', admin)).body as Body;
    const top = body.dmarc.bySource[0];
    expect(top).toMatchObject({ sourceIp: '203.0.113.25', messages: 59, pass: 59, fail: 0, passRate: 1, reverseDns: null });
    expect(top?.orgs).toEqual(['Enterprise Outlook', 'google.com']);
    expect(body.dmarc.bySource.find((s) => s.sourceIp === '198.51.100.77')).toMatchObject({ messages: 3, pass: 0, passRate: 0 });
    expect(body.dmarc.bySource.find((s) => s.sourceIp === '192.0.2.99')).toBeUndefined();
  });

  it('TLS-RPT by policy and failure type', async () => {
    const body = (await request(app).get('/api/admin/deliverability').set('cookie', admin)).body as Body;
    expect(body.tlsrpt.totals).toEqual({ reports: 1, successful: 62, failed: 2 });
    expect(body.tlsrpt.byPolicy).toEqual([
      { policyDomain: 'd3cloud.io', policyType: 'sts', successful: 58, failed: 2 },
      { policyDomain: 'lists.d3cloud.io', policyType: 'no-policy-found', successful: 4, failed: 0 },
    ]);
    expect(body.tlsrpt.byFailureType).toEqual([{ resultType: 'certificate-expired', sessions: 2 }]);
  });

  it('a wider range includes the old report; a bad range is refused', async () => {
    const wide = (await request(app).get('/api/admin/deliverability?days=366').set('cookie', admin)).body as Body;
    expect(wide.dmarc.totals.reports).toBe(2); // 2020 is still outside a year
    const all = (await request(app).get('/api/admin/deliverability?days=3650').set('cookie', admin)).body as Body;
    expect(all.dmarc.totals.reports).toBe(3);
    expect((await request(app).get('/api/admin/deliverability?days=4000').set('cookie', admin)).status).toBe(400);
    expect((await request(app).get('/api/admin/deliverability?days=0').set('cookie', admin)).status).toBe(400);
    expect((await request(app).get('/api/admin/deliverability?days=abc').set('cookie', admin)).status).toBe(400);
  });

  it('reverse DNS is bounded by a timeout and cached', async () => {
    let calls = 0;
    const slow = (): Promise<string[]> => {
      calls++;
      return new Promise((resolve) => setTimeout(() => { resolve(['late.example']); }, 500));
    };
    const names = await reverseNames(['192.0.2.200'], { timeoutMs: 20, lookup: slow });
    expect(names.get('192.0.2.200')).toBeNull();
    const found = await reverseNames(['192.0.2.201'], { lookup: () => { calls++; return Promise.resolve(['mx.example.net']); } });
    expect(found.get('192.0.2.201')).toBe('mx.example.net');
    const again = await reverseNames(['192.0.2.201'], { lookup: () => { calls++; return Promise.resolve(['changed.example']); } });
    expect(again.get('192.0.2.201')).toBe('mx.example.net');
    expect(calls).toBe(2);
  });

  it('the dev seed route exists only with POSTROOM_E2E_SEED=1 and files into the report mailbox', async () => {
    const payload = { messages: [{ from: 'noreply-dmarc-support@google.com', subject: 'Report domain: d3cloud.io', attachments: [{ filename: 'r.xml', contentType: 'text/xml', contentBase64: Buffer.from('<feedback/>').toString('base64') }] }] };
    expect((await request(app).post('/api/admin/deliverability/dev/seed').set(CSRF).set('cookie', admin).send(payload)).status).toBe(404);
    const res = await request(seedApp).post('/api/admin/deliverability/dev/seed').set(CSRF).set('cookie', admin).send(payload);
    expect(res.status).toBe(201);
    expect((res.body as { address: string }).address).toBe('dmarc@d3cloud.io');
    const address = await db.address.findFirstOrThrow({ where: { localPart: 'dmarc' }, include: { account: true } });
    expect(address.account?.kind).toBe('service');
    const inbox = await db.mailbox.findFirstOrThrow({ where: { accountId: address.accountId ?? '', name: 'INBOX' }, include: { messages: true } });
    expect(inbox.messages.map((m) => m.subject)).toEqual(['Report domain: d3cloud.io']);
    expect(await db.auditEvent.count({ where: { action: 'dev.seed.report' } })).toBe(1);
  });
});

// PST-T-7.2 / PST-REQ-123: "When 14 consecutive days of aggregate reports show only aligned passes
// from authorized sources, the system shall propose moving the DMARC policy one stage ... with the
// evidence attached." A dirty day, or a missing day, resets the streak and says why.
describe.skipIf(!baseUrl)('DMARC progression proposals (PST-T-7.2, PST-REQ-123)', () => {
  let testDb: TestDatabase;
  let db: Db;
  const clock = new TestClock();
  let app: Express;
  let admin = '';
  let login = '';
  let totpSecret = '';
  const EDGE_IP = '198.51.100.50';

  /** A fresh session: the clock jumps whole days between tests (to give each its own 14-day
   * window), which outlives any earlier session. */
  const signIn = async (): Promise<string> => {
    const first = await request(app).post('/api/auth/signin').set(CSRF).send({ login, password: PASSWORD });
    const { challenge } = first.body as { challenge: string };
    const second = await request(app).post('/api/auth/signin/totp').set(CSRF).send({ challenge, code: totpCode(totpSecret, clock.now()) });
    return cookieHeader(cookiesOf(second));
  };

  beforeAll(async () => {
    testDb = await createTestDatabase(baseUrl ?? '', 'pst_t72_api');
    db = testDb.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    app = createApp({ db, env: { EDGE_PUBLIC_IP: EDGE_IP }, config: baseConfig(clock) });
    login = randomLogin();
    ({ totpSecret } = await createAccount(db, { login, password: PASSWORD, isAdmin: true }));
    clock.advance(31_000);
    admin = await signIn();
  }, 60_000);

  afterAll(async () => {
    await testDb.drop();
  });

  const todayStartUtc = (): number => {
    const n = clock.now();
    return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
  };

  /** Creates one clean-by-default DMARC report for d3cloud.io covering UTC day `dayOffset` days
   * before "today" (negative: -14 is the oldest day the 14-day window admits). */
  async function reportOnDay(
    reportId: string,
    dayOffset: number,
    opts: { sourceIp?: string; disposition?: string; dkim?: string | null; spf?: string | null; domain?: string } = {},
  ): Promise<void> {
    const dayStart = todayStartUtc() + dayOffset * 86_400_000;
    await db.dmarcReport.create({
      data: {
        orgName: 'google.com',
        reportId,
        domain: opts.domain ?? 'd3cloud.io',
        rangeBegin: new Date(dayStart),
        rangeEnd: new Date(dayStart + 86_400_000 - 1000),
        policyPublished: { domain: 'd3cloud.io', p: 'none', pct: 100, adkim: 'r', aspf: 'r' },
        records: {
          create: [
            {
              sourceIp: opts.sourceIp ?? EDGE_IP,
              count: 10,
              disposition: opts.disposition ?? 'none',
              dkim: opts.dkim === undefined ? 'pass' : opts.dkim,
              spf: opts.spf === undefined ? 'pass' : opts.spf,
              headerFrom: 'd3cloud.io',
              authResults: {},
            },
          ],
        },
      },
    });
  }

  it('13 of the last 14 days: not yet, and says which day is missing', async () => {
    for (let i = 1; i <= 13; i++) await reportOnDay(`thirteen-${String(i)}`, -i);
    const res = await request(app).get('/api/admin/deliverability/proposals').set('cookie', admin);
    expect(res.status).toBe(200);
    const proposals = (res.body as { proposals: ProposalResult[] }).proposals;
    const p = proposals.find((r) => r.domain === 'd3cloud.io');
    expect(p?.eligible).toBe(false);
    expect(p?.proposal).toBeNull();
    expect(p?.reason).toContain('no report covers');
  });

  it('a dirty day part-way through the window: not yet, and says why', async () => {
    clock.advance(30 * 86_400_000);
    admin = await signIn();
    for (let i = 1; i <= 14; i++) {
      if (i === 10) await reportOnDay(`dirty-${String(i)}`, -i, { disposition: 'quarantine', dkim: 'fail', spf: 'fail' });
      else await reportOnDay(`dirty-${String(i)}`, -i);
    }
    const res = await request(app).get('/api/admin/deliverability/proposals').set('cookie', admin);
    const proposals = (res.body as { proposals: ProposalResult[] }).proposals;
    const p = proposals.find((r) => r.domain === 'd3cloud.io');
    expect(p?.eligible).toBe(false);
    expect(p?.proposal).toBeNull();
    expect(p?.reason).toMatch(/not disposed "none"/);
  });

  it('14 consecutive clean days from an authorized source: a quarantine proposal with its evidence', async () => {
    clock.advance(60 * 86_400_000);
    admin = await signIn();
    for (let i = 1; i <= 14; i++) await reportOnDay(`clean-${String(i)}`, -i);
    const res = await request(app).get('/api/admin/deliverability/proposals').set('cookie', admin);
    expect(res.status).toBe(200);
    const proposals = (res.body as { proposals: ProposalResult[] }).proposals;
    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p?.domain).toBe('d3cloud.io');
    expect(p?.eligible).toBe(true);
    expect(p?.reason).toBeNull();
    expect(p?.proposal?.currentStage).toBe('none');
    expect(p?.proposal?.proposedStage).toBe('quarantine');
    expect(p?.proposal?.proposedPct).toBe(100);
    expect(p?.proposal?.txtValue).toBe('v=DMARC1; p=quarantine; pct=100; adkim=r; aspf=r; rua=mailto:dmarc@d3cloud.io');
    expect(p?.proposal?.evidence.days).toHaveLength(14);
    expect(p?.proposal?.evidence.days.every((d) => d.reports === 1 && d.messages === 10 && d.sources.includes(EDGE_IP) && d.orgs.includes('google.com'))).toBe(true);
  });

  it('a policy domain reported in another case still counts (RFC 4343)', async () => {
    clock.advance(75 * 86_400_000);
    admin = await signIn();
    for (let i = 1; i <= 14; i++) await reportOnDay(`case-${String(i)}`, -i, { domain: 'D3cloud.IO' });
    const res = await request(app).get('/api/admin/deliverability/proposals').set('cookie', admin);
    const p = (res.body as { proposals: ProposalResult[] }).proposals.find((r) => r.domain === 'd3cloud.io');
    expect(p?.eligible).toBe(true);
    expect(p?.proposal?.evidence.days).toHaveLength(14);
  });

  it('a source outside the authorized set never counts toward the streak', async () => {
    clock.advance(90 * 86_400_000);
    admin = await signIn();
    for (let i = 1; i <= 14; i++) {
      if (i === 5) await reportOnDay(`unauth-${String(i)}`, -i, { sourceIp: '203.0.113.200' });
      else await reportOnDay(`unauth-${String(i)}`, -i);
    }
    const res = await request(app).get('/api/admin/deliverability/proposals').set('cookie', admin);
    const proposals = (res.body as { proposals: ProposalResult[] }).proposals;
    const p = proposals.find((r) => r.domain === 'd3cloud.io');
    expect(p?.eligible).toBe(false);
    expect(p?.reason).toContain('not an authorized source');
  });

  it('is admin only', async () => {
    expect((await request(app).get('/api/admin/deliverability/proposals')).status).toBe(401);
  });
});
