// POST /api/ses/sns in the OpenAPI document (PST-REQ-085, PST-T-11.15). The route reads the body
// with its own hand-written checks (./sns.ts parseSnsMessage) because the signature, not a schema,
// is what decides; this zod object documents the same SNS envelope. Spread into ROUTES/COMPONENTS
// by src/openapi/document.ts.
import { z } from 'zod';
import type { ResponseSpec, RouteSpec } from '../openapi/document.js';

export const SnsEnvelope = z.object({
  Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']),
  MessageId: z.string(),
  TopicArn: z.string().describe('Must be listed in SES_SNS_TOPIC_ARNS.'),
  Message: z.string().describe('For a Notification: the SES event JSON (eventType or notificationType Bounce / Complaint).'),
  Timestamp: z.string(),
  SignatureVersion: z.enum(['1', '2']),
  Signature: z.string(),
  SigningCertURL: z.string().describe('https://sns.<region>.amazonaws.com/….pem only.'),
  Subject: z.string().optional(),
  Token: z.string().optional(),
  SubscribeURL: z.string().optional(),
  UnsubscribeURL: z.string().optional(),
});

export const SesSnsAck = z
  .object({
    ok: z.literal(true),
    confirmed: z.boolean().optional(),
    kind: z.enum(['bounce', 'complaint', 'ignored']).optional(),
    alerted: z.boolean().optional(),
    notificationType: z.string().nullable().optional(),
    results: z.array(z.object({ address: z.string().nullable(), action: z.string().optional(), duplicate: z.boolean() })).optional(),
  })
  .meta({ description: 'What was done with the message.' });

export const SES_SNS_COMPONENTS: Record<string, z.ZodType> = { SesSnsAck };

const err = (description: string): ResponseSpec => ({ description, schema: 'Error' });

export const SES_SNS_ROUTES: RouteSpec[] = [
  {
    method: 'post',
    path: '/api/ses/sns',
    operationId: 'sesSnsNotification',
    tag: 'SES',
    summary: 'Amazon SES bounce and complaint notifications, delivered by an SNS HTTPS subscription (PST-T-11.15).',
    description:
      'No session and no CSRF header: authenticated by the SNS message signature (SignatureVersion 1 SHA1withRSA or 2 SHA256withRSA, certificate fetched only from exactly https://sns.<TopicArn region>.amazonaws.com/SimpleNotificationService-<hex>.pem; cached, negatively cached and rate-limited). SNS posts the JSON as text/plain; at most 256 KB. Only TopicArn values in SES_SNS_TOPIC_ARNS (and in SES_SNS_REGION when set) are accepted, and only a Timestamp within the last 24 hours and at most 5 minutes ahead. A SubscriptionConfirmation is confirmed by fetching its SubscribeURL (same regional host). These signed notifications are the only asynchronous path that changes mail: a Permanent bounce marks the correlated delivered recipient bounced and, with a 5.1.x or no status, suppresses the address (PST-REQ-176); a Transient bounce is recorded; a complaint is recorded and alerts the operator, within the hourly complaint-alert cap. Every accepted message is audited.',
    body: SnsEnvelope,
    headers: [{ name: 'x-amz-sns-message-type', required: false, description: 'When present, must equal the body Type.' }],
    responses: {
      '200': { description: 'Accepted (including SES events Postroom ignores, so SNS does not retry them).', schema: 'SesSnsAck' },
      '400': err('Not JSON, not an SNS message, a message type header that disagrees with the body, or a Timestamp outside the accepted window.'),
      '403': err('Unlisted topic or region, a certificate or SubscribeURL off the topic region\'s SNS host, certificate fetches rate-limited, or a signature that does not verify.'),
      '413': err('Body over 256 KB.'),
      '502': err('The SubscribeURL confirmation failed.'),
    },
  },
];
