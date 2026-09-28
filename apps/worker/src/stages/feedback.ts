// Stage 7, feedback (PST-T-11.15). Runs after the message is filed and notified, so a report is
// always delivered to the user's mailbox like any other mail first; this stage only reads it, and
// never drops or moves it. It changes no mail either: everything here is informational.
//
//   multipart/report; report-type=delivery-status  a remote's DSN about mail we sent. Each `failed`
//      recipient becomes a delivery_feedback row (Final-Recipient, Status, Diagnostic-Code, and the
//      outbound message and recipient it names), and nothing else: no state change, no
//      suppression. A DSN is forgeable and cannot be authenticated against the failed recipient's
//      domain, so acting on one would let anyone who saw a Message-ID and a recipient list bounce
//      and globally suppress a co-recipient (the reasoning is in apps/delivery/src/feedback.ts).
//      Signed SES notifications (apps/api/src/ses) are the path that bounces and suppresses.
//   multipart/report; report-type=feedback-report  an ARF abuse report. Recorded against the
//      outbound message it names; an operator alert through the D3 Auth relay (PST-REQ-096), at
//      most one per outbound message ever and within the hourly complaint-alert cap.
//
// A DSN that does not even look like one — neither a null reverse-path nor a MAILER-DAEMON or
// postmaster From — or that smtp-in quarantined is recorded as `ignored` with the reason; the rest
// as `recorded`. Correlation is restricted to outbound mail sent by the accounts the DSN was
// delivered to, so one account's inbound mail never names another account's messages.
//
// Idempotent: every event has a dedupe key derived from the spool row (`dsn:<id>:<n>`,
// `arf:<id>`), so a replay or a crash-and-resume records nothing twice and alerts once.
import { complaintAlert, markAlerted, recordAsyncBounce, recordComplaint } from '@postroom/delivery';
import { parseDeliveryStatus, parseFeedbackReport } from '@postroom/dsn';
import { extractReport, type ExtractedReport } from '../feedback/extract.js';
import type { Json, SpooledRecipient, StageDeps, StageInput, VerifyResult } from './types.js';

/** Local parts a bounce may come from when the reverse-path is not null (RFC 5321 §4.5.5 says it should be). */
const BOUNCE_SENDERS = new Set(['mailer-daemon', 'postmaster']);

export interface FeedbackEventJson {
  readonly feedbackId: string;
  readonly address: string | null;
  readonly action: string;
  readonly duplicate: boolean;
  readonly [key: string]: Json;
}

export interface FeedbackResult {
  readonly kind: 'none' | 'dsn' | 'arf';
  readonly reasons: string[];
  readonly events: FeedbackEventJson[];
  readonly [key: string]: Json;
}

function fromBounceSender(envelopeFrom: string, report: ExtractedReport): boolean {
  if (envelopeFrom.trim() === '' || envelopeFrom.trim() === '<>') return true;
  const local = report.from === null ? '' : report.from.slice(0, report.from.lastIndexOf('@'));
  return BOUNCE_SENDERS.has(local.toLowerCase());
}

