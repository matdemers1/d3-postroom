// The per-recipient outbound state machine (PST-T-1.5), as pure functions so the schedule and the
// DSN rules can be tested without a database or a clock:
//
//   queued ──► attempting ──► delivered                  (2xx)
//                  │     └──► bounced                    (5xx, or still failing 5 days after queueing)
//                  └────────► deferred ──► attempting    (4xx, connect failure, timeout, DNS SERVFAIL)
//   queued | deferred ──► cancelled                      (undo / admin)
//
// The retry schedule is fixed and documented rather than exponential-to-a-cap, because the delay
// DSN at 4 hours and the bounce at 5 days are promises to the sender, and a reader should be able
// to work out from this table when the next attempt will happen.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Delay after the Nth failed attempt (index 0 = after the first attempt). After the table runs out
 * every further retry is `retrySchedule.at(-1)` (4 hours) until the recipient is 5 days old.
 */
export const retrySchedule: readonly number[] = [
  5 * MINUTE,
  10 * MINUTE,
  20 * MINUTE,
  40 * MINUTE,
  1 * HOUR,
  2 * HOUR,
  3 * HOUR,
  4 * HOUR,
];

/** Each delay is scaled by a uniform factor in [1 - JITTER, 1 + JITTER), so a burst does not retry as one. */
export const JITTER = 0.15;
/** A recipient still failing this long after it was queued is bounced (RFC 5321 §4.5.4.1 suggests 4–5 days). */
export const MAX_QUEUE_AGE_MS = 5 * DAY;
/** A recipient still deferred this long after it was queued gets one delay DSN (if NOTIFY allows DELAY). */
export const DELAY_DSN_AFTER_MS = 4 * HOUR;

/** The un-jittered delay after `attempts` failed attempts (attempts ≥ 1). */
export function baseDelayMs(attempts: number): number {
  const last = retrySchedule[retrySchedule.length - 1] ?? 4 * HOUR;
  if (attempts < 1) return retrySchedule[0] ?? last;
  return retrySchedule[attempts - 1] ?? last;
}

/** A jittered delay: `base * (1 + JITTER * (2r - 1))` for r in [0, 1). */
export function jitteredDelayMs(attempts: number, random: () => number = Math.random): number {
  const base = baseDelayMs(attempts);
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.round(base * (1 + JITTER * (2 * r - 1)));
}

// ─── DSN NOTIFY (RFC 3461 §4.1) ─────────────────────────────────────────────

export interface NotifyPolicy {
  success: boolean;
  failure: boolean;
  delay: boolean;
}

/**
 * Parse a NOTIFY value. Null or blank is the RFC's default for a recipient with no NOTIFY: FAILURE
 * and (at the MTA's discretion, which we exercise) DELAY. NEVER turns every DSN off. Unknown
 * keywords are ignored rather than thrown: the submission server validated the parameter already.
 */
export function parseNotify(value: string | null | undefined): NotifyPolicy {
  if (value === null || value === undefined || value.trim() === '') return { success: false, failure: true, delay: true };
  const words = new Set(value.toUpperCase().split(',').map((w) => w.trim()));
  if (words.has('NEVER')) return { success: false, failure: false, delay: false };
  return { success: words.has('SUCCESS'), failure: words.has('FAILURE'), delay: words.has('DELAY') };
}

// ─── Transitions ────────────────────────────────────────────────────────────

/** What one attempt said about one recipient. Connect failure, timeout and DNS SERVFAIL are `error`, i.e. temporary. */
export type AttemptOutcome =
  | { kind: 'delivered'; code?: number; enhanced?: string; text?: string }
  | { kind: 'temporary'; code?: number; enhanced?: string; text?: string }
  | { kind: 'permanent'; code: number; enhanced?: string; text: string }
  | { kind: 'error'; error: string };

/** The fields of an OutboundRecipient the machine needs. `attempts` includes the attempt just made. */
export interface RecipientSnapshot {
  id: string;
  outboundMessageId: string;
  address: string;
  attempts: number;
  createdAt: Date;
  dsnNotify: string | null;
  delayDsnSentAt: Date | null;
  failureDsnSentAt: Date | null;
}

export type DsnKind = 'delay' | 'failure';

