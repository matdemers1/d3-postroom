// Normalized report rows (PST-T-7.1, PST-REQ-122). One transaction per message: the report_ingest
// row first (so two workers racing on one message cannot both write it — the second sees the
// conflict and writes nothing), then each report, then the audit rows, actor SYSTEM.
//
// Idempotent on the report itself: `INSERT … ON CONFLICT (org_name, report_id) DO NOTHING`, so a
// report delivered twice (a retry by the sender, a second rua copy, a re-filed message) is recorded
// once and the later message's outcome says `duplicate`.
import { recordAudit } from '@postroom/audit';
import type { Db, Prisma } from '@postroom/db';
import { dmarcPassed, type DmarcAggregateReport, type TlsRptReport } from '@postroom/reports';

type Tx = Prisma.TransactionClient;

export type AttachmentOutcome =
  | { readonly partId: string; readonly filename: string | null; readonly kind: 'dmarc' | 'tlsrpt'; readonly org: string; readonly reportId: string; readonly result: 'ingested' | 'duplicate'; readonly id: string }
  | { readonly partId: string; readonly filename: string | null; readonly result: 'error'; readonly code: string; readonly message: string };

export type ParsedAttachment =
  | { readonly partId: string; readonly filename: string | null; readonly kind: 'dmarc'; readonly report: DmarcAggregateReport }
  | { readonly partId: string; readonly filename: string | null; readonly kind: 'tlsrpt'; readonly report: TlsRptReport }
  | { readonly partId: string; readonly filename: string | null; readonly kind: 'error'; readonly code: string; readonly message: string };

export type MessageOutcome = 'ingested' | 'duplicate' | 'error' | 'no-report';

const SYSTEM = { kind: 'system', label: 'reports' } as const;
const json = (v: unknown): string => JSON.stringify(v);

async function storeDmarc(tx: Tx, r: DmarcAggregateReport, messageId: string): Promise<{ id: string; created: boolean }> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO dmarc_report (org_name, report_id, email, domain, range_begin, range_end, policy_published, message_id)
    VALUES (${r.orgName}, ${r.reportId}, ${r.email}, ${r.policy.domain}, to_timestamp(${r.begin}), to_timestamp(${r.end}),
            ${json(r.policy)}::jsonb, ${messageId}::uuid)
    ON CONFLICT (org_name, report_id) DO NOTHING
    RETURNING id::text AS id`;
  const row = inserted[0];
  if (row === undefined) {
    const existing = await tx.dmarcReport.findUniqueOrThrow({ where: { orgName_reportId: { orgName: r.orgName, reportId: r.reportId } }, select: { id: true } });
    return { id: existing.id, created: false };
  }
  if (r.records.length > 0) {
    await tx.dmarcRecord.createMany({
      data: r.records.map((rec) => ({
        reportId: row.id,
        sourceIp: rec.sourceIp,
        count: rec.count,
        disposition: rec.disposition,
        dkim: rec.dkim,
        spf: rec.spf,
        headerFrom: rec.headerFrom,
        envelopeFrom: rec.envelopeFrom,
        authResults: JSON.parse(json({ dkim: rec.authDkim, spf: rec.authSpf, reasons: rec.reasons, envelopeTo: rec.envelopeTo })) as Prisma.InputJsonValue,
      })),
    });
  }
  const messages = r.records.reduce((n, rec) => n + rec.count, 0);
  const passed = r.records.reduce((n, rec) => n + (dmarcPassed(rec) ? rec.count : 0), 0);
  await recordAudit(tx, {
    actor: SYSTEM,
    action: 'reports.dmarc.ingest',
    entityType: 'dmarc_report',
    entityId: row.id,
    after: { org: r.orgName, reportId: r.reportId, domain: r.policy.domain, records: r.records.length, messages, passed, messageId },
  });
  return { id: row.id, created: true };
}

async function storeTlsRpt(tx: Tx, r: TlsRptReport, messageId: string): Promise<{ id: string; created: boolean }> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO tlsrpt_report (org_name, report_id, contact_info, range_begin, range_end, message_id)
    VALUES (${r.organizationName}, ${r.reportId}, ${r.contactInfo}, ${r.start}::timestamptz, ${r.end}::timestamptz, ${messageId}::uuid)
    ON CONFLICT (org_name, report_id) DO NOTHING
    RETURNING id::text AS id`;
  const row = inserted[0];
  if (row === undefined) {
    const existing = await tx.tlsRptReport.findUniqueOrThrow({ where: { orgName_reportId: { orgName: r.organizationName, reportId: r.reportId } }, select: { id: true } });
    return { id: existing.id, created: false };
  }
  for (const p of r.policies) {
    await tx.tlsRptPolicy.create({
      data: {
        reportId: row.id,
        policyType: p.policyType,
        policyDomain: p.policyDomain,
        policyString: [...p.policyString],
        mxHost: [...p.mxHost],
        successCount: p.totalSuccessful,
        failureCount: p.totalFailure,
        failures: {
          create: p.failures.map((f) => ({
            resultType: f.resultType,
            sendingMtaIp: f.sendingMtaIp,
            receivingMxHostname: f.receivingMxHostname,
            receivingIp: f.receivingIp,
            failedSessionCount: f.failedSessionCount,
            additionalInfo: f.additionalInformation,
            failureReasonCode: f.failureReasonCode,
          })),
        },
      },
    });
  }
  await recordAudit(tx, {
    actor: SYSTEM,
    action: 'reports.tlsrpt.ingest',
    entityType: 'tlsrpt_report',
    entityId: row.id,
    after: {
      org: r.organizationName,
      reportId: r.reportId,
      policies: r.policies.length,
      successful: r.policies.reduce((n, p) => n + p.totalSuccessful, 0),
      failed: r.policies.reduce((n, p) => n + p.totalFailure, 0),
      messageId,
    },
  });
  return { id: row.id, created: true };
}

