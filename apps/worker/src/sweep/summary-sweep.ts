// Summary sweeper (PST-T-14.2): fills a Message's list summary — from_name and snippet — where it
// is missing. That is every row filed before the columns existed (the backfill after the migration
// deploys), plus the few filing paths that cannot read the body cheaply (a Rejects copy in smtp-in,
// a DSN from delivery, an APPEND too large to re-read on the protocol path). `snippet IS NULL` is
// the marker: once summarised a row always has a snippet, even an empty one.
//
// The blob is immutable, so the summary is re-derived exactly as the parse stage derives it (the
// same body text the search index stores). Bounded and idempotent: at most `limit` rows per call,
// and each write is conditional on the snippet still being NULL, so a concurrent sweep or a late
// live path never has its value overwritten. Every batch that writes is one audit row.
import { recordAudit, type Actor } from '@postroom/audit';
import type { BlobStore } from '@postroom/blobstore';
import type { Db } from '@postroom/db';
import { snippetOf } from '@postroom/search';
import { collectBlob, summarise } from '../stages/parse.js';
import type { Log } from '../stages/types.js';

export const DEFAULT_SUMMARY_SWEEP_LIMIT = 200;
export const DEFAULT_SUMMARY_SWEEP_GRACE_MS = 30_000;

const ACTOR: Actor = { kind: 'system', label: 'summary-sweep' };

export interface SummarySweepDeps {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly log: Log;
  readonly now: () => Date;
}

export interface SummarySweepOptions {
  /** At most this many candidate rows per call (default 200). */
  readonly limit?: number;
  /** Skip rows filed more recently than this, so the sweep never races a filing path (default 30s). */
  readonly graceMs?: number;
  /** Only rows whose id sorts after this one (the cursor a previous call returned as `lastId`). */
  readonly afterId?: string;
}

export interface SummarySweepResult {
  /** Candidate rows this call looked at (at most `limit`). */
  readonly scanned: number;
  /** Rows this call summarised. */
  readonly summarised: number;
  /** Candidates something else summarised first. */
  readonly skipped: number;
  /** Candidates whose blob could not be read or parsed; retried next pass. */
  readonly failed: number;
  /** The last id this call looked at; pass it back as `afterId`. */
  readonly lastId: string | null;
}

/** Summarise up to `limit` rows still missing a snippet. Safe on an interval and concurrently. */
export async function sweepUnsummarised(deps: SummarySweepDeps, options: SummarySweepOptions = {}): Promise<SummarySweepResult> {
  const limit = options.limit ?? DEFAULT_SUMMARY_SWEEP_LIMIT;
  const graceMs = options.graceMs ?? DEFAULT_SUMMARY_SWEEP_GRACE_MS;
  const cutoff = new Date(deps.now().getTime() - graceMs);

  const candidates = await deps.db.message.findMany({
    where: { snippet: null, receivedAt: { lte: cutoff }, ...(options.afterId === undefined ? {} : { id: { gt: options.afterId } }) },
    select: { id: true, blobSha256: true },
    orderBy: { id: 'asc' },
    take: limit,
  });

  // Read and parse outside any transaction: a blob read is I/O, and one bad row must not stop the
  // rest.
  const computed: { id: string; fromName: string | null; snippet: string }[] = [];
  let failed = 0;
  for (const row of candidates) {
    try {
      const parsed = summarise(await collectBlob(deps.blobs, row.blobSha256));
      computed.push({ id: row.id, fromName: parsed.fromName ?? null, snippet: snippetOf(parsed.bodyText) });
    } catch (error) {
      failed++;
      deps.log('summary-sweep-row-failed', { messageId: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  let summarised: string[] = [];
  if (computed.length > 0) {
    summarised = await deps.db.$transaction(async (tx) => {
      const done: string[] = [];
      for (const c of computed) {
        const n = await tx.message.updateMany({ where: { id: c.id, snippet: null }, data: { fromName: c.fromName, snippet: c.snippet } });
        if (n.count > 0) done.push(c.id);
      }
      if (done.length > 0) {
        await recordAudit(tx, {
          actor: ACTOR,
          action: 'message.summary-backfill',
          entityType: 'message',
          entityId: null,
          after: { count: done.length, messageIds: done },
        });
      }
      return done;
    });
  }

  const result: SummarySweepResult = {
    scanned: candidates.length,
    summarised: summarised.length,
    skipped: computed.length - summarised.length,
    failed,
    lastId: candidates.at(-1)?.id ?? null,
  };
  if (result.scanned > 0) deps.log('summary-sweep', { scanned: result.scanned, summarised: result.summarised, skipped: result.skipped, failed: result.failed });
  return result;
}

/**
 * A sweeper that walks the candidates with a cursor, like the thread sweeper: each call continues
 * after the last row the previous call looked at and starts over once a pass comes back short, so
 * a row that keeps failing is revisited once per pass, never ahead of everything else.
 */
export function createSummarySweeper(deps: SummarySweepDeps, options: Omit<SummarySweepOptions, 'afterId'> = {}): () => Promise<SummarySweepResult> {
  const limit = options.limit ?? DEFAULT_SUMMARY_SWEEP_LIMIT;
  let cursor: string | undefined;
  return async () => {
    const result = await sweepUnsummarised(deps, { ...options, limit, ...(cursor === undefined ? {} : { afterId: cursor }) });
    cursor = result.scanned < limit || result.lastId === null ? undefined : result.lastId;
    return result;
  };
}

/**
 * Run the sweeper until a pass comes back short (the backfill): one full walk over every row
 * missing a summary, a batch at a time. Returns how many rows it summarised.
 */
export async function drainSummaries(sweep: () => Promise<SummarySweepResult>, limit: number = DEFAULT_SUMMARY_SWEEP_LIMIT): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await sweep();
    total += r.summarised;
    if (r.scanned < limit) return total;
  }
}