/** A DSN to generate (PST-T-1.7). The worker hands it to the `onDsn` hook after committing the state. */
export interface DsnIntent {
  kind: DsnKind;
  recipientId: string;
  outboundMessageId: string;
  address: string;
  /** The last thing the remote (or our side) said: the diagnostic for the DSN. */
  code: number | null;
  enhanced: string | null;
  text: string;
  /** When the recipient was queued: DSNs report it as Arrival-Date. */
  queuedAt: Date;
  at: Date;
  /** `delay`: the next retry; `failure`: why it gave up. */
  willRetryUntil?: Date;
  reason?: 'permanent' | 'expired';
}

export type RecipientStateName = 'queued' | 'attempting' | 'deferred' | 'delivered' | 'bounced' | 'cancelled';

export interface Transition {
  state: 'delivered' | 'deferred' | 'bounced';
  /** DeliveryAttempt.outcome for the attempt just made. */
  attemptOutcome: 'delivered' | 'deferred' | 'bounced' | 'error';
  nextAttemptAt: Date;
  lastCode: number | null;
  lastEnhanced: string | null;
  lastText: string | null;
  deliveredAt: Date | null;
  dsn: DsnIntent[];
}

function describe(outcome: AttemptOutcome): { code: number | null; enhanced: string | null; text: string } {
  if (outcome.kind === 'error') return { code: null, enhanced: null, text: outcome.error };
  return { code: outcome.code ?? null, enhanced: outcome.enhanced ?? null, text: outcome.text ?? '' };
}

/**
 * The next state of a recipient after an attempt. Pure: the only inputs are the recipient, the
 * outcome, the clock and the jitter source.
 *
 * A temporary failure schedules the next attempt `jitteredDelayMs(attempts)` from now, but never
 * later than the 5-day mark, so the last retry happens at exactly 5 days; a temporary failure at or
 * after the 5-day mark bounces. A recipient therefore never bounces for age before 5 days.
 */
export function nextState(r: RecipientSnapshot, outcome: AttemptOutcome, now: Date, random: () => number = Math.random): Transition {
  const said = describe(outcome);
  const notify = parseNotify(r.dsnNotify);
  const expiresAt = new Date(r.createdAt.getTime() + MAX_QUEUE_AGE_MS);
  const base = { lastCode: said.code, lastEnhanced: said.enhanced, lastText: said.text === '' ? null : said.text };
  const intent = (kind: DsnKind, extra: Partial<DsnIntent>): DsnIntent => ({
    kind,
    recipientId: r.id,
    outboundMessageId: r.outboundMessageId,
    address: r.address,
    code: said.code,
    enhanced: said.enhanced,
    text: said.text,
    queuedAt: r.createdAt,
    at: now,
    ...extra,
  });

  if (outcome.kind === 'delivered') {
    // SUCCESS is not ours to report: the real transport passes NOTIFY on to a DSN-capable MX
    // (PST-T-1.6), and a "relayed" DSN for one that is not belongs to the DSN generator (PST-T-1.7).
    return { state: 'delivered', attemptOutcome: 'delivered', nextAttemptAt: now, deliveredAt: now, ...base, dsn: [] };
  }

  const bounce = (reason: 'permanent' | 'expired'): Transition => ({
    state: 'bounced',
    attemptOutcome: 'bounced',
    nextAttemptAt: now,
    deliveredAt: null,
    ...base,
    dsn: notify.failure && r.failureDsnSentAt === null ? [intent('failure', { reason })] : [],
  });

  if (outcome.kind === 'permanent') return bounce('permanent');
  if (now.getTime() >= expiresAt.getTime()) return bounce('expired');

  const next = new Date(Math.min(now.getTime() + jitteredDelayMs(r.attempts, random), expiresAt.getTime()));
  const dsn: DsnIntent[] = [];
  if (notify.delay && r.delayDsnSentAt === null && now.getTime() - r.createdAt.getTime() >= DELAY_DSN_AFTER_MS) {
    dsn.push(intent('delay', { willRetryUntil: expiresAt }));
  }
  return {
    state: 'deferred',
    attemptOutcome: outcome.kind === 'error' ? 'error' : 'deferred',
    nextAttemptAt: next,
    deliveredAt: null,
    ...base,
    dsn,
  };
}

/** Only a recipient that is not in flight and not final may be cancelled. */
export function canCancel(state: RecipientStateName): boolean {
  return state === 'queued' || state === 'deferred';
}
