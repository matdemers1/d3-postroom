// What the worker reports on /health: how much inbound work is waiting and how old the oldest
// unfiled message is, so a stuck pipeline shows up before anyone notices missing mail.
import { InboundState, type Db } from '@postroom/db';
import { INBOUND_QUEUE } from './pipeline.js';

export interface InboundHealth {
  /** 'inbound' jobs pending or running. */
  queueDepth: number;
  /** 'inbound' jobs that spent their attempts (replayable from /api/admin/jobs). */
  deadJobs: number;
  /** Spool rows not yet filed (spooled or processing). */
  unfiled: number;
  /** Spool rows the pipeline gave up on. */
  failed: number;
  /** Seconds since the oldest unfiled message was received; null when nothing waits. */
  oldestSpooledAgeSeconds: number | null;
}

export async function inboundHealth(db: Db, now: Date = new Date()): Promise<InboundHealth> {
  const waiting = [InboundState.spooled, InboundState.processing];
  const [queueDepth, deadJobs, unfiled, failed, oldest] = await Promise.all([
    db.job.count({ where: { queue: INBOUND_QUEUE, status: { in: ['pending', 'running'] } } }),
    db.job.count({ where: { queue: INBOUND_QUEUE, status: 'dead' } }),
    db.inboundMessage.count({ where: { state: { in: waiting } } }),
    db.inboundMessage.count({ where: { state: InboundState.failed } }),
    db.inboundMessage.aggregate({ where: { state: { in: waiting } }, _min: { receivedAt: true } }),
  ]);
  const oldestAt = oldest._min.receivedAt;
  return {
    queueDepth,
    deadJobs,
    unfiled,
    failed,
    oldestSpooledAgeSeconds: oldestAt === null ? null : Math.max(0, Math.round((now.getTime() - oldestAt.getTime()) / 1000)),
  };
}
