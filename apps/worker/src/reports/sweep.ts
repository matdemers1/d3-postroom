// The report sweep (PST-T-7.1, PST-REQ-122): finds messages in the report mailboxes that have no
// report_ingest row yet, reads their report attachments, and stores the normalized rows.
//
// Why a sweep and not a pipeline stage: a report arrives by SMTP (the inbound pipeline), but it can
// also be APPENDed over IMAP, moved in from another folder, or filed by the e2e seed route — every
// one of those is "a message in the report mailbox". Keying on the filed message covers them all,
// with no edit to the six pipeline stages. The report_ingest row is the marker: a message is read
// once; a parse error is recorded (with its ReportError code) and not retried, while a database
// error leaves no marker and the next tick tries again.
import type { BlobStore } from '@postroom/blobstore';
import type { Db } from '@postroom/db';
import { ReportError, parseReportAttachment } from '@postroom/reports';
import { resolveReportMailboxes } from './config.js';
import { extractCandidates } from './extract.js';
import { storeMessageReports, type AttachmentOutcome, type MessageOutcome, type ParsedAttachment } from './store.js';

type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface ReportSweepDeps {
  readonly db: Db;
  readonly blobs: Pick<BlobStore, 'get'>;
  readonly env: NodeJS.ProcessEnv;
  readonly log?: Log;
  readonly batchSize?: number;
}

export interface SweptMessage {
  readonly messageId: string;
  readonly outcome: MessageOutcome;
  readonly results: readonly AttachmentOutcome[];
}

export interface ReportSweeper {
  /** One batch. Returns what was recorded by this call. */
  runOnce(): Promise<SweptMessage[]>;
  /** Batches until none is left. */
  drain(): Promise<SweptMessage[]>;
}

/** Parses one message's candidate attachments. Never throws for bad report bytes. */
export async function readMessageReports(blobs: Pick<BlobStore, 'get'>, blobSha256: string): Promise<ParsedAttachment[]> {
  const out: ParsedAttachment[] = [];
  for (const c of await extractCandidates(blobs, blobSha256)) {
    if (c.oversize) {
      out.push({ partId: c.partId, filename: c.filename, kind: 'error', code: 'too-large', message: 'attachment is over the size limit' });
      continue;
    }
    try {
      const parsed = parseReportAttachment(c);
      if (parsed === null) continue;
      out.push(parsed.kind === 'dmarc' ? { partId: c.partId, filename: c.filename, kind: 'dmarc', report: parsed.report } : { partId: c.partId, filename: c.filename, kind: 'tlsrpt', report: parsed.report });
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      out.push({ partId: c.partId, filename: c.filename, kind: 'error', code: error.code, message: error.message });
    }
  }
  return out;
}

export function createReportSweeper(deps: ReportSweepDeps): ReportSweeper {
  const log: Log = deps.log ?? (() => undefined);
  const batch = deps.batchSize ?? 20;

  const runOnce = async (): Promise<SweptMessage[]> => {
    const { mailboxIds } = await resolveReportMailboxes(deps.db, deps.env);
    if (mailboxIds.length === 0) return [];
    const rows = await deps.db.$queryRaw<{ id: string; blob_sha256: string }[]>`
      SELECT m.id::text AS id, m.blob_sha256
      FROM message m
      WHERE m.mailbox_id = ANY(${mailboxIds}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM report_ingest r WHERE r.message_id = m.id)
      ORDER BY m.received_at, m.id
      LIMIT ${batch}`;
    const swept: SweptMessage[] = [];
    for (const row of rows) {
      const parsed = await readMessageReports(deps.blobs, row.blob_sha256);
      const stored = await storeMessageReports(deps.db, row.id, parsed);
      if (stored === null) continue;
      swept.push({ messageId: row.id, ...stored });
      log('reports-ingest', { messageId: row.id, outcome: stored.outcome, attachments: stored.results.length });
    }
    return swept;
  };

  const drain = async (): Promise<SweptMessage[]> => {
    const all: SweptMessage[] = [];
    for (let i = 0; i < 1000; i++) {
      const done = await runOnce();
      all.push(...done);
      if (done.length === 0) break;
    }
    return all;
  };

  return { runOnce, drain };
}

export interface ReportLoop {
  readonly sweeper: ReportSweeper;
  stop(): Promise<void>;
}

/** Drains once at start, then on an interval. Errors are logged; the next tick retries. */
export function startReportLoop(deps: ReportSweepDeps & { intervalMs: number }): ReportLoop {
  const sweeper = createReportSweeper(deps);
  const log: Log = deps.log ?? (() => undefined);
  let running: Promise<void> | null = null;
  const tick = (): void => {
    if (running !== null) return;
    running = sweeper
      .drain()
      .then(() => undefined)
      .catch((err: unknown) => {
        log('reports-ingest-error', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, deps.intervalMs);
  return {
    sweeper,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
