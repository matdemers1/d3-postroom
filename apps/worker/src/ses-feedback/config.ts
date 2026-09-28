// The SES feedback poller's configuration (PST-T-11.17). Off unless the queue and its credentials
// are all set — SES_FEEDBACK_SQS_URL, SES_FEEDBACK_AWS_ACCESS_KEY_ID, SES_FEEDBACK_AWS_SECRET_ACCESS_KEY
// — and SES_SNS_TOPIC_ARNS names at least one topic: with no topic every message would be refused
// and then deleted, and a misconfiguration must not throw away bounces. The region comes from the
// queue URL's host (sqs.<region>.amazonaws.com); the only SQS host ever contacted is that one.
import { envString } from '@postroom/daemon';
import { allowedTopics } from '@postroom/delivery/ses-feedback';
import type { Credentials } from '../backup/sigv4.js';

export type SesFeedbackConfig =
  | { readonly enabled: false; readonly missing: readonly string[] }
  | {
      readonly enabled: true;
      readonly queueUrl: string;
      readonly queueName: string;
      readonly region: string;
      readonly credentials: Credentials;
      readonly topics: ReadonlySet<string>;
      /** SES_SNS_REGION, when set (the same restriction POST /api/ses/sns applies). */
      readonly configuredRegion: string | undefined;
    };

const QUEUE_URL = /^https:\/\/sqs\.([a-z]{2}(?:-[a-z]+)+-\d{1,2})\.amazonaws\.com\/(\d{12})\/([A-Za-z0-9_-]{1,80})$/;

/** The region and name of an SQS queue URL, or null when it is not one. */
export function parseQueueUrl(url: string): { region: string; account: string; name: string } | null {
  const m = QUEUE_URL.exec(url);
  if (m === null) return null;
  return { region: m[1] ?? '', account: m[2] ?? '', name: m[3] ?? '' };
}

export function sesFeedbackConfig(env: NodeJS.ProcessEnv): SesFeedbackConfig {
  const queueUrl = envString(env, 'SES_FEEDBACK_SQS_URL', '').trim();
  const accessKeyId = envString(env, 'SES_FEEDBACK_AWS_ACCESS_KEY_ID', '').trim();
  const secretAccessKey = envString(env, 'SES_FEEDBACK_AWS_SECRET_ACCESS_KEY', '').trim();
  const topics = allowedTopics(env);
  const missing: string[] = [];
  if (queueUrl === '') missing.push('SES_FEEDBACK_SQS_URL');
  if (accessKeyId === '') missing.push('SES_FEEDBACK_AWS_ACCESS_KEY_ID');
  if (secretAccessKey === '') missing.push('SES_FEEDBACK_AWS_SECRET_ACCESS_KEY');
  if (topics.size === 0) missing.push('SES_SNS_TOPIC_ARNS');
  if (missing.length > 0) return { enabled: false, missing };
  const parsed = parseQueueUrl(queueUrl);
  if (parsed === null) return { enabled: false, missing: ['SES_FEEDBACK_SQS_URL (not an https://sqs.<region>.amazonaws.com/<account>/<queue> URL)'] };
  return {
    enabled: true,
    queueUrl,
    queueName: parsed.name,
    region: parsed.region,
    credentials: { accessKeyId, secretAccessKey },
    topics,
    configuredRegion: envString(env, 'SES_SNS_REGION', '') || undefined,
  };
}
