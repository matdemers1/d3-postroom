// @postroom/delivery/ses-feedback (PST-T-11.17): SES bounce and complaint notifications over SNS —
// verification and processing — shared by POST /api/ses/sns and the worker's SQS poller.
export {
  CertCache,
  FETCH_TIMEOUT_MS,
  MAX_CLOCK_SKEW_MS,
  MAX_MESSAGE_AGE_MS,
  SnsError,
  checkTimestamp,
  isPermanentRefusal,
  isSnsUrl,
  parseSnsMessage,
  snsRegion,
  stringToSign,
  timedFetch,
  topicRegion,
  verifyFromTopic,
  verifySnsMessage,
} from './sns.js';
export type { CertCacheOptions, Fetcher, SnsGateOptions, SnsMessage, SnsType } from './sns.js';
export { allowedTopics, processSesNotification } from './notification.js';
export type { FeedbackAlert, FeedbackLog, NotificationDeps, NotificationResult } from './notification.js';
