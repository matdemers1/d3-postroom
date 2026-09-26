// Signal extraction and sorting for the self-sorting inbox — every decision stores its reasons (PST-ADR-007).
export const PACKAGE = '@postroom/classifier';

export {
  extractSignals,
  normalizeAddress,
  type AccountContext,
  type AccountPins,
  type AuthResultLike,
  type AuthVerdicts,
  type DirectnessSignal,
  type Directness,
  type DmarcResultLike,
  type HeaderLike,
  type MembershipSignals,
  type Signal,
  type SignalInput,
  type Signals,
} from './signals.js';

export { decide, type Bucket, type Decision } from './decide.js';

// PST-T-5.3: the sorting buckets, and per-account naive Bayes trained on moves from any client.
export {
  bucketOfMailbox,
  isSortBucket,
  trainingMove,
  BUCKET_FOLDERS,
  SORT_BUCKETS,
  type MailboxLike,
  type SortBucket,
  type TrainingMove,
} from './buckets.js';
export * from './bayes/index.js';

// PST-T-5.1: where a message is filed — INBOX ($Priority / $People) or one bucket folder.
export {
  bucketFor,
  heuristicBucket,
  FILING_BUCKETS,
  PEOPLE_KEYWORD,
  PRIORITY_KEYWORD,
  type BucketForInput,
  type FilingBucket,
  type FilingDecision,
} from './bucket-for.js';
