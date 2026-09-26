// The naive Bayes training consumer (PST-T-5.3, PST-REQ-104). The IMAP server and the webmail API
// write a bayes_training_event in the same transaction as a user's move between two buckets; this
// applies those events to the account's counts.
//
// A move says "this document belongs in toBucket". The consumer keeps, per (account, blob), the
// bucket the document is trained into and exactly the tokens that training added
// (bayes_trained_message), so:
//   · a first move trains the document into toBucket (fromBucket is not touched: it never held it);
//   · a later move subtracts those same tokens from the bucket it was in and adds them to the new one;
//   · a move into the bucket it is already trained in changes nothing.
// Each batch runs in one transaction that stamps processed_at on what it applied, so an event is
// applied exactly once; and because of the per-document record, applying an event again right after
// itself is a no-op, and replaying a document's events in order ends in the same counts (replay-safe).
//
// Ordering: events are applied in id order under one advisory lock, so two consumers (two worker
// processes) never interleave, and a document's later move is always applied after its earlier one
// (the later move's transaction waited on the mailbox lock, so its id is larger).
//
// Not audited row by row: the event row, with its processed_at and outcome, is the record.
import { countTokens, isSortBucket, tokenize, type HeaderLike } from '@postroom/classifier';
import type { Db, Prisma } from '@postroom/db';

type Tx = Prisma.TransactionClient;
type Log = (event: string, fields?: Record<string, unknown>) => void;

export const TRAINING_LOCK = 'postroom-bayes-training';
export const DEFAULT_BATCH = 100;
const TX_OPTIONS = { maxWait: 15_000, timeout: 120_000 } as const;

export type TrainingOutcome = 'trained' | 'retrained' | 'unchanged' | `skipped: ${string}`;

export interface TrainingConsumerDeps {
  readonly db: Db;
  /** The header fields of a stored message, for header tokens (List-Unsubscribe, List-Id, ...). */
  readonly readHeaders?: (blobSha256: string) => Promise<readonly HeaderLike[]>;
  readonly log?: Log;
  readonly batchSize?: number;
}

export interface TrainingBatch {
  /** Events applied (and stamped) by this call. */
  readonly processed: number;
  /** Another consumer held the lock; nothing was done. */
  readonly busy: boolean;
  readonly outcomes: readonly { readonly id: bigint; readonly outcome: TrainingOutcome }[];
}

export interface TrainingConsumer {
  /** Apply at most one batch of unprocessed events. */
  runOnce(): Promise<TrainingBatch>;
  /** Apply batches until none is left (or another consumer holds the lock). Returns the events applied. */
  drain(): Promise<number>;
}

interface EventRow {
  id: bigint;
  account_id: string;
  message_id: string;
  blob_sha256: string;
  from_bucket: string;
  to_bucket: string;
}

