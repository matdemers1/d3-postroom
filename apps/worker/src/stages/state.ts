// Reading and writing the per-message stage record: `InboundMessage.verdicts.pipeline`.
//
// Every write locks the spool row (SELECT … FOR UPDATE) and merges into the JSON it reads under
// that lock, so a marker written by one stage can never overwrite another's, and the smtp-in
// verdicts beside it (spf, dkim, dmarc, arc, decision, …) are never touched.
import type { Prisma } from '@postroom/db';
import {
  STAGES,
  isStageName,
  type Json,
  type PipelineRecord,
  type ReplayRecord,
  type StageMarker,
  type StageName,
} from './types.js';

type Tx = Prisma.TransactionClient;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The pipeline record inside a verdicts value; empty when there is none yet. */
export function readPipeline(verdicts: unknown): PipelineRecord {
  const raw = isObject(verdicts) ? verdicts['pipeline'] : undefined;
  const stages: Partial<Record<StageName, StageMarker>> = {};
  const replays: ReplayRecord[] = [];
  if (!isObject(raw)) return { stages, replays };
  const rawStages = raw['stages'];
  if (isObject(rawStages)) {
    for (const name of STAGES) {
      const m = rawStages[name];
      if (isObject(m) && typeof m['at'] === 'string') {
        stages[name] = { stage: name, at: m['at'], result: (m['result'] ?? null) as Json };
      }
    }
  }
  const rawReplays = raw['replays'];
  if (Array.isArray(rawReplays)) {
    for (const r of rawReplays) {
      if (isObject(r) && typeof r['jobId'] === 'string' && isStageName(r['fromStage']) && typeof r['at'] === 'string') {
        replays.push({ jobId: r['jobId'], fromStage: r['fromStage'], at: r['at'] });
      }
    }
  }
  return { stages, replays };
}

/** The pipeline with every marker from `fromStage` onward removed. Pure; the caller persists it. */
export function resetFrom(pipeline: PipelineRecord, fromStage: StageName): PipelineRecord {
  const cut = STAGES.indexOf(fromStage);
  const stages: Partial<Record<StageName, StageMarker>> = {};
  for (const [i, name] of STAGES.entries()) {
    const marker = pipeline.stages[name];
    if (i < cut && marker !== undefined) stages[name] = marker;
  }
  return { stages, replays: pipeline.replays };
}

/** The first stage without a marker, or null when every stage is done. */
export function firstIncomplete(pipeline: PipelineRecord): StageName | null {
  return STAGES.find((s) => pipeline.stages[s] === undefined) ?? null;
}

function withPipeline(verdicts: unknown, pipeline: PipelineRecord): Prisma.InputJsonValue {
  const base = isObject(verdicts) ? verdicts : {};
  return JSON.parse(JSON.stringify({ ...base, pipeline })) as Prisma.InputJsonValue;
}

/** Lock the spool row for the rest of `tx` and return its current verdicts. */
export async function lockInbound(tx: Tx, id: string): Promise<unknown> {
  const rows = await tx.$queryRaw<{ verdicts: unknown }[]>`
    SELECT verdicts FROM inbound_message WHERE id = ${id}::uuid FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) throw new Error(`inbound message ${id} does not exist`);
  return row.verdicts;
}

/** Record a stage's marker inside `tx` (the same transaction as the stage's own writes). */
export async function markStage(tx: Tx, id: string, stage: StageName, result: Json, at: Date): Promise<StageMarker> {
  const verdicts = await lockInbound(tx, id);
  const pipeline = readPipeline(verdicts);
  const marker: StageMarker = { stage, at: at.toISOString(), result };
  const next: PipelineRecord = { stages: { ...pipeline.stages, [stage]: marker }, replays: pipeline.replays };
  await tx.inboundMessage.update({ where: { id }, data: { verdicts: withPipeline(verdicts, next) } });
  return marker;
}

/**
 * Apply a replay request once: clear the markers from `fromStage` onward and remember `jobId`, in
 * one write. Returns false (and changes nothing) when this job's replay was already applied — the
 * job crashed after clearing and is being retried, and must resume, not start over.
 */
export async function applyReplay(tx: Tx, id: string, jobId: string, fromStage: StageName, at: Date): Promise<boolean> {
  const verdicts = await lockInbound(tx, id);
  const pipeline = readPipeline(verdicts);
  if (pipeline.replays.some((r) => r.jobId === jobId)) return false;
  const reset = resetFrom(pipeline, fromStage);
  const next: PipelineRecord = { stages: reset.stages, replays: [...pipeline.replays, { jobId, fromStage, at: at.toISOString() }] };
  await tx.inboundMessage.update({ where: { id }, data: { verdicts: withPipeline(verdicts, next) } });
  return true;
}