export async function feedbackStage(
  input: StageInput,
  deps: Pick<StageDeps, 'db' | 'blobs' | 'log' | 'now' | 'sendAlert'>,
  ctx: { verify: VerifyResult; recipients: readonly SpooledRecipient[] },
): Promise<FeedbackResult> {
  const { inbound } = input;
  const report = await extractReport(deps.blobs, inbound.blobSha256);
  if (report === null) return { kind: 'none', reasons: ['not a delivery-status or feedback-report multipart/report'], events: [] };
  const accountIds = [...new Set(ctx.recipients.flatMap((r) => r.accountIds))];
  const requestId = `inbound:${inbound.id}`;
  const messageIds = report.originalMessageId === null ? [] : [report.originalMessageId];

  if (report.type === 'delivery-status') {
    const reasons: string[] = [];
    const events: FeedbackEventJson[] = [];
    if (report.body === null) return { kind: 'dsn', reasons: ['no message/delivery-status part'], events };
    const dsn = parseDeliveryStatus(report.body);
    if (dsn.truncated) reasons.push('more recipients than are read; the rest were skipped');
    const refuse: string[] = [];
    if (!fromBounceSender(inbound.envelopeFrom, report)) refuse.push('does not look like a DSN: not from a null reverse-path or a MAILER-DAEMON/postmaster From');
    if (ctx.verify.disposition === 'quarantine') refuse.push('smtp-in quarantined this message');
    if (messageIds.length === 0 && dsn.originalEnvelopeId === null) reasons.push('the DSN names no original (no returned Message-ID, no Original-Envelope-Id)');
    for (const [i, r] of dsn.recipients.entries()) {
      const address = r.finalRecipient ?? r.originalRecipient;
      if (r.action !== 'failed') {
        reasons.push(`recipient ${String(i + 1)}: action ${r.action ?? 'missing'} is not a failure; skipped`);
        continue;
      }
      if (address === null) {
        reasons.push(`recipient ${String(i + 1)}: no usable Final-Recipient; skipped`);
        continue;
      }
      const result = await deps.db.$transaction((tx) =>
        recordAsyncBounce(tx, {
          source: 'dsn',
          dedupeKey: `dsn:${inbound.id}:${String(i)}`,
          address,
          status: r.status,
          code: r.smtpCode,
          diagnostic: r.diagnostic,
          final: true,
          correlation: { messageIds, envid: dsn.originalEnvelopeId, accountIds },
          trusted: false,
          refuse,
          inboundMessageId: inbound.id,
          detail: {
            reportingMta: dsn.reportingMta,
            remoteMta: r.remoteMta,
            diagnosticType: r.diagnosticType,
            arrivalDate: dsn.arrivalDate,
            lastAttemptDate: r.lastAttemptDate,
            originalMessageId: report.originalMessageId,
          },
          reportedAt: inbound.receivedAt,
          now: deps.now(),
          requestId,
        }),
      );
      events.push({ feedbackId: result.feedbackId, address, action: result.action, duplicate: result.duplicate, marked: result.marked, suppressed: result.suppressed, reasons: result.reasons });
      if (!result.duplicate) deps.log('async-bounce', { inboundMessageId: inbound.id, feedbackId: result.feedbackId, action: result.action, status: r.status });
    }
    if (dsn.recipients.length === 0) reasons.push('the delivery-status part names no recipient');
    return { kind: 'dsn', reasons, events };
  }

  // feedback-report (ARF)
  if (ctx.verify.disposition === 'quarantine') return { kind: 'arf', reasons: ['smtp-in quarantined this message; not read as a report'], events: [] };
  const arf = report.body === null ? null : parseFeedbackReport(report.body);
  if (arf === null) return { kind: 'arf', reasons: ['no message/feedback-report part'], events: [] };
  const complaint = await deps.db.$transaction((tx) =>
    recordComplaint(tx, {
      source: 'arf',
      dedupeKey: `arf:${inbound.id}`,
      feedbackType: arf.feedbackType,
      address: arf.originalRcptTo[0] ?? null,
      correlation: { messageIds, envid: arf.originalEnvelopeId },
      trusted: false,
      inboundMessageId: inbound.id,
      detail: {
        userAgent: arf.userAgent,
        reportingMta: arf.reportingMta,
        sourceIp: arf.sourceIp,
        arrivalDate: arf.arrivalDate,
        incidents: arf.incidents,
        reportedDomain: [...arf.reportedDomain],
        reporter: report.from,
        originalMessageId: report.originalMessageId,
      },
      reportedAt: inbound.receivedAt,
      now: deps.now(),
      requestId,
    }),
  );
  const reasons = [...complaint.reasons];
  if (complaint.alertDue) {
    const alert = complaintAlert({
      feedbackId: complaint.feedbackId,
      source: 'arf',
      feedbackType: arf.feedbackType,
      address: arf.originalRcptTo[0] ?? null,
      outboundMessageId: complaint.outboundMessageId,
      messageId: report.originalMessageId,
    });
    const sent = deps.sendAlert === undefined ? { sent: false, reason: 'no alert sender' } : await deps.sendAlert(alert);
    if (sent.sent) await markAlerted(deps.db, complaint.feedbackId, deps.now());
    reasons.push(sent.sent ? 'operator alerted' : `operator alert not sent: ${sent.reason ?? 'unknown'}`);
  }
  deps.log('complaint', { inboundMessageId: inbound.id, feedbackId: complaint.feedbackId, duplicate: complaint.duplicate, feedbackType: arf.feedbackType });
  return {
    kind: 'arf',
    reasons,
    events: [{ feedbackId: complaint.feedbackId, address: arf.originalRcptTo[0] ?? null, action: 'recorded', duplicate: complaint.duplicate, feedbackType: arf.feedbackType }],
  };
}
