// Type declarations for perf-seed.mjs (a plain JS operator tool with no build step), so the
// integration test that imports its exported `seedInbox` function typechecks under strict mode.
import type { Db } from '@postroom/db';

export const DEFAULT_COUNT: number;
export const DEFAULT_THREADS: number;
export const DEFAULT_SENDERS: number;
export const BUCKETS: readonly string[];
export const PERF_BLOB_SHA256: string;

export interface SeedInboxOptions {
  accountId: string;
  mailboxId: string;
  count?: number;
  threadCount?: number;
  senderCount?: number;
  force?: boolean;
}

export interface SeedInboxResult {
  inserted: number;
  threadCount: number;
  senderCount: number;
  blobSha256: string;
  uidStart: number;
  modseqStart: bigint;
}

export function seedInbox(db: Db, opts: SeedInboxOptions): Promise<SeedInboxResult>;
