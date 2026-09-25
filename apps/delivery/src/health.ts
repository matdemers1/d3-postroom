// What the delivery daemon reports on /health: how much is waiting and how long the oldest
// deferred recipient has been waiting, so a stuck queue shows up before a sender notices.
import type { Db } from '@postroom/db';
import { OUTBOUND_QUEUE } from './enqueue.js';

export interface DeliveryHealth {
  /** Outbound jobs pending or running. */
  queueDepth: number;
  /** Recipients waiting for their first or next attempt. */
  recipientsQueued: number;
  recipientsDeferred: number;
  recipientsAttempting: number;
  /** Seconds since the oldest deferred recipient was queued; null when nothing is deferred. */
  oldestDeferredAgeSeconds: number | null;
}

export async function deliveryHealth(db: Db, now: Date = new Date()): Promise<DeliveryHealth> {
  const [queueDepth, byState, oldest] = await Promise.all([
    db.job.count({ where: { queue: OUTBOUND_QUEUE, status: { in: ['pending', 'running'] } } }),
    db.outboundRecipient.groupBy({ by: ['state'], where: { state: { in: ['queued', 'deferred', 'attempting'] } }, _count: { _all: true } }),
    db.outboundRecipient.aggregate({ where: { state: 'deferred' }, _min: { createdAt: true } }),
  ]);
  const count = (state: string): number => byState.find((g) => g.state === state)?._count._all ?? 0;
  const oldestAt = oldest._min.createdAt;
  return {
    queueDepth,
    recipientsQueued: count('queued'),
    recipientsDeferred: count('deferred'),
    recipientsAttempting: count('attempting'),
    oldestDeferredAgeSeconds: oldestAt === null ? null : Math.max(0, Math.round((now.getTime() - oldestAt.getTime()) / 1000)),
  };
}
