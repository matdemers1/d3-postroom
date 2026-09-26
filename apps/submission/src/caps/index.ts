// Per-credential recipient caps (PST-T-1.10): PST-REQ-043 (hourly and daily caps, the cap+1th
// recipient refused with 452) and PST-REQ-044 (exceeding a cap freezes the credential's outbound,
// holds its queued mail, and alerts the operator).
//
// `checkCaps` (RCPT time) is a plain read: fast, and early enough to refuse — and freeze — most
// cap-busting sessions before they ever reach DATA. But it is not authoritative: two concurrent
// sessions can each read a count that is individually under cap, both be told to proceed, and both
// persist, landing the credential over cap with no freeze at all. That failure mode is closed only
// by `enforceCaps`, called once per message inside the very transaction that inserts its
// recipients: it takes `pg_advisory_xact_lock` on the credential first, so a concurrent submission
// for the same credential queues behind it rather than racing it, then recounts against whatever
// that lock ordering actually left in the table before this message's own insert. Freezing is a
// system mutation (PST-REQ-009): the freeze-and-audit pair is one atomic write (`updateMany` guarded
// on `frozenAt: null`, so two racing freezers can never both "win" and both alert), and the operator
// is alerted through the D3 Auth mail relay (PST-REQ-096) — never Postroom's own queue, and, for the
// authoritative path, never while the transaction (and so the advisory lock) is still open.
import { recordAudit } from '@postroom/audit';
import type { Db, Prisma } from '@postroom/db';
import { reply, type SmtpReply } from '@postroom/smtp-proto';
import type { SendAlert } from '@postroom/alerts';
import { CapExceededError, type CapDecision, type CheckCaps, type EnforceCaps, type SubmissionCredential } from '../caps-seam.js';

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface CapsOptions {
  readonly db: Db;
  /** SUBMISSION_CAP_HOURLY. */
  readonly hourlyDefault: number;
  /** SUBMISSION_CAP_DAILY; a credential's own dailyRecipientCap overrides this. */
  readonly dailyDefault: number;
  readonly sendAlert?: SendAlert;
  readonly now?: () => Date;
  readonly log?: Log;
}

export const CapReplies = {
  capReached: reply(452, '4.5.3', 'Recipient cap reached for this credential'),
  frozen: reply(452, '4.7.0', 'Credential frozen by rate cap; contact the operator'),
} as const satisfies Record<string, SmtpReply>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Both a `Db` and a `Prisma.TransactionClient` answer these the same way. */
type Queryable = Db | Prisma.TransactionClient;

function capsFor(dailyOverride: number | null, hourlyDefault: number, dailyDefault: number): { hourly: number; daily: number } {
  const daily = dailyOverride ?? dailyDefault;
  const hourly = Math.min(hourlyDefault, daily);
  return { hourly, daily };
}

async function recentRecipientCount(db: Queryable, appPasswordId: string, since: Date): Promise<number> {
  return db.outboundRecipient.count({ where: { message: { appPasswordId }, createdAt: { gte: since } } });
}

/**
 * Freeze the credential and write its audit row as one atomic pair, guarded so that only the first
 * of any number of racing callers actually freezes it (an unconditional read-then-update would let
 * two concurrent unlocked callers — `checkCaps` has no lock — both "win" and both alert).
 * Returns the credential's label when this call is the one that froze it, or null when it was
 * already frozen (nothing to do: no update, no audit row, no alert).
 */
async function freezeAndAudit(db: Queryable, appPasswordId: string, at: Date, reason: string): Promise<string | null> {
  const before = await db.appPassword.findUnique({ where: { id: appPasswordId }, select: { label: true } });
  if (before === null) return null;
  const updated = await db.appPassword.updateMany({ where: { id: appPasswordId, frozenAt: null }, data: { frozenAt: at } });
  if (updated.count === 0) return null;
  await recordAudit(db, {
    actor: { kind: 'system' },
    action: 'app_password.freeze',
    entityType: 'app_password',
    entityId: appPasswordId,
    before: { frozenAt: null },
    after: { frozenAt: at.toISOString(), reason },
  });
  return before.label;
}

/** Whether this credential is frozen right now (a plain read; no lock, no side effect). */
export async function isCredentialFrozen(db: Queryable, appPasswordId: string): Promise<boolean> {
  const ap = await db.appPassword.findUnique({ where: { id: appPasswordId }, select: { frozenAt: true } });
  return ap?.frozenAt !== null && ap?.frozenAt !== undefined;
}

function buildAlert(o: CapsOptions, log: Log): (label: string, appPasswordId: string, reason: string) => Promise<void> {
  return async (label, appPasswordId, reason) => {
    const result = await o.sendAlert?.({
      subject: `Postroom: credential "${label}" frozen (recipient cap)`,
      text: `Credential "${label}" (${appPasswordId}) exceeded its recipient cap and was frozen automatically: ${reason}. Its queued outbound mail is held until an operator thaws it.`,
      key: `cap-freeze:${appPasswordId}`,
    });
    if (result !== undefined && !result.sent) log('alert-not-sent', { appPasswordId, reason: result.reason });
  };
}

