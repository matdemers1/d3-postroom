// POST /api/ses/sns (PST-T-11.15, extending PST-REQ-176): Amazon SES bounce and complaint
// notifications, published by an SES configuration set to an SNS topic, delivered here by an HTTPS
// subscription. With all outbound mail relayed through SES, SES accepting a message is what marks
// it delivered; this is where the bounces and complaints that come after are heard.
//
// Public — no session, no CSRF — because its authentication is the SNS message signature
// (./sns.ts), checked before anything is read or written; mounted ahead of the session gate in
// app.ts. Only topics listed in SES_SNS_TOPIC_ARNS are accepted (none listed: every POST is
// refused). The topic, its region (the only sns.<region>.amazonaws.com host ever fetched from), the
// Timestamp (at most 24 h old, 5 min ahead) and a SubscribeURL are all checked before any
// certificate is fetched, so a stranger's POST never makes Postroom fetch anything, and certificate
// fetches are cached, negatively cached and rate-limited (CertCache). The body is SNS's text/plain JSON, at most 256 KB; a message
// is never logged whole (only its type, id and topic).
//
//   SubscriptionConfirmation  the SubscribeURL (same SNS-host allow-list) is fetched to confirm; audited.
//   UnsubscribeConfirmation   audited, nothing else: Postroom never resubscribes by itself.
//   Notification, Bounce      each bounced recipient → recordAsyncBounce (trusted: signed). Permanent
//                             marks the correlated recipient bounced and, with a 5.1.x or no status,
//                             suppresses the address; Transient/Undetermined are recorded only.
//   Notification, Complaint   each complained recipient → recordComplaint, and one operator alert
//                             per notification through the D3 Auth relay (PST-REQ-096), within the
//                             server-wide hourly complaint-alert cap.
//
// These signed notifications are the only asynchronous path that bounces a recipient or suppresses
// an address; an SMTP DSN is informational (apps/delivery/src/feedback.ts says why).
//   anything else             audited as ignored, answered 200 so SNS does not retry it.
import express, { Router, type Request, type Response } from 'express';
import { createAlertSender, type SendAlert } from '@postroom/alerts';
import { getAuditContext, recordAudit } from '@postroom/audit';
import { envString } from '@postroom/daemon';
import { complaintAlert, markAlerted, recordAsyncBounce, recordComplaint } from '@postroom/delivery';
import { smtpCodeOf, statusCode } from '@postroom/dsn';
import { parseMessageId } from '@postroom/mime';
import { handle } from '../auth/middleware.js';
import type { ApiDeps } from '../deps.js';
import { CertCache, SnsError, checkTimestamp, isSnsUrl, parseSnsMessage, snsRegion, timedFetch, verifySnsMessage, type Fetcher, type SnsMessage } from './sns.js';

export { CertCache, SnsError, checkTimestamp, isSnsUrl, parseSnsMessage, snsRegion, stringToSign, topicRegion, verifySnsMessage, type Fetcher, type SnsMessage } from './sns.js';

/** SNS messages are at most 256 KB. */
export const MAX_SNS_BODY = '256kb';
/** Recipients read from one notification (SES sends at most 50 per message). */
const MAX_RECIPIENTS = 50;

export interface SesSnsOptions {
  /** Fetches the signing certificate and the SubscribeURL. Tests inject one; default: fetch with a timeout, no redirects. */
  readonly fetch?: Fetcher;
  readonly sendAlert?: SendAlert;
  readonly now?: () => Date;
}

