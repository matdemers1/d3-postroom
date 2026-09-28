// What a verified SES notification does (PST-T-11.15, extending PST-REQ-176), shared since
// PST-T-11.17 by POST /api/ses/sns and the worker's SQS poller so the two paths cannot drift:
//
//   Bounce      each bounced recipient → recordAsyncBounce (trusted: signed). Permanent marks the
//               correlated recipient bounced and, with a 5.1.x or no status, suppresses the address
//               with the remote's reply; Transient/Undetermined are recorded only.
//   Complaint   each complained recipient → recordComplaint, and one operator alert per
//               notification through the D3 Auth relay (PST-REQ-096), within the server-wide
//               hourly complaint-alert cap.
//   anything else  audited as ignored.
//
// Each recipient is its own transaction, idempotent by `ses:<SNS MessageId>:<index>`, so a
// redelivered notification (SNS retrying a POST, SQS handing a message out again) does nothing
// twice. The caller supplies the Message-ID parser (@postroom/mime, which this package does not
// depend on) and the alert sender (@postroom/alerts' SendAlert fits the type below).
import { recordAudit, type RequestContext } from '@postroom/audit';
import type { Db } from '@postroom/db';
import { smtpCodeOf, statusCode } from '@postroom/dsn';
import { envString } from '@postroom/daemon';
import { complaintAlert, markAlerted, recordAsyncBounce, recordComplaint } from '../feedback.js';
import type { SnsMessage } from './sns.js';

/** Recipients read from one notification (SES sends at most 50 per message). */
const MAX_RECIPIENTS = 50;

/** Structurally @postroom/alerts' SendAlert. */
export type FeedbackAlert = (message: { subject: string; text: string; key?: string }) => Promise<{ sent: boolean }>;

export type FeedbackLog = (event: string, fields?: Record<string, unknown>) => void;

export interface NotificationDeps {
  readonly db: Db;
  readonly now: () => Date;
  readonly sendAlert: FeedbackAlert;
  /** @postroom/mime's parseMessageId: the first msg-id in a header value, without brackets. */
  readonly parseMessageId: (value: string) => string | null;
  /** Audit context: the HTTP request's, or `{ requestId: 'sqs:<id>' }` for the poller. */
  readonly context: RequestContext;
  /** Audit actor label for rows written here ('ses-sns' for the HTTPS route, 'ses-sqs' for the poller). */
  readonly actorLabel?: string;
  /** Log event prefix ('ses-sns' by default). */
  readonly logPrefix?: string;
  readonly log: FeedbackLog;
}

export type NotificationResult =
  | { kind: 'bounce'; results: { address: string; action: string; duplicate: boolean }[] }
  | { kind: 'complaint'; results: { address: string | null; duplicate: boolean }[]; alerted: boolean }
  | { kind: 'ignored'; notificationType: string | null };