/**
 * Build the RCPT-time `checkCaps` seam: given a credential and every recipient counted toward this
 * decision (recipients already accepted plus the one being weighed), decide whether the next
 * recipient fits under both the hourly and daily windows — freezing (and alerting) the moment it
 * does not. Early and best-effort: see the module comment for why `createCapsEnforcer.enforceCaps`
 * is what a concurrent race cannot slip past, even though this one usually catches it first.
 */
export function createCapsChecker(o: CapsOptions): CheckCaps {
  const now = o.now ?? ((): Date => new Date());
  const log = o.log ?? ((): void => undefined);
  const alert = buildAlert(o, log);

  return async (credential: SubmissionCredential, recipients: readonly string[]): Promise<CapDecision> => {
    if (recipients.length === 0) return { action: 'allow' };
    const ap = await o.db.appPassword.findUnique({ where: { id: credential.appPasswordId }, select: { dailyRecipientCap: true, frozenAt: true } });
    if (ap === null) return { action: 'allow' }; // an authenticated credential always has a row
    if (ap.frozenAt !== null) return { action: 'reject', reply: CapReplies.frozen };

    const at = now();
    const { hourly, daily } = capsFor(ap.dailyRecipientCap, o.hourlyDefault, o.dailyDefault);
    const [hourCount, dayCount] = await Promise.all([
      recentRecipientCount(o.db, credential.appPasswordId, new Date(at.getTime() - HOUR_MS)),
      recentRecipientCount(o.db, credential.appPasswordId, new Date(at.getTime() - DAY_MS)),
    ]);
    const overDaily = dayCount + recipients.length > daily;
    const overHourly = hourCount + recipients.length > hourly;
    if (!overDaily && !overHourly) return { action: 'allow' };

    const reason = overDaily ? `daily recipient cap (${String(daily)}) exceeded` : `hourly recipient cap (${String(hourly)}) exceeded`;
    const label = await freezeAndAudit(o.db, credential.appPasswordId, at, reason);
    if (label !== null) {
      log('credential-frozen', { appPasswordId: credential.appPasswordId, accountId: credential.accountId, reason });
      await alert(label, credential.appPasswordId, reason);
    }
    return { action: 'reject', reply: CapReplies.capReached };
  };
}

/**
 * Build the authoritative `enforceCaps`: call inside the transaction that will insert this
 * message's recipients, before that insert. Serializes every submission for one credential (an
 * advisory lock scoped to the transaction, released automatically on commit or rollback), recounts
 * against the rolling window, and — if this message would exceed it, or the credential is already
 * frozen (by this check or by `checkCaps`) — throws `CapExceededError` carrying the 452 to answer
 * with, so nothing from this message is queued. When this call is the one that freezes the
 * credential, the error also carries an `alert` closure the caller must await once the transaction
 * has settled, never before.
 */
export function createCapsEnforcer(o: CapsOptions): EnforceCaps {
  const log = o.log ?? ((): void => undefined);
  const alert = buildAlert(o, log);

  return async (tx: Prisma.TransactionClient, credential: SubmissionCredential, recipients: readonly string[], at: Date): Promise<void> => {
    if (recipients.length === 0) return;
    const lockKey = `caps:${credential.appPasswordId}`;
    // Scoped to this transaction: released on commit or rollback, so a concurrent submission for
    // the same credential blocks here rather than reading a count this one is still about to change.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

    const ap = await tx.appPassword.findUnique({ where: { id: credential.appPasswordId }, select: { dailyRecipientCap: true, frozenAt: true } });
    if (ap === null) return; // an authenticated credential always has a row
    if (ap.frozenAt !== null) throw new CapExceededError(CapReplies.frozen);

    const { hourly, daily } = capsFor(ap.dailyRecipientCap, o.hourlyDefault, o.dailyDefault);
    const [hourCount, dayCount] = await Promise.all([
      recentRecipientCount(tx, credential.appPasswordId, new Date(at.getTime() - HOUR_MS)),
      recentRecipientCount(tx, credential.appPasswordId, new Date(at.getTime() - DAY_MS)),
    ]);
    const overDaily = dayCount + recipients.length > daily;
    const overHourly = hourCount + recipients.length > hourly;
    if (!overDaily && !overHourly) return;

    const reason = overDaily ? `daily recipient cap (${String(daily)}) exceeded` : `hourly recipient cap (${String(hourly)}) exceeded`;
    // Freeze in a transaction of its own, on `o.db` rather than `tx`: this call is about to throw
    // to reject the message, and Prisma rolls back everything the accepting transaction did —
    // including a freeze written through `tx` — the moment its callback throws. The freeze must
    // survive that rollback, so it cannot be part of it.
    const label = await o.db.$transaction((freezeTx) => freezeAndAudit(freezeTx, credential.appPasswordId, at, reason));
    if (label !== null) log('credential-frozen', { appPasswordId: credential.appPasswordId, accountId: credential.accountId, reason });
    throw new CapExceededError(CapReplies.capReached, label === null ? undefined : () => alert(label, credential.appPasswordId, reason));
  };
}