type Log = (event: string, fields?: Record<string, unknown>) => void;
const log: Log = (event, fields) => {
  process.stdout.write(`${JSON.stringify({ daemon: 'api', event, ...fields })}\n`);
};

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
function messageIdsOf(mail: Obj): string[] {
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

export function sesSnsRoutes(deps: ApiDeps): Router {
  const options: SesSnsOptions = deps.sesSns ?? {};
  const now = options.now ?? deps.config.now ?? ((): Date => new Date());
  const fetcher = options.fetch ?? timedFetch;
  const configuredRegion = envString(deps.env, 'SES_SNS_REGION', '') || undefined;
  const certs = new CertCache(fetcher);
  const sendAlert =
    options.sendAlert ??
    createAlertSender({ url: envString(deps.env, 'MAIL_RELAY_URL', ''), token: envString(deps.env, 'MAIL_RELAY_TOKEN', ''), to: envString(deps.env, 'ALERT_TO', '') }, { log });
  const { db } = deps;
  const router = Router();

  const refuse = (res: Response, e: SnsError, fields: Record<string, unknown> = {}): void => {
    log('ses-sns-refused', { code: e.code, reason: e.message, ...fields });
    res.status(e.status).json({ error: e.code });
  };

  const notification = async (req: Request, m: SnsMessage): Promise<Record<string, unknown>> => {
    const requestId = getAuditContext(req).requestId;
    const at = now();
    let payload: Obj;
    try {
      payload = obj(JSON.parse(m.Message));
    } catch {
      payload = {};
    }
    const kind = text(payload['eventType']) ?? text(payload['notificationType']);
    const mail = obj(payload['mail']);
    const correlation = { messageIds: messageIdsOf(mail), transportMessageId: text(mail['messageId']) };

    if (kind === 'Bounce') {
      const b = obj(payload['bounce']);
      const bounceType = text(b['bounceType']) ?? 'Undetermined';
      const feedbackType = `${bounceType}/${text(b['bounceSubType']) ?? 'General'}`;
      const reportedAt = dateOr(b['timestamp'], dateOr(m.Timestamp, at));
      const results = [];
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
          actor: { kind: 'system', label: 'ses-sns' },
          action: 'ses.sns.notification-ignored',
          entityType: 'sns_message',
          entityId: null,
          before: null,
          after: { topicArn: m.TopicArn, snsMessageId: m.MessageId, notificationType: kind, reason: 'a bounce naming no recipient' },
          context: getAuditContext(req),
        });
      }
      log('ses-sns-bounce', { snsMessageId: m.MessageId, bounceType, recipients: results.length, actions: results.map((r) => r.action) });
      return { kind: 'bounce', results };
    }

    if (kind === 'Complaint') {
      const c = obj(payload['complaint']);
      const feedbackType = text(c['complaintFeedbackType']) ?? text(c['complaintSubType']);
      const reportedAt = dateOr(c['timestamp'], dateOr(m.Timestamp, at));
      const recipients = list(c['complainedRecipients']).map((r) => text(r['emailAddress']));
      const results = [];
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
        const sent = await sendAlert(complaintAlert({ ...first, source: 'ses', feedbackType, address: recipients.length > 1 ? `${String(recipients.length)} recipients` : first.address }));
        alerted = sent.sent;
        if (sent.sent) for (const id of due) await markAlerted(db, id, now());
      }
      log('ses-sns-complaint', { snsMessageId: m.MessageId, feedbackType, recipients: results.length, alerted });
      return { kind: 'complaint', results, alerted };
    }

    await recordAudit(db, {
      actor: { kind: 'system', label: 'ses-sns' },
      action: 'ses.sns.notification-ignored',
      entityType: 'sns_message',
      entityId: null,
      before: null,
      after: { topicArn: m.TopicArn, snsMessageId: m.MessageId, notificationType: kind },
      context: getAuditContext(req),
    });
    log('ses-sns-ignored', { snsMessageId: m.MessageId, notificationType: kind });
    return { kind: 'ignored', notificationType: kind };
  };

  router.post(
    '/sns',
    express.text({ type: () => true, limit: MAX_SNS_BODY }),
    handle(async (req: Request, res: Response): Promise<void> => {
      const topics = allowedTopics(deps.env);
      let body: unknown;
      try {
        body = JSON.parse(typeof req.body === 'string' ? req.body : '');
      } catch {
        res.status(400).json({ error: 'invalid_json' });
        return;
      }
      let m: SnsMessage;
      let region: string;
      try {
        m = parseSnsMessage(body);
        const headerType = req.get('x-amz-sns-message-type');
        if (headerType !== undefined && headerType !== m.Type) throw new SnsError(400, 'invalid_sns_message', 'x-amz-sns-message-type does not match Type');
        // Before any fetch: a stranger's POST must not make Postroom fetch anything.
        if (!topics.has(m.TopicArn)) throw new SnsError(403, 'sns_topic_refused', topics.size === 0 ? 'SES_SNS_TOPIC_ARNS is not set' : 'TopicArn is not in SES_SNS_TOPIC_ARNS');
        // The topic's own region, and SES_SNS_REGION when set: the only SNS host fetched from.
        region = snsRegion(m, configuredRegion);
        // A stale or future-dated message is refused before its certificate is fetched.
        checkTimestamp(m, now());
        if (m.Type === 'SubscriptionConfirmation' && !isSnsUrl(m.SubscribeURL ?? '', { region })) {
          throw new SnsError(403, 'sns_subscribe_url_refused', 'SubscribeURL is not an SNS URL for the topic region');
        }
        await verifySnsMessage(m, certs, now(), region);
      } catch (e) {
        if (e instanceof SnsError) {
          refuse(res, e);
          return;
        }
        throw e;
      }

      if (m.Type === 'SubscriptionConfirmation') {
        // Checked against the topic region above, before the signature was.
        const url = m.SubscribeURL ?? '';
        let ok = false;
        let status = 0;
        try {
          const r = await fetcher(url, { redirect: 'error' });
          status = r.status;
          ok = r.ok;
          await r.body?.cancel();
        } catch {
          // Unreachable or refused: `ok` stays false and the 502 below says so.
        }
        await recordAudit(db, {
          actor: { kind: 'system', label: 'ses-sns' },
          action: ok ? 'ses.sns.subscription-confirmed' : 'ses.sns.subscription-confirm-failed',
          entityType: 'sns_subscription',
          entityId: null,
          before: null,
          after: { topicArn: m.TopicArn, snsMessageId: m.MessageId, status },
          context: getAuditContext(req),
        });
        log('ses-sns-subscription', { topicArn: m.TopicArn, confirmed: ok, status });
        if (!ok) {
          res.status(502).json({ error: 'sns_confirm_failed' });
          return;
        }
        res.json({ ok: true, confirmed: true });
        return;
      }

      if (m.Type === 'UnsubscribeConfirmation') {
        await recordAudit(db, {
          actor: { kind: 'system', label: 'ses-sns' },
          action: 'ses.sns.unsubscribed',
          entityType: 'sns_subscription',
          entityId: null,
          before: null,
          after: { topicArn: m.TopicArn, snsMessageId: m.MessageId },
          context: getAuditContext(req),
        });
        log('ses-sns-unsubscribed', { topicArn: m.TopicArn });
        res.json({ ok: true });
        return;
      }

      const result = await notification(req, m);
      res.json({ ok: true, ...result });
    }),
  );
  return router;
}
