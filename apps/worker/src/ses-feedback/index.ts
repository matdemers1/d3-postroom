// SES bounce and complaint feedback through SQS (PST-T-11.17, PST-REQ-176). SES publishes to an SNS
// topic; the topic delivers to an SQS queue (not raw, so each message keeps its SNS signature); the
// worker long-polls it. Nothing public has to be reachable: SNS's HTTPS delivery to
// /api/ses/sns was met by Cloudflare's Bot Fight Mode with a managed challenge, which a free-plan
// zone cannot skip per path. Verification and processing are the api route's, shared through
// @postroom/delivery/ses-feedback; this module adds the queue.
import { recordAudit } from '@postroom/audit';
import type { Db } from '@postroom/db';
import { CertCache, processSesNotification, timedFetch, type Fetcher } from '@postroom/delivery/ses-feedback';
import { parseMessageId } from '@postroom/mime';
import { sesFeedbackConfig } from './config.js';
import { createSqsMessageHandler, type Log } from './handler.js';
import { startSesFeedbackLoop, type SesFeedbackLoop, type SesFeedbackStatus } from './loop.js';
import { createSqsClient } from './sqs.js';

export { sesFeedbackConfig, parseQueueUrl } from './config.js';
export type { SesFeedbackConfig } from './config.js';
export { createSqsMessageHandler, MAX_RECEIVES } from './handler.js';
export type { Disposition, HandlerDeps } from './handler.js';
export { startSesFeedbackLoop, defaultRetryVisibility } from './loop.js';
export type { SesFeedbackLoop, SesFeedbackLoopOptions, SesFeedbackStatus } from './loop.js';
export { createSqsClient, classifySqsError, SqsError } from './sqs.js';
export type { SqsClient, SqsClientOptions, SqsMessage } from './sqs.js';

type Alert = (message: { subject: string; text: string; key?: string }) => Promise<{ sent: boolean }>;

export type SesFeedbackHealth = SesFeedbackStatus | { readonly enabled: false; readonly missing: readonly string[] };

export interface StartSesFeedbackOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly db: Db;
  readonly log: Log;
  readonly sendAlert: Alert;
  /** Certificate fetches (default: timed, no redirects; CertCache allows only SNS's own host and path). */
  readonly certFetch?: Fetcher;
  /** SQS requests (tests). */
  readonly sqsFetch?: typeof fetch;
  /** SQS endpoint override (tests). */
  readonly endpoint?: string;
  readonly now?: () => Date;
}

/** Start the poller when configured; otherwise log why not and report it on /health. */
export function startSesFeedback(opts: StartSesFeedbackOptions): { stop: () => Promise<void>; health: () => SesFeedbackHealth } {
  const config = sesFeedbackConfig(opts.env);
  if (!config.enabled) {
    opts.log('ses-feedback-disabled', { missing: config.missing });
    return { stop: () => Promise.resolve(), health: () => ({ enabled: false, missing: config.missing }) };
  }
  const now = opts.now ?? ((): Date => new Date());
  const sqs = createSqsClient({
    queueUrl: config.queueUrl,
    region: config.region,
    credentials: config.credentials,
    ...(opts.endpoint === undefined ? {} : { endpoint: opts.endpoint }),
    ...(opts.sqsFetch === undefined ? {} : { fetch: opts.sqsFetch }),
    now,
  });
  const handle = createSqsMessageHandler({
    // Its own cache: the api's is in another process.
    certs: new CertCache(opts.certFetch ?? timedFetch),
    topics: config.topics,
    configuredRegion: config.configuredRegion,
    now,
    log: opts.log,
    sendAlert: opts.sendAlert,
    audit: (event) => recordAudit(opts.db, event),
    process: (m, requestId) =>
      processSesNotification(m, { db: opts.db, now, sendAlert: opts.sendAlert, parseMessageId, context: { requestId }, actorLabel: 'ses-sqs', logPrefix: 'ses-feedback', log: opts.log }),
  });
  const loop: SesFeedbackLoop = startSesFeedbackLoop({ sqs, queue: config.queueName, handle, log: opts.log, sendAlert: opts.sendAlert, now });
  return { stop: () => loop.stop(), health: () => loop.status() };
}