export function outcomeOf(results: readonly AttachmentOutcome[]): MessageOutcome {
  if (results.some((r) => r.result === 'ingested')) return 'ingested';
  if (results.some((r) => r.result === 'duplicate')) return 'duplicate';
  if (results.some((r) => r.result === 'error')) return 'error';
  return 'no-report';
}

/**
 * Records one message's reports. Returns null when another worker already recorded this message
 * (nothing is written), else the per-attachment outcomes.
 */
export async function storeMessageReports(db: Db, messageId: string, parsed: readonly ParsedAttachment[]): Promise<{ outcome: MessageOutcome; results: AttachmentOutcome[] } | null> {
  return db.$transaction(
    async (tx) => {
      const claimed = await tx.$executeRaw`
        INSERT INTO report_ingest (message_id, outcome, detail) VALUES (${messageId}::uuid, 'pending', '[]'::jsonb)
        ON CONFLICT (message_id) DO NOTHING`;
      if (claimed === 0) return null;
      const results: AttachmentOutcome[] = [];
      for (const a of parsed) {
        if (a.kind === 'error') {
          results.push({ partId: a.partId, filename: a.filename, result: 'error', code: a.code, message: a.message.slice(0, 300) });
          continue;
        }
        const stored = a.kind === 'dmarc' ? await storeDmarc(tx, a.report, messageId) : await storeTlsRpt(tx, a.report, messageId);
        results.push({
          partId: a.partId,
          filename: a.filename,
          kind: a.kind,
          org: a.kind === 'dmarc' ? a.report.orgName : a.report.organizationName,
          reportId: a.report.reportId,
          result: stored.created ? 'ingested' : 'duplicate',
          id: stored.id,
        });
      }
      const outcome = outcomeOf(results);
      await tx.$executeRaw`UPDATE report_ingest SET outcome = ${outcome}, detail = ${json(results)}::jsonb WHERE message_id = ${messageId}::uuid`;
      await recordAudit(tx, { actor: SYSTEM, action: 'reports.message.read', entityType: 'message', entityId: messageId, after: { outcome, attachments: results.length } });
      return { outcome, results };
    },
    { maxWait: 15_000, timeout: 120_000 },
  );
}
