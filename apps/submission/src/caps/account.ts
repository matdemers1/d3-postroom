// The account-wide outbound cap (PST-T-11.11): PST-REQ-177 (an account's outbound recipients across
// ALL sending paths — SMTP on 587/465 under any of its app passwords, the webmail composer, read
// receipts, invite replies, held sends, Sieve vacation replies — are capped per hour and per day;
// over it, further mail is refused with a temporary error) and PST-REQ-180 (the first refusal alerts
// the operator).
//
// The per-app-password caps (createCapsEnforcer) and the webmail's own cap (createWebmailCapsEnforcer)
// stay as they are: each bounds one path. What they cannot see is the sum — three app passwords and
// the webmail each just under their own cap add up to far more than one person sends. This cap is
// that sum, enforced inside acceptSubmission itself (accept.ts), so no caller can leave it out; only
// the e2e seeding route ('e2e-seed', which is not a sending path) is exempt.
//
// Discipline, the same as the other enforcers: `pg_advisory_xact_lock` on the account, then a
// recount against what is actually persisted, then this message's recipients added — so two
// concurrent submissions from one account (from different daemons, even) cannot both pass. Lock
// order: every path takes its own lock first (caps:<appPasswordId> or caps:webmail:<accountId>,
// inside `input.enforceCaps`) and this one second, and no path takes them the other way round, so
// the two can never deadlock. Nothing is frozen: the account has done nothing wrong that a window
// passing will not fix, and a frozen account would hold mail the person meant to send.
//
// The alert fires once per account per window, not once per refused message. Three separate daemons
// enforce this cap, so an in-process flag (or @postroom/alerts' in-memory dedupe) would alert up to
// three times; the durable marker is the `account.outbound_cap_reached` audit row, written only by
// the refusal that finds no live marker, under a lock of its own. It is written after the accepting
// transaction has rolled back (that rollback would take it with it otherwise), and the relay call
// happens after that, holding no lock.
import { recordAudit } from '@postroom/audit';
import type { SendAlert } from '@postroom/alerts';
import { envInt } from '@postroom/daemon';
import type { Db, Prisma } from '@postroom/db';
import { reply, type SmtpReply } from '@postroom/smtp-proto';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** The env names all three sending apps (submission, api, worker) read, and their defaults. */
export const ACCOUNT_CAP_ENV = { hourly: 'ACCOUNT_CAP_HOURLY', daily: 'ACCOUNT_CAP_DAILY' } as const;
export const ACCOUNT_CAP_DEFAULTS = { hourly: 200, daily: 1000 } as const;
/** The one submittedVia the account cap does not apply to: the e2e seeding route is not a sending path. */
export const ACCOUNT_CAP_EXEMPT_VIA = 'e2e-seed';
/** The audit action that is both the record of the cap being reached and the alert's once-per-window marker. */
export const ACCOUNT_CAP_AUDIT_ACTION = 'account.outbound_cap_reached';

export interface AccountCap {
  /** ACCOUNT_CAP_HOURLY: recipients per rolling hour, across every sending path. */
  readonly hourly: number;
  /** ACCOUNT_CAP_DAILY: recipients per rolling 24 hours, across every sending path. */
  readonly daily: number;
  /** The D3 Auth relay (PST-REQ-096). Without one, the cap is still enforced and the marker still written; only the email is missing. */
  readonly sendAlert?: SendAlert;
  readonly log?: Log;
}

/** The cap as every app builds it: the same env names, the same defaults (PST-T-11.11). */
export function accountCapFromEnv(env: NodeJS.ProcessEnv, extras: { sendAlert?: SendAlert; log?: Log } = {}): AccountCap {
  return {
    hourly: envInt(env, ACCOUNT_CAP_ENV.hourly, ACCOUNT_CAP_DEFAULTS.hourly),
    daily: envInt(env, ACCOUNT_CAP_ENV.daily, ACCOUNT_CAP_DEFAULTS.daily),
    ...(extras.sendAlert === undefined ? {} : { sendAlert: extras.sendAlert }),
    ...(extras.log === undefined ? {} : { log: extras.log }),
  };
}

export const AccountCapReplies = {
  // Distinct from the per-credential 'Recipient cap reached for this credential': this one names the account.
  reached: reply(452, '4.5.3', 'Outbound recipient limit reached for this account; try again later'),
} as const satisfies Record<string, SmtpReply>;

