// PST-T-16.12 (PST-REQ-199): backfills the to-summary (./recipients.ts) a Sent or Drafts row shows
// in place of the sender.
//
// Written at filing time where the filing path has the headers (the parse stage derives it, the
// file stage stores it), and backfilled by the to-summary sweep below for every other row: mail
// filed before message.to_count existed, and the paths that leave it NULL. `to_count IS NULL` is the
// marker: once summarised a row always has a count, 0 for a message with no recipients.
//
// The sweep reads HEADERS ONLY — the blob is streamed until its blank line (bounded at 64 KiB by
// blobHeaderReader) and the stream destroyed, never the whole message (PST-REQ-050). Bounded and
// idempotent like the summary sweep (PST-T-14.2): at most `limit` rows per call, each write
// conditional on to_count still being NULL, every batch that writes one audit row, and a row that
// can never be read (blob gone, undecryptable) given to_count 0 so it stops being a candidate.
import { recordAudit, type Actor } from '@postroom/audit';
import type { BlobStore } from '@postroom/blobstore';
import type { Db } from '@postroom/db';
import { permanentFailure } from '../sweep/summary-sweep.js';
import { blobHeaderReader } from '../training/headers.js';
import { toSummaryOfHeaders, type ToSummary } from './recipients.js';
import type { Log } from './types.js';

export { recipientSummary, toSummaryOfHeaders, type ToSummary } from './recipients.js';

// --- The backfill sweep -------------------------------------------------------------------------

export const DEFAULT_TO_SUMMARY_SWEEP_LIMIT = 200;
export const DEFAULT_TO_SUMMARY_SWEEP_GRACE_MS = 30_000;
export const DEFAULT_TO_SUMMARY_SWEEP_MS = 60_000;

const ACTOR: Actor = { kind: 'system', label: 'to-summary-sweep' };

export interface ToSummarySweepDeps {
  readonly db: Db;
  readonly blobs: Pick<BlobStore, 'get'>;
  readonly log: Log;
  readonly now: () => Date;
}

export interface ToSummarySweepOptions {
  /** At most this many candidate rows per call (default 200). */
  readonly limit?: number;
  /** Skip rows filed more recently than this, so the sweep never races a filing path (default 30s). */
  readonly graceMs?: number;
  /** Only rows whose id sorts after this one (the cursor a previous call returned as `lastId`). */
  readonly afterId?: string;
}

export interface ToSummarySweepResult {
  /** Candidate rows this call looked at (at most `limit`). */
  readonly scanned: number;
  /** Rows this call summarised. */
  readonly summarised: number;
  /** Candidates something else summarised first. */
  readonly skipped: number;
  /** Candidates that hit a transient failure (database, I/O pressure, KEK); retried next pass. */
  readonly failed: number;
  /** Candidates whose headers can never be read: given to_count 0 so they are not tried again. */
  readonly unavailable: number;
  /** The last id this call looked at; pass it back as `afterId`. */
  readonly lastId: string | null;
}

