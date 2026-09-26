// PST-T-7.1 / PST-REQ-122 against a real database and blob store: a Google (.zip), a Microsoft
// (.xml.gz) and a Google TLS-RPT (.json.gz) report, delivered through the inbound pipeline to the
// dmarc@ service mailbox, become normalized rows exactly once — re-filing the message (a pipeline
// replay) or a second delivery of the same report never duplicates them — and every write is
// audited as SYSTEM.
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { AccountKind, AddressKind, DEFAULT_MAILBOXES, randomUidValidity, seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { startWorker, type RunningWorker } from '@postroom/queue';
import { createInboundPipeline, INBOUND_QUEUE } from '../../src/pipeline.js';
import { createReportSweeper, reportAddresses, resolveReportMailboxes } from '../../src/reports/index.js';
import { Clock, messageWithAttachment, spool, type TestRecipient } from './helpers.js';

const baseUrl = process.env['DATABASE_URL'];
const fixtures = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'reports', 'test', 'fixtures');
const fixture = (suffix: string): { filename: string; data: Buffer } => {
  const filename = readdirSync(fixtures).find((f) => f.endsWith(suffix));
  if (filename === undefined) throw new Error(`no fixture ${suffix}`);
  return { filename, data: readFileSync(join(fixtures, filename)) };
};

