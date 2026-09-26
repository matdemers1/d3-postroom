// Thread sweeper (PST-T-3.14, PST-REQ-078): repairs a filed Message left with threadId NULL by a
// crash between the file stage's transaction commit and its post-commit assignThread call (see
// apps/worker/src/stages/file.ts). The file stage only denormalises messageIdHeader/subject/
// fromAddress/sentAt onto the Message row inside its transaction — In-Reply-To and References are
// written by assignThread itself — so a row caught mid-crash carries no threading headers at all.
// The blob is immutable and still referenced, so the sweep re-derives them the same way parse did:
// by re-reading the stored message.
//
// Bounded and idempotent: it selects at most `limit` rows, re-checks each one's threadId right
// before calling assignThread (a concurrent sweep, or the live path finishing late, may have
// threaded it already), and assignThread itself is safe under its own per-account advisory lock.
// A grace period keeps it from racing a copy the live path is still in the middle of threading.
import { assignThread } from '@postroom/threading';
import type { BlobStore } from '@postroom/blobstore';
import type { Db } from '@postroom/db';
import { collectBlob, summarise } from '../stages/parse.js';
import type { Log } from '../stages/types.js';

export const DEFAULT_SWEEP_LIMIT = 200;
export const DEFAULT_SWEEP_GRACE_MS = 30_000;

export interface ThreadSweepDeps {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly log: Log;
  readonly now: () => Date;
}

export interface ThreadSweepOptions {
  /** At most this many candidate rows per run (default 200). */
  readonly limit?: number;
  /** Skip rows filed more recently than this, so the sweep never races the live path (default 30s). */
  readonly graceMs?: number;
  /** Only rows whose id sorts after this one (the cursor a previous run returned as `lastId`). */
  readonly afterId?: string;
}

export interface ThreadSweepResult {
  /** Candidate rows this run looked at (at most `limit`). */
  readonly scanned: number;
  /** Rows this run threaded. */
  readonly threaded: number;
  /** Candidates that already had a threadId by the time this run reached them. */
  readonly skipped: number;
  /** Candidates that could not be threaded (unreadable blob, parse error); retried next pass. */
  readonly failed: number;
  /** The last id this run looked at; pass it back as `afterId` so a bad row never starves the rest. */
  readonly lastId: string | null;
}

/**
 * Thread every Message row left with threadId NULL past the grace period, up to `limit` per call.
 * Safe to call on an interval and safe to call concurrently with itself or the live filing path.
 */
export async function sweepUnthreaded(deps: ThreadSweepDeps, options: ThreadSweepOptions = {}): Promise<ThreadSweepResult> {
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  const graceMs = options.graceMs ?? DEFAULT_SWEEP_GRACE_MS;
  const cutoff = new Date(deps.now().getTime() - graceMs);

  const candidates = await deps.db.message.findMany({
    where: { threadId: null, receivedAt: { lte: cutoff }, ...(options.afterId === undefined ? {} : { id: { gt: options.afterId } }) },
    select: { id: true, blobSha256: true, receivedAt: true, mailbox: { select: { accountId: true } } },
    orderBy: { id: 'asc' },
    take: limit,
  });

  let threaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of candidates) {
    // Re-check right before assigning: another sweep run, or a slow live path, may have threaded
    // this row since the select above.
    const current = await deps.db.message.findUnique({ where: { id: row.id }, select: { threadId: true } });
    if (current === null || current.threadId !== null) {
      skipped++;
      continue;
    }

    // One bad row (an unreadable blob, a parse error) is logged and passed over: it must not stop
    // the rows behind it from being threaded, this run or any later one.
    try {
      const parsed = summarise(await collectBlob(deps.blobs, row.blobSha256));
      await assignThread(deps.db, {
        accountId: row.mailbox.accountId,
        messageId: row.id,
        ...(parsed.messageId === null ? {} : { messageIdHeader: parsed.messageId }),
        ...(parsed.inReplyTo[0] === undefined ? {} : { inReplyTo: parsed.inReplyTo[0] }),
        references: parsed.references,
        subject: parsed.subject ?? '',
        from: parsed.fromAddress ?? '',
        to: parsed.toAddress ?? '',
        date: parsed.sentAt === null ? row.receivedAt : new Date(parsed.sentAt),
      });
      threaded++;
    } catch (error) {
      failed++;
      deps.log('thread-sweep-row-failed', { messageId: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const result: ThreadSweepResult = { scanned: candidates.length, threaded, skipped, failed, lastId: candidates.at(-1)?.id ?? null };
  if (result.scanned > 0) deps.log('thread-sweep', { scanned: result.scanned, threaded: result.threaded, skipped: result.skipped, failed: result.failed });
  return result;
}

/**
 * A sweeper that walks the candidates with a cursor: each call continues after the last row the
 * previous call looked at, and starts over once a pass comes back short. Rows that keep failing are
 * revisited once per pass, never ahead of everything else.
 */
export function createThreadSweeper(deps: ThreadSweepDeps, options: Omit<ThreadSweepOptions, 'afterId'> = {}): () => Promise<ThreadSweepResult> {
  const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;
  let cursor: string | undefined;
  return async () => {
    const result = await sweepUnthreaded(deps, { ...options, limit, ...(cursor === undefined ? {} : { afterId: cursor }) });
    cursor = result.scanned < limit || result.lastId === null ? undefined : result.lastId;
    return result;
  };
}
