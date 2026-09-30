// Composer uploads expire (PST-T-15.10, PST-REQ-195, PST-ADR-013): a compose_upload row untouched
// for 24 h — never attached, or its draft abandoned — is deleted and its blob reference released
// (crypto-shred when it was the last one, the file reaped after the commit). Runs on an interval
// from apps/worker/src/main.ts, the same shape as the export sweep.
//
// This never loses mail: a send, a held send and a draft each build their own message blob with
// the file's bytes inside it, so the upload's blob is only ever the composer's working copy.
// Reopening a draft registers its attachments as uploads again.
//
// Each row goes in its own transaction, conditional on last_used_at still being past the cutoff, so
// a send or a draft save that touched it after it was listed wins, and the upload stays.
import { recordAudit, type Actor } from '@postroom/audit';
import { BlobNotFoundError, type BlobStore } from '@postroom/blobstore';
import type { Db } from '@postroom/db';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** 24 hours, unless COMPOSE_UPLOAD_MAX_AGE_MS says otherwise. */
export const DEFAULT_UPLOAD_MAX_AGE_MS = 24 * 3_600_000;
const BATCH = 200;
const ACTOR: Actor = { kind: 'system', label: 'compose-upload-sweep' };
const TX_OPTIONS = { maxWait: 30_000, timeout: 60_000 } as const;

export interface UploadSweepDeps {
  db: Db;
  blobs: BlobStore;
  /** How long an upload may sit unused. */
  maxAgeMs?: number;
  now?: () => Date;
  log?: Log;
}

export interface UploadSweepResult {
  /** Upload rows deleted. */
  released: number;
  /** Blobs whose last reference that was (shredded, and their file reaped). */
  shredded: number;
}

/** Sweeps every upload unused for longer than `maxAgeMs`. */
export function createUploadSweeper(deps: UploadSweepDeps): () => Promise<UploadSweepResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_UPLOAD_MAX_AGE_MS;
  return async function sweepUploads(): Promise<UploadSweepResult> {
    const cutoff = new Date(now().getTime() - maxAgeMs);
    const result: UploadSweepResult = { released: 0, shredded: 0 };
    const skipped = new Set<string>();
    for (;;) {
      const rows = await deps.db.composeUpload.findMany({
        where: { lastUsedAt: { lt: cutoff }, ...(skipped.size === 0 ? {} : { id: { notIn: [...skipped] } }) },
        orderBy: { lastUsedAt: 'asc' },
        take: BATCH,
        select: { id: true, accountId: true, blobSha256: true, filename: true, size: true, lastUsedAt: true },
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          const outcome = await deps.db.$transaction(async (tx) => {
            const gone = await tx.composeUpload.deleteMany({ where: { id: row.id, lastUsedAt: { lt: cutoff } } });
            if (gone.count === 0) return null; // touched (or deleted) since it was listed
            let refcount: number | null = null;
            try {
              refcount = (await deps.blobs.release(row.blobSha256, tx)).refcount;
            } catch (error) {
              // A blob row already gone has nothing to release; the upload row still goes.
              if (!(error instanceof BlobNotFoundError)) throw error;
            }
            await recordAudit(tx, {
              actor: ACTOR,
              action: 'compose.upload.expire',
              entityType: 'compose_upload',
              entityId: row.id,
              before: { accountId: row.accountId, filename: row.filename, size: row.size, blobSha256: row.blobSha256, lastUsedAt: row.lastUsedAt.toISOString() },
              after: null,
            });
            return { refcount };
          }, TX_OPTIONS);
          if (outcome === null) {
            skipped.add(row.id);
            continue;
          }
          result.released += 1;
          if (outcome.refcount === 0) {
            // The file goes after the commit (the blob store's contract); gc() covers a crash here.
            await deps.blobs.reap(row.blobSha256);
            result.shredded += 1;
          }
        } catch (error) {
          // One bad row (a blob row already gone) must not wedge the sweep; it is retried next run.
          skipped.add(row.id);
          log('upload-sweep-error', { uploadId: row.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    if (result.released > 0 || skipped.size > 0) log('upload-sweep', { released: result.released, shredded: result.shredded, skipped: skipped.size, cutoff: cutoff.toISOString() });
    return result;
  };
}
