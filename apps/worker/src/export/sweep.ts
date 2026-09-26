// Archives expire 24 h after they finish (PST-T-10.1, PST-REQ-151): this releases the blob (crypto-
// shred once its refcount hits zero) and deletes the `setting` row, so a download after expiry is a
// clean 404/410, never a stale pointer. Runs on an interval from apps/worker/src/main.ts, the same
// shape as the thread sweeper (apps/worker/src/sweep/thread-sweep.ts).
import type { BlobStore } from '@postroom/blobstore';
import type { Db } from '@postroom/db';
import { deleteExportResult, listExpiredExportResults } from './settings.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface ExportSweepDeps {
  db: Db;
  blobs: BlobStore;
  now?: () => Date;
  log?: Log;
}

/** Sweeps every export archive past its `expiresAt`. Returns how many were removed. */
export function createExportSweeper(deps: ExportSweepDeps): () => Promise<number> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  return async function sweepExpiredExports(): Promise<number> {
    const expired = await listExpiredExportResults(deps.db, now());
    for (const { exportId, result } of expired) {
      try {
        const release = await deps.blobs.release(result.archiveSha256);
        if (release.refcount === 0) await deps.blobs.reap(result.archiveSha256);
      } catch (error) {
        // The row is deleted regardless: a missing/already-gone blob must not wedge the sweep, and
        // gc() cleans up any orphan file left behind.
        log('export-sweep-blob-error', { exportId, error: error instanceof Error ? error.message : String(error) });
      }
      await deleteExportResult(deps.db, exportId);
      log('export-swept', { exportId, accountId: result.accountId });
    }
    return expired.length;
  };
}
