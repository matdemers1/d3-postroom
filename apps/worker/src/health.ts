// What the worker reports on /health: how much inbound work is waiting and how old the oldest
// unfiled message is, so a stuck pipeline shows up before anyone notices missing mail; and the
// last backup and restore drill (PST-T-0.16, PST-T-0.17), so a backup that stopped is seen too.
import { InboundState, type Db } from '@postroom/db';
import { readLastBackup, readLastDrill, type LastBackup, type LastDrill } from './backup/state.js';
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

export interface MaintenanceHealth {
  /** The last backup run (PST-REQ-022): when, how much, and whether it reached the bucket. */
  lastBackup: LastBackup | null;
  /** The last restore drill (PST-REQ-023): green or red, and why. */
  lastDrill: LastDrill | null;
}

export async function maintenanceHealth(db: Db): Promise<MaintenanceHealth> {
  const [lastBackup, lastDrill] = await Promise.all([readLastBackup(db), readLastDrill(db)]);
  return { lastBackup, lastDrill };
}
