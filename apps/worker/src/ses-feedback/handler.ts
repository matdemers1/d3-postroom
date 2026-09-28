// One SQS message from the SES feedback queue (PST-T-11.17, PST-REQ-176) → what to do with it.
//
// The queue is subscribed to the SES feedback topic without raw delivery, so each Body is the SNS
// envelope, signature and all. It is trusted by exactly the rules POST /api/ses/sns applies
// (@postroom/delivery/ses-feedback: topic allow-list, region-bound certificate host and path,
// Timestamp window, the certificate cache's pin and rate limit), then processed by the same code,
// idempotent by the SNS MessageId. The disposition:
//
//   delete  processed and committed; or refused for good (malformed, not our topic, stale or
//           future, a certificate URL or signature that is wrong, not a Notification) — logged and
//           audited as ses.feedback.refused, because the same message would be refused forever;
//           or poison (handed out more than maxReceives times) — logged, audited, alerted once.
//   retry   a refusal that may pass later (the certificate could not be fetched, the fetch rate
//           limit, a certificate not usable right now). A database error is thrown, and the loop
//           treats it the same way: the message stays on the queue and comes back.
//
// Never logged or audited: the body, the SES event, the signature. Only ids, topic and codes.
import type { AuditInput } from '@postroom/audit';
import { CertCache, SnsError, isPermanentRefusal, parseSnsMessage, verifyFromTopic, type SnsMessage } from '@postroom/delivery/ses-feedback';
import type { SqsMessage } from './sqs.js';

export type Disposition =
  | { readonly action: 'delete'; readonly outcome: 'processed' | 'refused' | 'poison'; readonly code?: string }
  | { readonly action: 'retry'; readonly outcome: 'transient'; readonly code: string };

export type Log = (event: string, fields?: Record<string, unknown>) => void;
type Alert = (message: { subject: string; text: string; key?: string }) => Promise<{ sent: boolean }>;

/** A message handed out more often than this is dropped as poison (default). */
export const MAX_RECEIVES = 10;
export const AUDIT_ACTOR = { kind: 'system', label: 'ses-sqs' } as const;

export interface HandlerDeps {
  readonly certs: CertCache;
  readonly topics: ReadonlySet<string>;
  readonly configuredRegion?: string | undefined;
  readonly now: () => Date;
  readonly log: Log;
  readonly sendAlert: Alert;
  /** Writes one audit row (recordAudit against the database). */
  readonly audit: (event: AuditInput) => Promise<void>;
  /** Acts on a verified Notification (processSesNotification). Throws on a database error. */
  readonly process: (m: SnsMessage, requestId: string) => Promise<unknown>;
  readonly maxReceives?: number;
}

export function createSqsMessageHandler(deps: HandlerDeps): (msg: SqsMessage) => Promise<Disposition> {
  const maxReceives = deps.maxReceives ?? MAX_RECEIVES;

  const refused = async (msg: SqsMessage, requestId: string, e: SnsError, m: Partial<SnsMessage>): Promise<Disposition> => {
    deps.log('ses-feedback-refused', { sqsMessageId: msg.messageId, snsMessageId: m.MessageId, topicArn: m.TopicArn, code: e.code, reason: e.message });
    await deps.audit({
      actor: AUDIT_ACTOR,
      action: 'ses.feedback.refused',
      entityType: 'sqs_message',
      entityId: null,
      before: null,
      after: { sqsMessageId: msg.messageId, snsMessageId: m.MessageId ?? null, topicArn: m.TopicArn ?? null, type: m.Type ?? null, code: e.code, reason: e.message, receiveCount: msg.receiveCount },
      context: { requestId },
    });
    return { action: 'delete', outcome: 'refused', code: e.code };
  };

  return async (msg) => {
    const requestId = `sqs:${msg.messageId}`;
    if (msg.receiveCount > maxReceives) {
      // Something about this message keeps failing (a database error on this row, a certificate
      // that never comes). Dropped, so it cannot hold a slot forever; the alert key is fixed, so a
      // run of them is one email an hour.
      deps.log('ses-feedback-poison', { sqsMessageId: msg.messageId, receiveCount: msg.receiveCount });
      await deps.audit({
        actor: AUDIT_ACTOR,
        action: 'ses.feedback.poison',
        entityType: 'sqs_message',
        entityId: null,
        before: null,
        after: { sqsMessageId: msg.messageId, receiveCount: msg.receiveCount, maxReceives },
        context: { requestId },
      });
      await deps.sendAlert({
        key: 'ses-feedback-poison',
        subject: 'Postroom: an SES feedback message was dropped after repeated failures',
        text: [
          `SQS message ${msg.messageId} from the SES feedback queue was received ${String(msg.receiveCount)} times without being processed, and has been deleted.`,
          '',
          'It may have been a bounce or complaint notification. The worker log has the failures (ses-feedback-*), and the audit log a ses.feedback.poison row.',
        ].join('\n'),
      });
      return { action: 'delete', outcome: 'poison' };
    }

    let partial: Partial<SnsMessage> = {};
    let m: SnsMessage;
    try {
      let body: unknown;
      try {
        body = JSON.parse(msg.body);
      } catch {
        throw new SnsError(400, 'invalid_sns_message', 'the SQS message body is not JSON (is raw message delivery on?)');
      }
      if (typeof body === 'object' && body !== null) {
        const o = body as Record<string, unknown>;
        partial = {
          ...(typeof o['MessageId'] === 'string' ? { MessageId: o['MessageId'].slice(0, 100) } : {}),
          ...(typeof o['TopicArn'] === 'string' ? { TopicArn: o['TopicArn'].slice(0, 300) } : {}),
          ...(typeof o['Type'] === 'string' ? { Type: o['Type'].slice(0, 40) as SnsMessage['Type'] } : {}),
        };
      }
      m = parseSnsMessage(body);
      await verifyFromTopic(m, { topics: deps.topics, configuredRegion: deps.configuredRegion, certs: deps.certs, now: deps.now() });
      // An SQS subscription is confirmed by SNS itself; a confirmation here is never ours to act on.
      if (m.Type !== 'Notification') throw new SnsError(400, 'sns_type_refused', `a ${m.Type} is not processed from the queue`);
    } catch (e) {
      if (!(e instanceof SnsError)) throw e;
      if (e.code === 'sns_type_refused' || isPermanentRefusal(e)) return refused(msg, requestId, e, partial);
      deps.log('ses-feedback-transient', { sqsMessageId: msg.messageId, snsMessageId: partial.MessageId, code: e.code, reason: e.message, receiveCount: msg.receiveCount });
      return { action: 'retry', outcome: 'transient', code: e.code };
    }

    await deps.process(m, requestId);
    return { action: 'delete', outcome: 'processed' };
  };
}
