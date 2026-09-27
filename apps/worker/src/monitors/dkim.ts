// DKIM rotation stuck awaiting DNS (PST-T-4.13): a `pending` DkimKey (apps/submission's
// dkim-rotation.ts — created, TXT not yet seen with the matching p=, so `dnsVerifiedAt` is still
// null) is normal for a while after rotation kicks off, but one still pending after
// `maxAwaitingDays` (default 7) means the operator forgot to publish the record.
import type { Db } from '@postroom/db';
import type { Monitor } from './types.js';

export interface DkimMonitorOptions {
  readonly db: Db;
  readonly maxAwaitingDays?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_MAX_AWAITING_DAYS = 7;

export function createDkimMonitor(opts: DkimMonitorOptions): Monitor {
  const maxAwaitingDays = opts.maxAwaitingDays ?? DEFAULT_MAX_AWAITING_DAYS;
  const now = opts.now ?? ((): Date => new Date());

  return {
    name: 'dkim',
    check: async () => {
      const cutoff = new Date(now().getTime() - maxAwaitingDays * 86_400_000);
      const stuck: { domainId: string; selector: string; createdAt: Date }[] = await opts.db.dkimKey.findMany({
        where: { state: 'pending', dnsVerifiedAt: null, createdAt: { lt: cutoff } },
        select: { domainId: true, selector: true, createdAt: true },
      });

      if (stuck.length === 0) {
        return { ok: true, detail: 'no DKIM key awaiting DNS beyond the threshold' };
      }
      const oldest = stuck.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
      const ageDays = Math.round((now().getTime() - oldest.createdAt.getTime()) / 86_400_000);
      const names = stuck.map((k) => `${k.domainId}/${k.selector}`).join(', ');
      return {
        ok: false,
        detail: `${String(stuck.length)} DKIM key(s) awaiting DNS beyond ${String(maxAwaitingDays)}d (oldest ${String(ageDays)}d: ${names})`,
        value: { count: stuck.length, oldestDays: ageDays },
      };
    },
  };
}
