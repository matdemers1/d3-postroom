// Per-credential recipient caps (PST-T-1.10): PST-REQ-043 (hourly and daily caps, the cap+1th
// recipient refused with 452) and PST-REQ-044 (exceeding a cap freezes the credential's outbound,
// holds its queued mail, and alerts the operator).
//
// The seam is called twice per message with a growing recipient list: once per RCPT (this
// transaction's recipients so far, plus the candidate), and once more in the accepting transaction
// with the final list. Either call can trip the freeze; recomputing with the same numbers a second
// time is harmless. Freezing is a system mutation (PST-REQ-009): it is audited with a `system`
// actor, and the operator is alerted through the D3 Auth mail relay (PST-REQ-096), never Postroom's
// own queue.
import { recordAudit } from '@postroom/audit';
import type { Db } from '@postroom/db';
import { reply, type SmtpReply } from '@postroom/smtp-proto';
import type { SendAlert } from '@postroom/alerts';
import type { CapDecision, CheckCaps, SubmissionCredential } from '../caps-seam.js';

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
  /** For the rare direct call against a credential already frozen; the daemon's onMail hook is the
   * usual path to this reply, since it can answer before a transaction (and its recipients) exist. */
  frozen: reply(452, '4.7.0', 'Credential frozen by rate cap; contact the operator'),
} as const satisfies Record<string, SmtpReply>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function capsFor(dailyOverride: number | null, hourlyDefault: number, dailyDefault: number): { hourly: number; daily: number } {
  const daily = dailyOverride ?? dailyDefault;
  const hourly = Math.min(hourlyDefault, daily);
  return { hourly, daily };
}

async function recentRecipientCount(db: Db, appPasswordId: string, since: Date): Promise<number> {
  return db.outboundRecipient.count({ where: { message: { appPasswordId }, createdAt: { gte: since } } });
}

/**
 * Freeze the credential if it is not already frozen, inside one transaction with its audit row.
 * Returns the credential's label when this call is the one that froze it (so the caller alerts
 * exactly once), or null when it was already frozen (or gone).
 */
async function freezeCredential(db: Db, appPasswordId: string, now: Date, reason: string): Promise<string | null> {
  return db.$transaction(async (tx) => {
    const ap = await tx.appPassword.findUnique({ where: { id: appPasswordId } });
    if (ap === null || ap.frozenAt !== null) return null;
    await tx.appPassword.update({ where: { id: appPasswordId }, data: { frozenAt: now } });
    await recordAudit(tx, {
      actor: { kind: 'system' },
      action: 'app_password.freeze',
      entityType: 'app_password',
      entityId: appPasswordId,
      before: { frozenAt: null },
      after: { frozenAt: now.toISOString(), reason },
    });
    return ap.label;
  });
}

/** Whether this credential is frozen right now (a plain read; no lock, no side effect). */
export async function isCredentialFrozen(db: Db, appPasswordId: string): Promise<boolean> {
  const ap = await db.appPassword.findUnique({ where: { id: appPasswordId }, select: { frozenAt: true } });
  return ap?.frozenAt !== null && ap?.frozenAt !== undefined;
}

/**
 * Build the `checkCaps` seam: given a credential and every recipient counted toward this decision
 * (recipients already accepted plus the one being weighed), decide whether the next recipient fits
 * under both the hourly and daily windows.
 */
export function createCapsChecker(o: CapsOptions): CheckCaps {
  const now = o.now ?? ((): Date => new Date());
  const log = o.log ?? ((): void => undefined);

  return async (credential: SubmissionCredential, recipients: readonly string[]): Promise<CapDecision> => {
    if (recipients.length === 0) return { action: 'allow' };
    const ap = await o.db.appPassword.findUnique({ where: { id: credential.appPasswordId }, select: { dailyRecipientCap: true } });
    if (ap === null) return { action: 'allow' }; // an authenticated credential always has a row

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
    const label = await freezeCredential(o.db, credential.appPasswordId, at, reason);
    if (label !== null) {
      log('credential-frozen', { appPasswordId: credential.appPasswordId, accountId: credential.accountId, reason });
      const result = await o.sendAlert?.({
        subject: `Postroom: credential "${label}" frozen (recipient cap)`,
        text: `Credential "${label}" (${credential.appPasswordId}) exceeded its recipient cap and was frozen automatically: ${reason}. Its queued outbound mail is held until an operator thaws it.`,
        key: `cap-freeze:${credential.appPasswordId}`,
      });
      if (result !== undefined && !result.sent) log('alert-not-sent', { appPasswordId: credential.appPasswordId, reason: result.reason });
    }
    return { action: 'reject', reply: CapReplies.capReached };
  };
}
