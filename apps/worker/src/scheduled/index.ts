// The scheduled loop (PST-T-9.1): every tick (15 s by default, so a due send goes out within a
// minute, PST-REQ-141) it releases held sends that are due (undo send, scheduled send), returns
// snoozed conversations whose time has come, and checks remind-if-no-reply reminders. Each pass is
// idempotent and exactly-once per row (see release.ts, snooze.ts, remind.ts), so a tick that
// overlaps a crash, a restart or a second worker never sends or moves anything twice.
import type { BlobStore } from '@postroom/blobstore';
import type { Kek } from '@postroom/crypto';
import type { Db } from '@postroom/db';
import { releaseDue, type ReleaseDeps, type WebmailCaps } from './release.js';
import { checkDue } from './remind.js';
import { returnDue } from './snooze.js';

export { releaseDue, releaseOne, type ReleaseDeps, type ReleaseOutcome } from './release.js';
export { returnDue, returnOne } from './snooze.js';
export { checkDue, checkOne, hasReply, REMIND_FLAGS } from './remind.js';

export const DEFAULT_SCHEDULED_TICK_MS = 15_000;

export interface ScheduledLoopOptions {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly kek: () => Kek;
  readonly caps: WebmailCaps;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** One pass of all three. */
export async function runScheduledOnce(o: ScheduledLoopOptions): Promise<{ released: number; returned: number; resurfaced: number }> {
  const now = o.now ?? ((): Date => new Date());
  const deps: ReleaseDeps = { db: o.db, blobs: o.blobs, kek: o.kek, caps: o.caps, now, ...(o.log === undefined ? {} : { log: o.log }) };
  const sent = await releaseDue(deps);
  const returned = await returnDue({ db: o.db, now, ...(o.log === undefined ? {} : { log: o.log }) });
  const reminders = await checkDue({ db: o.db, now, ...(o.log === undefined ? {} : { log: o.log }) });
  return { released: sent.released, returned, resurfaced: reminders.resurfaced };
}

export function startScheduledLoop(o: ScheduledLoopOptions): { stop: () => Promise<void> } {
  let running: Promise<void> = Promise.resolve();
  let busy = false;
  const tick = (): void => {
    if (busy) return;
    busy = true;
    running = runScheduledOnce(o)
      .then((r) => {
        if (r.released + r.returned + r.resurfaced > 0) o.log?.('scheduled-pass', r);
      })
      .catch((err: unknown) => {
        o.log?.('scheduled-error', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        busy = false;
      });
  };
  tick();
  const timer = setInterval(tick, o.intervalMs ?? DEFAULT_SCHEDULED_TICK_MS);
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
