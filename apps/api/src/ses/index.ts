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
// The verification (./sns.ts → @postroom/delivery/ses-feedback) and the Bounce/Complaint processing
// are shared with the worker's SQS poller (PST-T-11.17), which is how SES feedback actually arrives
// in production: Cloudflare's Bot Fight Mode challenges SNS's POSTs here. This route stays as is.
//
// These signed notifications are the only asynchronous path that bounces a recipient or suppresses
// an address; an SMTP DSN is informational (apps/delivery/src/feedback.ts says why).
//   anything else             audited as ignored, answered 200 so SNS does not retry it.
import express, { Router, type Request, type Response } from 'express';
import { createAlertSender, type SendAlert } from '@postroom/alerts';
import { getAuditContext, recordAudit } from '@postroom/audit';
import { envString } from '@postroom/daemon';
import { allowedTopics, processSesNotification, type NotificationResult } from '@postroom/delivery/ses-feedback';
import { parseMessageId } from '@postroom/mime';
import { handle } from '../auth/middleware.js';
import type { ApiDeps } from '../deps.js';
import { CertCache, SnsError, parseSnsMessage, timedFetch, verifyFromTopic, type Fetcher, type SnsMessage } from './sns.js';

export { CertCache, SnsError, checkTimestamp, isSnsUrl, parseSnsMessage, snsRegion, stringToSign, topicRegion, verifySnsMessage, type Fetcher, type SnsMessage } from './sns.js';
export { allowedTopics } from '@postroom/delivery/ses-feedback';

/** SNS messages are at most 256 KB. */
export const MAX_SNS_BODY = '256kb';

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

  const notification = (req: Request, m: SnsMessage): Promise<NotificationResult> =>
    processSesNotification(m, { db, now, sendAlert, parseMessageId, context: getAuditContext(req), actorLabel: 'ses-sns', logPrefix: 'ses-sns', log });

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
      try {
        m = parseSnsMessage(body);
        const headerType = req.get('x-amz-sns-message-type');
        if (headerType !== undefined && headerType !== m.Type) throw new SnsError(400, 'invalid_sns_message', 'x-amz-sns-message-type does not match Type');
        // Topic, region, Timestamp and SubscribeURL before any fetch, then the signature.
        await verifyFromTopic(m, { topics, configuredRegion, certs, now: now() });
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