export type AccountCapWindow = 'hourly' | 'daily';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_MS: Record<AccountCapWindow, number> = { hourly: HOUR_MS, daily: DAY_MS };

/** Thrown inside the accepting transaction when this message would take the account over its cap. */
export class AccountCapExceededError extends Error {
  constructor(
    readonly window: AccountCapWindow,
    readonly limit: number,
    readonly count: number,
  ) {
    super(`account ${window} outbound cap (${String(limit)}) exceeded`);
    this.name = 'AccountCapExceededError';
  }
}

async function accountRecipientCount(tx: Prisma.TransactionClient, accountId: string, since: Date): Promise<number> {
  // Every outbound recipient of the account's messages, whatever path queued them.
  return tx.outboundRecipient.count({ where: { message: { accountId }, createdAt: { gte: since } } });
}

/**
 * Run inside the accepting transaction, after the path's own cap and before anything is inserted.
 * Resolves when `recipients` more fit under both windows; throws {@link AccountCapExceededError}
 * when they do not.
 */
export async function enforceAccountCap(tx: Prisma.TransactionClient, cap: AccountCap, accountId: string, recipients: number, at: Date): Promise<void> {
  if (recipients === 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`caps:account:${accountId}`}, 0))`;
  const hourly = Math.min(cap.hourly, cap.daily);
  const [hourCount, dayCount] = await Promise.all([
    accountRecipientCount(tx, accountId, new Date(at.getTime() - HOUR_MS)),
    accountRecipientCount(tx, accountId, new Date(at.getTime() - DAY_MS)),
  ]);
  if (dayCount + recipients > cap.daily) throw new AccountCapExceededError('daily', cap.daily, dayCount);
  if (hourCount + recipients > hourly) throw new AccountCapExceededError('hourly', hourly, hourCount);
}

/**
 * Record the cap being reached and alert the operator — once per account per window (PST-REQ-180).
 * Call only after the accepting transaction has ended. Returns whether this call was the one that
 * alerted (whether or not the relay then delivered it).
 *
 * A marker is live until the window it names has passed (`untilMs`, from the caller's clock, like the
 * count itself). An hourly refusal is quiet while any marker is live; a daily refusal only while a
 * daily one is — reaching the daily cap is news even an hour after the hourly one was reached.
 */
export async function alertAccountCapOnce(db: Db, cap: AccountCap, accountId: string, error: AccountCapExceededError, at: Date): Promise<boolean> {
  const log = cap.log ?? ((): void => undefined);
  const anyWindow = error.window === 'hourly';
  const claimed = await db.$transaction(async (tx) => {
    // Its own lock, so the check-then-insert is one decision across every daemon.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`caps:account-alert:${accountId}`}, 0))`;
    const live = await tx.$queryRaw<{ n: number }[]>`
      SELECT 1 AS n FROM audit_event
       WHERE entity_type = 'account' AND entity_id = ${accountId} AND action = ${ACCOUNT_CAP_AUDIT_ACTION}
         AND (after->>'window' = 'daily' OR ${anyWindow})
         AND (after->>'untilMs')::bigint > ${at.getTime()}
       LIMIT 1`;
    if (live.length > 0) return false;
    await recordAudit(tx, {
      actor: { kind: 'system', label: 'account-cap' },
      action: ACCOUNT_CAP_AUDIT_ACTION,
      entityType: 'account',
      entityId: accountId,
      before: null,
      after: { window: error.window, limit: error.limit, count: error.count, at: at.toISOString(), untilMs: at.getTime() + WINDOW_MS[error.window] },
    });
    return true;
  });
  if (!claimed) return false;
  log('account-cap-reached', { accountId, window: error.window, limit: error.limit });
  const result = await cap.sendAlert?.({
    subject: 'Postroom: account outbound cap reached',
    text: `Account ${accountId} reached its ${error.window} outbound cap (${String(error.limit)} recipients across every sending path). Further outbound mail from it is refused with 452 4.5.3 until the window passes; nothing was frozen. This alert is sent once per window.`,
    key: `cap-account:${accountId}:${error.window}`,
  });
  if (result !== undefined && !result.sent) log('alert-not-sent', { accountId, reason: result.reason });
  return true;
}
