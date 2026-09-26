// The inbound pipeline (PST-T-2.7, PST-REQ-060, PST-REQ-061): turns every spooled InboundMessage
// into filed Messages, exactly once, however often it is crashed, retried or replayed.
//
// One 'inbound' job per spool row (smtp-in enqueues it in the transaction that answers 250). The
// job runs the stages in order (see stages/types.ts), skipping each stage whose marker is already
// recorded. So:
//   · kill -9 anywhere → the claim's lease expires, the job runs again, and resumes at the first
//     stage without a marker; the file stage's own transaction commits copies and marker together;
//   · an exception → the queue retries with backoff; after `maxAttempts` the job goes `dead` and the
//     spool row `failed` with its lastError — visible on /api/admin/jobs, replayable from there;
//   · a replay → markers from a stage onward are cleared and the stages run again, producing the
//     same results and no second copy (the file stage finds its copies and files nothing).
//
// State on the spool row: spooled → processing (a job is working on it) → filed; or failed.
import { randomUUID } from 'node:crypto';
import type { BlobStore } from '@postroom/blobstore';
import { InboundState, type Db, type InboundMessage, type Job, type Prisma } from '@postroom/db';
import { enqueue, type Handler } from '@postroom/queue';
import { classifyStage } from './stages/classify.js';
import { fileStage, parseRecipients } from './stages/file.js';
import { notifyStage } from './stages/notify.js';
import { parseStage } from './stages/parse.js';
import { sieveStage } from './stages/sieve.js';
import { applyReplay, markStage, readPipeline } from './stages/state.js';
import {
  STAGES,
  isStageName,
  type ClassifyResult,
  type FileResult,
  type InboundJobPayload,
  type Json,
  type Log,
  type ParseResult,
  type PipelineFaults,
  type SieveResult,
  type StageDeps,
  type StageInput,
  type StageName,
  type VerifyResult,
} from './stages/types.js';
import { verifyStage } from './stages/verify.js';

/** The queue smtp-in feeds (apps/smtp-in/src/data.ts INBOUND_QUEUE). */
export const INBOUND_QUEUE = 'inbound';

export interface PipelineOptions {
  db: Db;
  blobs: BlobStore;
  log?: Log;
  now?: () => Date;
  faults?: PipelineFaults;
}

export interface RunOptions {
  /** The job running this pipeline, so a replay request is applied once per job. */
  jobId?: string;
  replayFrom?: StageName;
}

export interface RunResult {
  inboundMessageId: string;
  /** Stages that ran in this call (the others were already recorded). */
  ran: StageName[];
  state: InboundState;
}

export interface InboundPipeline {
  /** The 'inbound' queue handler. */
  handle: Handler;
  /** Run the stages for one spool row directly (tests; the handler calls this). */
  run: (inboundMessageId: string, options?: RunOptions) => Promise<RunResult>;
}

export function parsePayload(payload: unknown): InboundJobPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('inbound job payload is not an object');
  const p = payload as Record<string, unknown>;
  const id = p['inboundMessageId'];
  if (typeof id !== 'string' || id === '') throw new Error('inbound job payload has no inboundMessageId');
  const replayFrom = p['replayFrom'];
  if (replayFrom !== undefined && !isStageName(replayFrom)) throw new Error(`inbound job payload names an unknown stage: ${JSON.stringify(replayFrom)}`);
  return replayFrom === undefined ? { inboundMessageId: id } : { inboundMessageId: id, replayFrom };
}

function need(results: Partial<Record<StageName, Json>>, stage: StageName): Json {
  const r = results[stage];
  if (r === undefined) throw new Error(`stage "${stage}" has no recorded result`);
  return r;
}