/** Summarise up to `limit` rows whose to_count is still NULL. Safe on an interval and concurrently. */
export async function sweepToSummaries(deps: ToSummarySweepDeps, options: ToSummarySweepOptions = {}): Promise<ToSummarySweepResult> {
  const limit = options.limit ?? DEFAULT_TO_SUMMARY_SWEEP_LIMIT;
  const graceMs = options.graceMs ?? DEFAULT_TO_SUMMARY_SWEEP_GRACE_MS;
  const cutoff = new Date(deps.now().getTime() - graceMs);
  const readHeaders = blobHeaderReader(deps.blobs);

  const candidates = await deps.db.message.findMany({
    where: { toCount: null, receivedAt: { lte: cutoff }, ...(options.afterId === undefined ? {} : { id: { gt: options.afterId } }) },
    select: { id: true, blobSha256: true },
    orderBy: { id: 'asc' },
    take: limit,
  });

  // Read outside any transaction: a blob read is I/O, and one bad row must not stop the rest.
  const computed: ({ id: string } & ToSummary)[] = [];
  const hopeless: { messageId: string; reason: string }[] = [];
  let failed = 0;
  for (const row of candidates) {
    try {
      computed.push({ id: row.id, ...toSummaryOfHeaders(await readHeaders(row.blobSha256)) });
    } catch (error) {
      const reason = permanentFailure(error);
      if (reason === null) {
        failed++;
        deps.log('to-summary-sweep-row-failed', { messageId: row.id, error: error instanceof Error ? error.message : String(error) });
      } else {
        hopeless.push({ messageId: row.id, reason });
        deps.log('to-summary-sweep-row-unavailable', { messageId: row.id, reason });
      }
    }
  }

  let summarised: string[] = [];
  let unavailable: string[] = [];
  if (computed.length > 0 || hopeless.length > 0) {
    [summarised, unavailable] = await deps.db.$transaction(async (tx) => {
      const done: string[] = [];
      for (const c of computed) {
        const n = await tx.message.updateMany({ where: { id: c.id, toCount: null }, data: { toName: c.toName, toCount: c.toCount } });
        if (n.count > 0) done.push(c.id);
      }
      if (done.length > 0) {
        await recordAudit(tx, {
          actor: ACTOR,
          action: 'message.to-summary-backfill',
          entityType: 'message',
          entityId: null,
          after: { count: done.length, messageIds: done },
        });
      }
      // to_count 0 is the "summarised" marker for a row we cannot read: it leaves the candidate set.
      const givenUp: { messageId: string; reason: string }[] = [];
      for (const h of hopeless) {
        const n = await tx.message.updateMany({ where: { id: h.messageId, toCount: null }, data: { toName: null, toCount: 0 } });
        if (n.count > 0) givenUp.push(h);
      }
      if (givenUp.length > 0) {
        await recordAudit(tx, {
          actor: ACTOR,
          action: 'message.to-summary-unavailable',
          entityType: 'message',
          entityId: null,
          after: { count: givenUp.length, messages: givenUp },
        });
      }
      return [done, givenUp.map((g) => g.messageId)];
    });
  }

  const result: ToSummarySweepResult = {
    scanned: candidates.length,
    summarised: summarised.length,
    skipped: computed.length + hopeless.length - summarised.length - unavailable.length,
    failed,
    unavailable: unavailable.length,
    lastId: candidates.at(-1)?.id ?? null,
  };
  if (result.scanned > 0) {
    deps.log('to-summary-sweep', { scanned: result.scanned, summarised: result.summarised, skipped: result.skipped, failed: result.failed, unavailable: result.unavailable });
  }
  return result;
}

/**
 * A sweeper that walks the candidates with a cursor: each call continues after the last row the
 * previous call looked at and starts over once a pass comes back short, so a row that keeps failing
 * is revisited once per pass, never ahead of everything else.
 */
export function createToSummarySweeper(deps: ToSummarySweepDeps, options: Omit<ToSummarySweepOptions, 'afterId'> = {}): () => Promise<ToSummarySweepResult> {
  const limit = options.limit ?? DEFAULT_TO_SUMMARY_SWEEP_LIMIT;
  let cursor: string | undefined;
  return async () => {
    const result = await sweepToSummaries(deps, { ...options, limit, ...(cursor === undefined ? {} : { afterId: cursor }) });
    cursor = result.scanned < limit || result.lastId === null ? undefined : result.lastId;
    return result;
  };
}

/** Run the sweeper until a pass comes back short (the backfill). Returns how many rows it summarised. */
export async function drainToSummaries(sweep: () => Promise<ToSummarySweepResult>, limit: number = DEFAULT_TO_SUMMARY_SWEEP_LIMIT): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await sweep();
    total += r.summarised;
    if (r.scanned < limit) return total;
  }
}

/**
 * The worker's to-summary loop, ready to start from main.ts: drains every row missing a to-summary
 * at start (the one-off backfill of mail filed before the columns existed), then keeps a batch on
 * `intervalMs` (env TO_SUMMARY_SWEEP_MS) for the filing paths that leave it to the sweep. Never two
 * runs at once. Returns the stop function for the daemon's shutdown hook.
 */
export function startToSummarySweep(deps: ToSummarySweepDeps & { readonly intervalMs?: number }): () => void {
  const sweep = createToSummarySweeper(deps);
  let running = false;
  const run = (drain: boolean): void => {
    if (running) return;
    running = true;
    (drain ? drainToSummaries(sweep) : sweep())
      .catch((err: unknown) => {
        deps.log('to-summary-sweep-error', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = false;
      });
  };
  run(true);
  const timer = setInterval(() => {
    run(false);
  }, deps.intervalMs ?? DEFAULT_TO_SUMMARY_SWEEP_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