describe.skipIf(baseUrl === undefined)('report ingest (PST-T-7.1, PST-REQ-122)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  const clock = new Clock();
  let worker: RunningWorker;
  let reportsAccountId = '';
  const env = {} as NodeJS.ProcessEnv;

  const toReports = (): TestRecipient => ({ rcpt: 'dmarc@d3cloud.io', address: 'dmarc@d3cloud.io', accountIds: [reportsAccountId], kind: 'service' });
  const deliver = async (from: string, suffix: string, contentType: string): Promise<string> => {
    const { filename, data } = fixture(suffix);
    const { id } = await spool(db, blobs, { recipients: [toReports()], message: messageWithAttachment({ from, filename, contentType, data }) });
    return id;
  };

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t71');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    const domain = await db.domain.findFirstOrThrow({ where: { isPrimary: true } });
    const account = await db.account.create({ data: { displayName: 'DMARC reports', kind: AccountKind.service } });
    reportsAccountId = account.id;
    await db.address.create({ data: { localPart: 'dmarc', domainId: domain.id, kind: AddressKind.service, accountId: account.id } });
    for (const mb of DEFAULT_MAILBOXES) {
      await db.mailbox.create({ data: { accountId: account.id, name: mb.name, specialUse: mb.specialUse, uidvalidity: randomUidValidity(randomInt) } });
    }
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t71-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    worker = await startWorker({ db, databaseUrl: t.url, queues: { [INBOUND_QUEUE]: createInboundPipeline({ db, blobs, now: clock.now }).handle }, manual: true, now: clock.now });
  }, 120_000);

  afterAll(async () => {
    await worker.stop();
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('defaults the report addresses to dmarc@ and tlsrpt@ the primary domain, and honours the env', async () => {
    expect(await reportAddresses(db, {})).toEqual(['dmarc@d3cloud.io', 'tlsrpt@d3cloud.io']);
    expect(await reportAddresses(db, { REPORTS_MAILBOX: 'Rua@D3cloud.io', TLSRPT_MAILBOX: 'tls@d3cloud.io' })).toEqual(['rua@d3cloud.io', 'tls@d3cloud.io']);
    const resolved = await resolveReportMailboxes(db, {});
    const names = (await db.mailbox.findMany({ where: { id: { in: [...resolved.mailboxIds] } }, select: { name: true } })).map((m) => m.name).sort();
    expect(names).toContain('INBOX');
    expect(names).not.toContain('Sent');
    expect(names).not.toContain('Trash');
  });

  it('files each fixture through the pipeline and stores its rows once', async () => {
    await deliver('noreply-dmarc-support@google.com', '.zip', 'application/zip');
    await deliver('dmarcreport@microsoft.com', '.xml.gz', 'application/gzip');
    await deliver('noreply-smtp-tls-reporting@google.com', '.json.gz', 'application/tlsrpt+gzip');
    expect(await worker.drain()).toBe(3);

    const sweeper = createReportSweeper({ db, blobs, env });
    const swept = await sweeper.drain();
    expect(swept.map((s) => s.outcome)).toEqual(['ingested', 'ingested', 'ingested']);

    const reports = await db.dmarcReport.findMany({ include: { records: true }, orderBy: { rangeBegin: 'asc' } });
    expect(reports.map((r) => [r.orgName, r.reportId, r.domain, r.records.length])).toEqual([
      ['google.com', '4817259360124789153', 'd3cloud.io', 3],
      ['Enterprise Outlook', '7f3c2a9e1b6d4c0e8a5f9d2b3c4e5f60', 'd3cloud.io', 2],
    ]);
    expect(reports[0]?.rangeBegin.toISOString()).toBe('2026-09-24T00:00:00.000Z');
    const google = reports[0]?.records.find((r) => r.sourceIp === '198.51.100.77');
    expect(google).toMatchObject({ count: 3, disposition: 'quarantine', dkim: 'fail', spf: 'fail', headerFrom: 'd3cloud.io' });

    const tls = await db.tlsRptReport.findMany({ include: { policies: { include: { failures: true } } } });
    expect(tls).toHaveLength(1);
    expect(tls[0]?.orgName).toBe('Google Inc.');
    const sts = tls[0]?.policies.find((p) => p.policyType === 'sts');
    expect(sts).toMatchObject({ policyDomain: 'd3cloud.io', successCount: 58, failureCount: 2 });
    expect(sts?.failures.map((f) => [f.resultType, f.failedSessionCount])).toEqual([['certificate-expired', 2]]);

    const audits = await db.auditEvent.findMany({ where: { action: { startsWith: 'reports.' } } });
    expect(audits.every((a) => a.actorKind === 'system')).toBe(true);
    expect(audits.filter((a) => a.action === 'reports.dmarc.ingest')).toHaveLength(2);
    expect(audits.filter((a) => a.action === 'reports.tlsrpt.ingest')).toHaveLength(1);

    // Nothing left: a second sweep reads nothing.
    expect(await sweeper.drain()).toEqual([]);
  });

  it('re-filing the message (a pipeline replay) and re-delivering the report do not duplicate', async () => {
    const before = { reports: await db.dmarcReport.count(), records: await db.dmarcRecord.count(), tls: await db.tlsRptReport.count() };

    // A second delivery of the same Google report: a new message, the same (org, report id).
    const id = await deliver('noreply-dmarc-support@google.com', '.zip', 'application/zip');
    expect(await worker.drain()).toBe(1);
    // And a replay of its file stage, which finds the copy already filed.
    await createInboundPipeline({ db, blobs, now: clock.now }).run(id, { replayFrom: 'file' });
    expect(await db.message.count({ where: { inboundMessageId: id } })).toBe(1);

    const swept = await createReportSweeper({ db, blobs, env }).drain();
    expect(swept).toHaveLength(1);
    expect(swept[0]?.outcome).toBe('duplicate');
    expect(swept[0]?.results[0]).toMatchObject({ kind: 'dmarc', org: 'google.com', result: 'duplicate' });

    expect({ reports: await db.dmarcReport.count(), records: await db.dmarcRecord.count(), tls: await db.tlsRptReport.count() }).toEqual(before);
  });

  it('records a broken report as an error once, and a message with no report as no-report', async () => {
    await spool(db, blobs, {
      recipients: [toReports()],
      message: messageWithAttachment({ from: 'noreply@example.org', filename: 'broken.xml.gz', contentType: 'application/gzip', data: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01]) }),
    });
    await spool(db, blobs, {
      recipients: [toReports()],
      message: messageWithAttachment({ from: 'someone@example.org', filename: 'notes.pdf', contentType: 'application/pdf', data: Buffer.from('%PDF-1.7 hello') }),
    });
    expect(await worker.drain()).toBe(2);
    const swept = await createReportSweeper({ db, blobs, env }).drain();
    expect(swept.map((s) => s.outcome).sort()).toEqual(['error', 'no-report']);
    const error = swept.find((s) => s.outcome === 'error');
    expect(error?.results[0]).toMatchObject({ result: 'error', code: 'gzip' });
    expect(await createReportSweeper({ db, blobs, env }).drain()).toEqual([]);
  });

  it('two sweepers racing on the same messages record each once', async () => {
    await deliver('noreply-dmarc-support@google.com', '.zip', 'application/zip');
    await deliver('dmarcreport@microsoft.com', '.xml.gz', 'application/gzip');
    expect(await worker.drain()).toBe(2);
    const [a, b] = await Promise.all([createReportSweeper({ db, blobs, env }).drain(), createReportSweeper({ db, blobs, env }).drain()]);
    expect(a.length + b.length).toBe(2);
    expect(await db.reportIngest.count()).toBe(8); // 3 + 1 + 2 before, 2 here
  });
});
