// Queue backlog (PST-REQ-097): the outbound queue's pending jobs (apps/delivery's `outbound` queue)
// plus inbound's unfiled spool (apps/worker's own pipeline, already read by `inboundHealth`), firing
// when either the combined count or the oldest waiting item's age crosses its threshold.
import type { Db } from '@postroom/db';
import { InboundState } from '@postroom/db';
import type { Monitor } from './types.js';

/** apps/delivery/src/enqueue.ts's OUTBOUND_QUEUE — a plain queue name, not worth a cross-app import. */
const OUTBOUND_QUEUE = 'outbound';

export interface BacklogMonitorOptions {
  readonly db: Db;
  readonly threshold?: number | undefined;
  readonly maxAgeS?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_THRESHOLD = 500;
const DEFAULT_MAX_AGE_S = 3600;

export function createBacklogMonitor(opts: BacklogMonitorOptions): Monitor {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxAgeS = opts.maxAgeS ?? DEFAULT_MAX_AGE_S;
  const now = opts.now ?? ((): Date => new Date());
  const waitingInbound = [InboundState.spooled, InboundState.processing];

  return {
    name: 'backlog',
    check: async () => {
      const [outboundPending, oldestOutbound, inboundUnfiled, oldestInbound] = await Promise.all([
        opts.db.job.count({ where: { queue: OUTBOUND_QUEUE, status: { in: ['pending', 'running'] } } }),
        opts.db.job.aggregate({ where: { queue: OUTBOUND_QUEUE, status: { in: ['pending', 'running'] } }, _min: { createdAt: true } }),
        opts.db.inboundMessage.count({ where: { state: { in: waitingInbound } } }),
        opts.db.inboundMessage.aggregate({ where: { state: { in: waitingInbound } }, _min: { receivedAt: true } }),
      ]);
      const nowMs = now().getTime();
      const ages = [oldestOutbound._min.createdAt, oldestInbound._min.receivedAt]
        .filter((d): d is Date => d !== null)
        .map((d) => Math.max(0, (nowMs - d.getTime()) / 1000));
      const oldestAgeS = ages.length > 0 ? Math.max(...ages) : 0;
      const total = outboundPending + inboundUnfiled;
      const ok = total <= threshold && oldestAgeS <= maxAgeS;
      return {
        ok,
        detail: `outbound=${String(outboundPending)} inbound=${String(inboundUnfiled)} oldest=${String(Math.round(oldestAgeS))}s (threshold ${String(threshold)}, max age ${String(maxAgeS)}s)`,
        value: { outboundPending, inboundUnfiled, oldestAgeS },
      };
    },
  };
}
