// Outbound delivery health (PST-T-4.13, PST-REQ-183): fires when permanent failures (`bounced`
// DeliveryAttempt rows — RFC 5xx, no further retry) exceed 20% of at least 10 attempts in the last
// hour, or when an SES attempt hits an account-level refusal rather than a per-message rejection —
// a full send quota, a paused/suspended account, or 454 throttling that has been going on for at
// least 15 minutes (a single throttled attempt is normal backpressure, not an incident).
import type { Db } from '@postroom/db';
import type { Monitor } from './types.js';

const WINDOW_MS = 3_600_000;
const THROTTLE_SUSTAINED_MS = 15 * 60_000;
const PERMANENT_RATE_THRESHOLD = 0.2;
const MIN_ATTEMPTS = 10;

export interface DeliveryMonitorOptions {
  readonly db: Db;
  readonly now?: (() => Date) | undefined;
}

interface AttemptRow {
  readonly outcome: string;
  readonly transport: string;
  readonly remoteCode: number | null;
  readonly remoteText: string | null;
  readonly startedAt: Date;
}

export type SesRefusalKind = 'account' | 'throttling';

/** An SES attempt's remote reply, classified as an account-level refusal (not a per-recipient
 * rejection) — quota exhausted, the account paused/suspended, or sustained 454 throttling. Matches
 * the reply text SES actually sends; anything else (a per-recipient bounce relayed through SES) is
 * `null`. */
export function classifySesRefusal(attempt: Pick<AttemptRow, 'remoteCode' | 'remoteText'>): SesRefusalKind | null {
  const text = attempt.remoteText ?? '';
  if (attempt.remoteCode === 454 && /throttl/i.test(text)) return 'throttling';
  if (/account[^.]*\b(paused|suspended)\b/i.test(text)) return 'account';
  if (/sending suspended/i.test(text)) return 'account';
  if (/quota[-\s]?exceeded/i.test(text)) return 'account';
  return null;
}

export function createDeliveryMonitor(opts: DeliveryMonitorOptions): Monitor {
  const now = opts.now ?? ((): Date => new Date());

  return {
    name: 'delivery',
    check: async () => {
      const since = new Date(now().getTime() - WINDOW_MS);
      const attempts: AttemptRow[] = await opts.db.deliveryAttempt.findMany({
        where: { startedAt: { gte: since } },
        select: { outcome: true, transport: true, remoteCode: true, remoteText: true, startedAt: true },
      });

      const total = attempts.length;
      const permanent = attempts.filter((a) => a.outcome === 'bounced').length;
      const permanentRate = total > 0 ? permanent / total : 0;
      const rateFiring = total >= MIN_ATTEMPTS && permanentRate > PERMANENT_RATE_THRESHOLD;

      const sesRefusals = attempts.filter((a) => a.transport === 'ses').map((a) => ({ ...a, refusal: classifySesRefusal(a) }));
      const accountRefusal = sesRefusals.find((a) => a.refusal === 'account');

      const throttling = sesRefusals.filter((a) => a.refusal === 'throttling').sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      // The first attempt of a run that has been throttling for at least THROTTLE_SUSTAINED_MS, or
      // null when there is no such run — a single throttled attempt, or a short-lived one, is normal
      // backpressure and never fires on its own.
      const sustainedThrottleStart = ((): (typeof throttling)[number] | null => {
        const first = throttling[0];
        const last = throttling[throttling.length - 1];
        if (first === undefined || last === undefined) return null;
        return last.startedAt.getTime() - first.startedAt.getTime() >= THROTTLE_SUSTAINED_MS ? first : null;
      })();

      const rateDetail = `${String(permanent)}/${String(total)} permanent in the last hour (${(permanentRate * 100).toFixed(1)}%)`;

      if (accountRefusal !== undefined) {
        return {
          ok: false,
          detail: `SES account-level refusal: ${String(accountRefusal.remoteCode)} ${accountRefusal.remoteText ?? ''}`.trim(),
          value: { total, permanent, accountRefusal: true },
        };
      }
      if (sustainedThrottleStart !== null) {
        const sinceFirst = Math.round((now().getTime() - sustainedThrottleStart.startedAt.getTime()) / 1000);
        return {
          ok: false,
          detail: `SES throttling (454) sustained for ${String(sinceFirst)}s across ${String(throttling.length)} attempts`,
          value: { total, permanent, throttling: throttling.length },
        };
      }
      if (rateFiring) {
        return { ok: false, detail: rateDetail, value: { total, permanent } };
      }
      return { ok: true, detail: rateDetail, value: { total, permanent } };
    },
  };
}