export function createTrainingConsumer(deps: TrainingConsumerDeps): TrainingConsumer {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH;
  const log: Log = deps.log ?? (() => undefined);

  const runOnce = async (): Promise<TrainingBatch> =>
    deps.db.$transaction(async (tx) => {
      const lock = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${TRAINING_LOCK}, 0)) AS ok`;
      if (lock[0]?.ok !== true) return { processed: 0, busy: true, outcomes: [] };
      const events = await tx.$queryRaw<EventRow[]>`
        SELECT id, account_id::text AS account_id, message_id::text AS message_id, blob_sha256, from_bucket, to_bucket
        FROM bayes_training_event WHERE processed_at IS NULL ORDER BY id LIMIT ${batchSize} FOR UPDATE`;
      const outcomes: { id: bigint; outcome: TrainingOutcome }[] = [];
      for (const e of events) {
        const outcome = await applyEvent(tx, e, deps.readHeaders, log);
        await tx.$executeRaw`UPDATE bayes_training_event SET processed_at = now(), outcome = ${outcome} WHERE id = ${e.id}`;
        outcomes.push({ id: e.id, outcome });
      }
      if (events.length > 0) log('bayes-training', { processed: events.length });
      return { processed: events.length, busy: false, outcomes };
    }, TX_OPTIONS);

  return {
    runOnce,
    drain: async () => {
      let total = 0;
      for (;;) {
        const batch = await runOnce();
        total += batch.processed;
        if (batch.busy || batch.processed < batchSize) return total;
      }
    },
  };
}

async function applyEvent(tx: Tx, e: EventRow, readHeaders: TrainingConsumerDeps['readHeaders'], log: Log): Promise<TrainingOutcome> {
  if (!isSortBucket(e.to_bucket)) return `skipped: unknown bucket ${e.to_bucket}`;
  const to = e.to_bucket;
  const trained = await tx.$queryRaw<{ bucket: string; tokens: string[] }[]>`
    SELECT bucket, tokens FROM bayes_trained_message
    WHERE account_id = ${e.account_id}::uuid AND blob_sha256 = ${e.blob_sha256} FOR UPDATE`;
  const prior = trained[0];
  if (prior !== undefined) {
    if (prior.bucket === to) return 'unchanged';
    await subtract(tx, e.account_id, prior.bucket, prior.tokens);
    await add(tx, e.account_id, to, prior.tokens);
    await tx.$executeRaw`
      UPDATE bayes_trained_message SET bucket = ${to}, updated_at = now()
      WHERE account_id = ${e.account_id}::uuid AND blob_sha256 = ${e.blob_sha256}`;
    return 'retrained';
  }

  const tokens = await documentTokens(tx, e, readHeaders, log);
  if (tokens === null) return 'skipped: message gone';
  await add(tx, e.account_id, to, tokens);
  await tx.$executeRaw`
    INSERT INTO bayes_trained_message (account_id, blob_sha256, bucket, tokens)
    VALUES (${e.account_id}::uuid, ${e.blob_sha256}, ${to}, ${tokens}::text[])`;
  return 'trained';
}

/**
 * The document's tokens: the message the event names, or (when that row has since moved through the
 * webmail, which gives it a new id, or been expunged) any message of the account with the same blob.
 */
async function documentTokens(tx: Tx, e: EventRow, readHeaders: TrainingConsumerDeps['readHeaders'], log: Log): Promise<string[] | null> {
  const rows = await tx.$queryRaw<{ subject: string | null; from_address: string | null; s_subject: string | null; from_text: string | null; body_text: string | null }[]>`
    SELECT m.subject, m.from_address, s.subject AS s_subject, s.from_text, s.body_text
    FROM message m
    JOIN mailbox mb ON mb.id = m.mailbox_id
    LEFT JOIN message_search s ON s.message_id = m.id
    WHERE mb.account_id = ${e.account_id}::uuid AND (m.id = ${e.message_id}::uuid OR m.blob_sha256 = ${e.blob_sha256})
    ORDER BY (m.id = ${e.message_id}::uuid) DESC, (s.message_id IS NOT NULL) DESC
    LIMIT 1`;
  const row = rows[0];
  if (row === undefined) return null;
  let headers: readonly HeaderLike[] = [];
  if (readHeaders !== undefined) {
    try {
      headers = await readHeaders(e.blob_sha256);
    } catch (err) {
      // Header tokens are a refinement; the document still trains on its subject, sender and body.
      log('bayes-training-headers-unreadable', { eventId: e.id.toString(), error: err instanceof Error ? err.message : String(err) });
    }
  }
  const subject = row.s_subject !== null && row.s_subject !== '' ? row.s_subject : row.subject;
  const from = row.from_address ?? (row.from_text !== null && row.from_text !== '' ? row.from_text : null);
  return tokenize({ subject, from, bodyText: row.body_text, headers });
}

async function add(tx: Tx, accountId: string, bucket: string, tokens: readonly string[]): Promise<void> {
  const counts = countTokens(tokens);
  if (counts.size > 0) {
    await tx.$executeRaw`
      INSERT INTO bayes_token (account_id, bucket, token, count)
      SELECT ${accountId}::uuid, ${bucket}, u.t, u.c FROM unnest(${[...counts.keys()]}::text[], ${[...counts.values()]}::int[]) AS u(t, c)
      ON CONFLICT (account_id, bucket, token) DO UPDATE SET count = bayes_token.count + EXCLUDED.count`;
  }
  await tx.$executeRaw`
    INSERT INTO bayes_bucket_total (account_id, bucket, docs, tokens) VALUES (${accountId}::uuid, ${bucket}, 1, ${tokens.length})
    ON CONFLICT (account_id, bucket) DO UPDATE SET docs = bayes_bucket_total.docs + 1, tokens = bayes_bucket_total.tokens + EXCLUDED.tokens`;
}

async function subtract(tx: Tx, accountId: string, bucket: string, tokens: readonly string[]): Promise<void> {
  const counts = countTokens(tokens);
  if (counts.size > 0) {
    const keys = [...counts.keys()];
    await tx.$executeRaw`
      UPDATE bayes_token AS b SET count = GREATEST(b.count - u.c, 0)
      FROM unnest(${keys}::text[], ${[...counts.values()]}::int[]) AS u(t, c)
      WHERE b.account_id = ${accountId}::uuid AND b.bucket = ${bucket} AND b.token = u.t`;
    await tx.$executeRaw`
      DELETE FROM bayes_token WHERE account_id = ${accountId}::uuid AND bucket = ${bucket} AND token = ANY(${keys}::text[]) AND count <= 0`;
  }
  await tx.$executeRaw`
    UPDATE bayes_bucket_total SET docs = GREATEST(docs - 1, 0), tokens = GREATEST(tokens - ${tokens.length}, 0)
    WHERE account_id = ${accountId}::uuid AND bucket = ${bucket}`;
}
