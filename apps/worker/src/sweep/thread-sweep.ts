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
}

export interface ThreadSweepResult {
  /** Candidate rows this run looked at (at most `limit`). */
  readonly scanned: number;
  /** Rows this run threaded. */
  readonly threaded: number;
  /** Candidates that already had a threadId by the time this run reached them. */
  readonly skipped: number;
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
    where: { threadId: null, receivedAt: { lte: cutoff } },
    select: { id: true, blobSha256: true, receivedAt: true, mailbox: { select: { accountId: true } } },
    orderBy: { id: 'asc' },
    take: limit,
  });

  let threaded = 0;
  let skipped = 0;
  for (const row of candidates) {
    // Re-check right before assigning: another sweep run, or a slow live path, may have threaded
    // this row since the select above.
    const current = await deps.db.message.findUnique({ where: { id: row.id }, select: { threadId: true } });
    if (current === null || current.threadId !== null) {
      skipped++;
      continue;
    }

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
  }

  const result: ThreadSweepResult = { scanned: candidates.length, threaded, skipped };
  if (result.scanned > 0) deps.log('thread-sweep', { scanned: result.scanned, threaded: result.threaded, skipped: result.skipped });
  return result;
}