export function createInboundPipeline(options: PipelineOptions): InboundPipeline {
  const { db, blobs } = options;
  const log = options.log ?? ((): void => undefined);
  const now = options.now ?? ((): Date => new Date());
  const deps: StageDeps = { db, blobs, log, now, ...(options.faults === undefined ? {} : { faults: options.faults }) };

  const record = async (id: string, stage: StageName, result: Json): Promise<void> => {
    await db.$transaction(async (tx) => {
      await markStage(tx, id, stage, result, now());
    });
  };

  const runStage = async (stage: StageName, input: StageInput): Promise<Json> => {
    const { inbound, results } = input;
    switch (stage) {
      case 'verify': {
        const r = verifyStage(input);
        await record(inbound.id, stage, r);
        return r;
      }
      case 'parse': {
        const r = await parseStage(input, blobs);
        await record(inbound.id, stage, r);
        return r;
      }
      case 'classify': {
        const accountIds = [...new Set(parseRecipients(inbound.recipients).flatMap((r) => r.accountIds))];
        const r: ClassifyResult = await classifyStage(input, { db, blobs }, {
          verify: need(results, 'verify') as unknown as VerifyResult,
          parse: need(results, 'parse') as unknown as ParseResult,
          accountIds,
        });
        await record(inbound.id, stage, r);
        return r;
      }
      case 'sieve': {
        const r = sieveStage();
        await record(inbound.id, stage, r);
        return r;
      }
      case 'file':
        // Writes its marker inside its own transaction, with the copies.
        return fileStage(input, deps, {
          parse: need(results, 'parse') as unknown as ParseResult,
          classify: need(results, 'classify') as unknown as ClassifyResult,
          sieve: need(results, 'sieve') as unknown as SieveResult,
          recipients: parseRecipients(inbound.recipients),
        });
      case 'notify': {
        const r = await notifyStage(db, need(results, 'file') as unknown as FileResult);
        await record(inbound.id, stage, r);
        return r;
      }
    }
  };

  const load = async (id: string): Promise<InboundMessage> => {
    const row = await db.inboundMessage.findUnique({ where: { id } });
    if (row === null) throw new Error(`inbound message ${id} does not exist`);
    return row;
  };

  const run = async (id: string, runOptions: RunOptions = {}): Promise<RunResult> => {
    let inbound = await load(id);
    if (inbound.state === InboundState.rejected) {
      // Refused at DATA: smtp-in already filed the Rejects copies. Nothing to do, and say so.
      log('inbound-skip-rejected', { inboundMessageId: id });
      return { inboundMessageId: id, ran: [], state: inbound.state };
    }
    const { replayFrom, jobId } = runOptions;
    if (replayFrom !== undefined) {
      const applied = await db.$transaction((tx) => applyReplay(tx, id, jobId ?? `direct-${randomUUID()}`, replayFrom, now()));
      if (applied) log('inbound-replay', { inboundMessageId: id, fromStage: replayFrom, jobId });
    }
    if (inbound.state !== InboundState.processing) {
      await db.inboundMessage.update({ where: { id }, data: { state: InboundState.processing } });
    }

    const ran: StageName[] = [];
    for (const stage of STAGES) {
      inbound = await load(id);
      const pipeline = readPipeline(inbound.verdicts);
      if (pipeline.stages[stage] !== undefined) continue;
      await options.faults?.beforeStage?.(stage, id);
      const results: Partial<Record<StageName, Json>> = {};
      for (const s of STAGES) {
        const m = pipeline.stages[s];
        if (m !== undefined) results[s] = m.result;
      }
      const blob = await db.blob.findUnique({ where: { sha256: inbound.blobSha256 }, select: { sha256: true, size: true, refcount: true } });
      await runStage(stage, { inbound, blob, results });
      ran.push(stage);
    }
    await db.inboundMessage.update({ where: { id }, data: { state: InboundState.filed, lastError: null } });
    log('inbound-filed', { inboundMessageId: id, ran });
    return { inboundMessageId: id, ran, state: InboundState.filed };
  };

  const handle: Handler = async (job: Job) => {
    const payload = parsePayload(job.payload);
    try {
      await run(payload.inboundMessageId, { jobId: job.id, ...(payload.replayFrom === undefined ? {} : { replayFrom: payload.replayFrom }) });
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const lastAttempt = job.attempts >= job.maxAttempts;
      // Visible either way: the error on the spool row, and `failed` once the queue gives up.
      await db.inboundMessage.updateMany({
        where: { id: payload.inboundMessageId, state: { not: InboundState.filed } },
        data: { lastError: message.slice(0, 4000), ...(lastAttempt ? { state: InboundState.failed } : {}) },
      });
      log('inbound-error', { inboundMessageId: payload.inboundMessageId, jobId: job.id, attempts: job.attempts, lastAttempt, error: message });
      throw error;
    }
  };

  return { handle, run };
}

export interface ReplayRequest {
  fromStage: StageName;
}

/** The idempotency key of a replay job: unique per request, so each replay really runs. */
export function replayJobKey(inboundMessageId: string, fromStage: StageName): string {
  return `inbound:${inboundMessageId}:replay:${fromStage}:${randomUUID()}`;
}

/**
 * Ask for the stages from `fromStage` onward to run again for one spool row: enqueues an 'inbound'
 * job carrying `replayFrom`; the worker clears the markers when it picks the job up. Returns the job.
 */
export async function replayInbound(db: Db | Prisma.TransactionClient, inboundMessageId: string, request: ReplayRequest): Promise<Job> {
  if (!isStageName(request.fromStage)) throw new Error(`unknown stage: ${String(request.fromStage)}`);
  const row = await db.inboundMessage.findUnique({ where: { id: inboundMessageId }, select: { state: true } });
  if (row === null) throw new Error(`inbound message ${inboundMessageId} does not exist`);
  if (row.state === InboundState.rejected) throw new Error(`inbound message ${inboundMessageId} was rejected at DATA; it has no pipeline to replay`);
  const payload: InboundJobPayload = { inboundMessageId, replayFrom: request.fromStage };
  const job = await enqueue(db, INBOUND_QUEUE, { ...payload }, { idempotencyKey: replayJobKey(inboundMessageId, request.fromStage) });
  if (job === null) throw new Error('replay job was not enqueued');
  return job;
}
