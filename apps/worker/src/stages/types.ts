// The inbound pipeline's shared shapes (PST-T-2.7, PST-REQ-061).
//
// Every spooled InboundMessage runs through six stages, in order, as ONE 'inbound' job:
//
//   verify → parse → classify → sieve → file → notify
//
// Each stage leaves a marker `{ stage, at, result }` under `InboundMessage.verdicts.pipeline.stages`
// (no new column: the spool row's verdicts JSON already holds every decision's reasons). A stage
// whose marker exists is skipped, so a job that crashed between stages resumes at the first stage
// without one. A replay deletes the markers from a chosen stage onward and runs the job again; the
// stages are written so that running one twice produces the same result and never a second copy.
//
// The job payload contract (the API's replay endpoint writes it too — keep the two in step):
//   { inboundMessageId: string, replayFrom?: StageName }
// `replayFrom` is applied once per job id: the job id is appended to `pipeline.replays` in the
// same transaction that clears the markers, so a retried replay job does not clear them again.
import type { Blob as BlobRow, Db, InboundMessage, Prisma } from '@postroom/db';
import type { BlobStore } from '@postroom/blobstore';

export const STAGES = ['verify', 'parse', 'classify', 'sieve', 'file', 'notify'] as const;
export type StageName = (typeof STAGES)[number];

export function isStageName(value: unknown): value is StageName {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface StageMarker {
  readonly stage: StageName;
  /** ISO time the stage's result was committed. */
  readonly at: string;
  readonly result: Json;
}

export interface ReplayRecord {
  readonly jobId: string;
  readonly fromStage: StageName;
  readonly at: string;
}

export interface PipelineRecord {
  readonly stages: Partial<Record<StageName, StageMarker>>;
  readonly replays: readonly ReplayRecord[];
}

export interface InboundJobPayload {
  readonly inboundMessageId: string;
  readonly replayFrom?: StageName;
}

/** One RCPT as smtp-in resolved it (apps/smtp-in/src/data.ts writes these). */
export interface SpooledRecipient {
  readonly rcpt: string;
  readonly address: string;
  readonly accountIds: readonly string[];
  readonly kind: string;
  readonly tag?: string;
  readonly siteTag?: string;
}

export interface VerifyResult {
  readonly disposition: 'accept' | 'quarantine';
  readonly present: string[];
  readonly missing: string[];
  readonly blob: { readonly sha256: string; readonly size: number };
  readonly reasons: string[];
  readonly [key: string]: Json;
}

export interface AttachmentBrief {
  readonly partId: string;
  readonly filename: string | null;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  readonly [key: string]: Json;
}

export interface ParseResult {
  readonly messageId: string | null;
  readonly subject: string | null;
  readonly fromAddress: string | null;
  /** Every address in the To header, comma-joined; null when the header was missing or empty. */
  readonly toAddress: string | null;
  /** ISO, or null when the Date header was missing or unparseable. */
  readonly sentAt: string | null;
  readonly inReplyTo: string[];
  readonly references: string[];
  readonly hasText: boolean;
  readonly hasHtml: boolean;
  /** The text/plain part, or the html part as text when there is no text/plain (PST-T-3.13): what
   * the file stage indexes into MessageSearch. Capped at 256 KiB on a UTF-8 boundary; '' when the
   * message has neither part. */
  readonly bodyText: string;
  readonly attachments: AttachmentBrief[];
  readonly warnings: number;
  readonly [key: string]: Json;
}

/** Where a copy is filed (PST-REQ-101): INBOX's Priority/People halves, a bucket folder, or Junk. */
export type Bucket = 'priority' | 'people' | 'newsletters' | 'updates' | 'receipts' | 'notifications' | 'junk';

/** One recipient account's sorting decision (PST-T-5.1): each account has its own reply graph and model. */
export interface AccountDecision {
  readonly bucket: Bucket;
  /** The mailbox this account's copy goes to ('INBOX', 'Newsletters', ..., or the Junk mailbox). */
  readonly mailbox: string;
  /** $Priority or $People for an INBOX copy; null otherwise. */
  readonly keyword: string | null;
  /** Every signal and rule that produced the decision (PST-REQ-103); never empty. */
  readonly reasons: string[];
  readonly scores: { readonly [key: string]: number };
  readonly [key: string]: Json;
}

export interface AttachmentFindingJson {
  readonly partId: string;
  readonly filename: string | null;
  readonly verdict: 'ok' | 'quarantine';
  readonly kind: string;
  readonly reasons: string[];
  readonly [key: string]: Json;
}

export interface ClassifyResult {
  /** 'junk' when a junk rule (quarantine, dangerous attachment) decided for every account; else
   * 'sorted', and each account's bucket is in `accounts`. */
  readonly bucket: 'junk' | 'sorted';
  /** Per recipient account, keyed by account id. */
  readonly accounts: { readonly [accountId: string]: AccountDecision };
  readonly senderHasHistory: boolean;
  readonly attachmentQuarantine: boolean;
  readonly attachments: AttachmentFindingJson[];
  readonly reasons: string[];
  readonly [key: string]: Json;
}

export interface SieveResult {
  readonly applied: boolean;
  readonly reasons: string[];
  readonly [key: string]: Json;
}

export interface FiledCopy {
  readonly accountId: string;
  readonly mailboxId: string;
  readonly mailbox: string;
  readonly messageId: string;
  readonly uid: number;
  /** False when this run found the copy already filed (a replay or a resumed crash). */
  readonly created: boolean;
  readonly keywords: string[];
  /** The bucket this copy was filed into (for a copy found already filed: the one it was filed with). */
  readonly bucket: Bucket | null;
  readonly [key: string]: Json;
}

export interface FileResult {
  readonly bucket: 'junk' | 'sorted';
  readonly copies: FiledCopy[];
  readonly created: number;
  readonly [key: string]: Json;
}

export interface NotifyResult {
  readonly mailboxes: string[];
  readonly [key: string]: Json;
}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface PipelineFaults {
  /** Runs before a stage starts (the kill -9 test parks the child here). */
  readonly beforeStage?: (stage: StageName, inboundMessageId: string) => Promise<void>;
  /** Runs inside the file stage's transaction, after the copies are written, before the commit. */
  readonly inFileTransaction?: (tx: Prisma.TransactionClient, inboundMessageId: string) => Promise<void>;
}

export interface StageDeps {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly log: Log;
  readonly now: () => Date;
  readonly faults?: PipelineFaults;
}

/** What a stage sees: the spool row and the results of the stages before it. */
export interface StageInput {
  readonly inbound: InboundMessage;
  readonly blob: Pick<BlobRow, 'sha256' | 'size' | 'refcount'> | null;
  readonly results: Partial<Record<StageName, Json>>;
}