/** SES_SNS_TOPIC_ARNS, comma-separated. */
export function allowedTopics(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    envString(env, 'SES_SNS_TOPIC_ARNS', '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 1000) : null);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.slice(0, MAX_RECIPIENTS).map(obj) : []);

/** The original's Message-ID candidates from `mail`: its headers (when SES included them) and commonHeaders. */
function messageIdsOf(mail: Obj, parseMessageId: (value: string) => string | null): string[] {
  const ids: string[] = [];
  for (const h of list(mail['headers'])) {
    if (typeof h['name'] === 'string' && h['name'].toLowerCase() === 'message-id' && typeof h['value'] === 'string') {
      const id = parseMessageId(h['value']);
      if (id !== null) ids.push(id);
    }
  }
  const common = obj(mail['commonHeaders'])['messageId'];
  if (typeof common === 'string') {
    const id = parseMessageId(common);
    if (id !== null) ids.push(id);
  }
  return [...new Set(ids)];
}

function dateOr(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string') return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Act on one verified SNS Notification carrying an SES event. Throws only on a database error, in
 * which case whatever committed stays committed and a redelivery finishes the rest.
 */
export async function processSesNotification(m: SnsMessage, deps: NotificationDeps): Promise<NotificationResult> {
  const { db, log, context } = deps;
  const actor = { kind: 'system' as const, label: deps.actorLabel ?? 'ses-sns' };
  const prefix = deps.logPrefix ?? 'ses-sns';
  const requestId = context.requestId;
  const at = deps.now();
  let payload: Obj;
  try {
    payload = obj(JSON.parse(m.Message));
  } catch {
    payload = {};
  }
  const kind = text(payload['eventType']) ?? text(payload['notificationType']);
  const mail = obj(payload['mail']);
  const correlation = { messageIds: messageIdsOf(mail, deps.parseMessageId), transportMessageId: text(mail['messageId']) };

  if (kind === 'Bounce') {
    const b = obj(payload['bounce']);
    const bounceType = text(b['bounceType']) ?? 'Undetermined';
    const feedbackType = `${bounceType}/${text(b['bounceSubType']) ?? 'General'}`;
    const reportedAt = dateOr(b['timestamp'], dateOr(m.Timestamp, at));
    const results: { address: string; action: string; duplicate: boolean }[] = [];
    for (const [i, r] of list(b['bouncedRecipients']).entries()) {
      const address = text(r['emailAddress']);
      if (address === null) continue;
      const diagnostic = text(r['diagnosticCode']);
      // "smtp; 550 5.1.1 user unknown" → the reply after the type.
      const reply = diagnostic === null ? null : diagnostic.replace(/^[a-z0-9-]+;\s*/i, '');
      const result = await db.$transaction((tx) =>
        recordAsyncBounce(tx, {
          source: 'ses',
          dedupeKey: `ses:${m.MessageId}:${String(i)}`,
          address,
          status: statusCode(text(r['status'])),
          code: smtpCodeOf(reply),
          diagnostic: reply,
          final: bounceType === 'Permanent',
          feedbackType,
          correlation,
          trusted: true,
          detail: { topicArn: m.TopicArn, snsMessageId: m.MessageId, sesFeedbackId: text(b['feedbackId']), reportingMta: text(b['reportingMTA']), remoteMta: text(b['remoteMtaIp']), sesMessageId: correlation.transportMessageId },
          reportedAt,
          now: at,
          requestId,
        }),
      );
      results.push({ address, action: result.action, duplicate: result.duplicate });
    }
    if (results.length === 0) {
      await recordAudit(db, {
        actor,
        action: 'ses.sns.notification-ignored',
        entityType: 'sns_message',
        entityId: null,
        before: null,
        after: { topicArn: m.TopicArn, snsMessageId: m.MessageId, notificationType: kind, reason: 'a bounce naming no recipient' },
        context,
      });
    }
    log(`${prefix}-bounce`, { snsMessageId: m.MessageId, bounceType, recipients: results.length, actions: results.map((r) => r.action) });
    return { kind: 'bounce', results };
  }

  if (kind === 'Complaint') {
    const c = obj(payload['complaint']);
    const feedbackType = text(c['complaintFeedbackType']) ?? text(c['complaintSubType']);
    const reportedAt = dateOr(c['timestamp'], dateOr(m.Timestamp, at));
    const recipients = list(c['complainedRecipients']).map((r) => text(r['emailAddress']));
    const results: { address: string | null; duplicate: boolean }[] = [];
    let first: { feedbackId: string; address: string | null; outboundMessageId: string | null } | null = null;
    const due: string[] = [];
    for (const [i, address] of (recipients.length === 0 ? [null] : recipients).entries()) {
      const result = await db.$transaction((tx) =>
        recordComplaint(tx, {
          source: 'ses',
          dedupeKey: `ses:${m.MessageId}:${String(i)}`,
          feedbackType,
          address,
          correlation,
          trusted: true,
          detail: { topicArn: m.TopicArn, snsMessageId: m.MessageId, sesFeedbackId: text(c['feedbackId']), userAgent: text(c['userAgent']), arrivalDate: text(c['arrivalDate']), sesMessageId: correlation.transportMessageId },
          reportedAt,
          now: at,
          requestId,
        }),
      );
      if (result.alertDue) {
        due.push(result.feedbackId);
        first ??= { feedbackId: result.feedbackId, address, outboundMessageId: result.outboundMessageId };
      }
      results.push({ address, duplicate: result.duplicate });
    }
    // One alert per notification, however many recipients it names.
    let alerted = false;
    if (first !== null) {
      const sent = await deps.sendAlert(complaintAlert({ ...first, source: 'ses', feedbackType, address: recipients.length > 1 ? `${String(recipients.length)} recipients` : first.address }));
      alerted = sent.sent;
      if (sent.sent) for (const id of due) await markAlerted(db, id, deps.now());
    }
    log(`${prefix}-complaint`, { snsMessageId: m.MessageId, feedbackType, recipients: results.length, alerted });
    return { kind: 'complaint', results, alerted };
  }

  await recordAudit(db, {
    actor,
    action: 'ses.sns.notification-ignored',
    entityType: 'sns_message',
    entityId: null,
    before: null,
    after: { topicArn: m.TopicArn, snsMessageId: m.MessageId, notificationType: kind },
    context,
  });
  log(`${prefix}-ignored`, { snsMessageId: m.MessageId, notificationType: kind });
  return { kind: 'ignored', notificationType: kind };
}
