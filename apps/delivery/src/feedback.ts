// Asynchronous delivery feedback (PST-T-11.15): what comes back after a remote said 250. Two
// kinds, from two directions:
//
//   bounce     a remote MTA's DSN (RFC 3464) arriving by SMTP, or an SES Bounce notification over
//              SNS. With all outbound going through SES (DELIVERY_SES_DOMAINS=*), SES accepting a
//              message is what marks it `delivered`; a hard bounce afterwards is only ever seen here.
//   complaint  an ARF feedback report (RFC 5965), or an SES Complaint notification. Recorded and
//              alerted on, because the SES complaint rate is what gets the sending account paused.
//
// PST-REQ-176 said a 5.1.x permanent failure suppresses the address with the remote reply; this
// extends it from the synchronous SMTP reply (apps/delivery/src/worker.ts) to asynchronous reports,
// through the same recordHardBounce.
//
// Who may change a recipient: only a signed SES notification. An inbound SMTP DSN (RFC 3464) is
// recorded and nothing else — no state change, no attempt row, no suppression — whatever its
// sender. A DSN is a message anyone can send, and there is no sound way to authenticate one against
// the failed recipient's domain: a real Gmail bounce is DKIM-signed by google.com, not gmail.com,
// and a null reverse-path or a MAILER-DAEMON From is free to forge from any domain with passing
// SPF/DKIM/DMARC. The attack that rules it out: account A sends one message to attacker@evil.example
// and victim@gmail.com; the attacker, who now knows the Message-ID and the co-recipient, sends a
// null-sender "5.1.1" DSN naming victim@gmail.com. Acting on it would bounce the victim and put
// the address on the suppression list, which is global — every account could no longer mail them.
// Anyone who sees a Message-ID and a recipient list (co-recipients, anyone reading a later reply's
// References) could do the same. So a DSN row is information for the sender and the admin: the
// parsed Final-Recipient, Status and Diagnostic-Code, and the outbound message and recipient it
// names (correlation is still restricted to mail the receiving account sent).
//
// A signed SES notification (`trusted`, verified in apps/api/src/ses) is the authoritative path,
// and today carries all outbound mail. A Permanent bounce takes the one extra edge the state
// machine (state.ts) does not have, `delivered → bounced`: the recipient keeps its deliveredAt
// (when SES accepted), gains a DeliveryAttempt with outcome `bounced`, transport
// `ses-notification` and SES's status and diagnostic, and its lastText is prefixed with where the
// news came from. With a 5.1.x or no status it also suppresses the address, through
// recordHardBounce (PST-REQ-176) — even when the outbound row is gone. A recipient in any other
// state is left alone: queued/deferred/attempting belong to the queue, bounced is bounced,
// cancelled was never sent. No failure DSN is generated: SES's email feedback forwarding sends one.
import { recordAudit } from '@postroom/audit';
import { RecipientState, type Db, type Prisma } from '@postroom/db';
import { decodeXtext } from '@postroom/dsn';
import { recordHardBounce, suppressionKey } from './suppression.js';

type Tx = Prisma.TransactionClient | Db;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Enhanced status class 5, subject 1 (RFC 3463 §3.2): evidence about the address itself. */
const ADDRESS_STATUS = /^5\.1\.\d{1,3}$/;
const MAX_DIAGNOSTIC = 1000;

export type FeedbackSource = 'dsn' | 'arf' | 'ses';
export type FeedbackAction = 'bounced' | 'bounced-suppressed' | 'suppressed' | 'recorded' | 'ignored';

/** How a report names the original message. */
export interface Correlation {
  /** Message-IDs of the original (without angle brackets), from the returned message or headers. */
  readonly messageIds: readonly string[];
  /** Original-Envelope-Id as written (RFC 3461 xtext); matched raw and decoded against dsnEnvid. */
  readonly envid?: string | null;
  /**
   * Only outbound mail sent by these accounts can match (a DSN: the accounts it was delivered to).
   * Undefined means any account (a signed SES notification; an ARF report, which changes no mail).
   */
  readonly accountIds?: readonly string[];
  /**
   * The transport's own id for the message: SES answers DATA with `250 Ok <SES message id>`, which
   * the delivered attempt keeps as its remoteText, and SES notifications name the message by it.
   * SES may rewrite the Message-ID header, so this is the correlation that survives it.
   */
  readonly transportMessageId?: string | null;
}

/** An SES message id: hex and dashes. Anything else is never used in a query. */
const SES_MESSAGE_ID = /^[0-9A-Za-z][0-9A-Za-z-]{15,99}$/;

export interface CorrelatedOutbound {
  readonly outboundMessageId: string;
  readonly accountId: string;
  readonly messageId: string | null;
  readonly recipient: { readonly id: string; readonly state: RecipientState; readonly address: string } | null;
}

/**
 * The newest outbound message the report names that is visible under `accountIds`, preferring one
 * with a recipient equal (case-insensitively) to `address`. Null when nothing matches. A Message-ID
 * is stored as its header value (`<id>`), so both the bracketed and the bare form are tried.
 */
export async function correlateOutbound(tx: Tx, c: Correlation, address: string | null): Promise<CorrelatedOutbound | null> {
  const ids = [...new Set(c.messageIds.map((m) => m.trim()).filter((m) => m !== '' && m.length <= 998))].slice(0, 10);
  const envids = c.envid === null || c.envid === undefined || c.envid.trim() === '' ? [] : [...new Set([c.envid.trim(), decodeXtext(c.envid.trim())])];
  const or: Prisma.OutboundMessageWhereInput[] = [];
  if (ids.length > 0) or.push({ messageId: { in: ids.flatMap((id) => [`<${id}>`, id]) } });
  if (envids.length > 0) or.push({ dsnEnvid: { in: envids } });
  const tid = c.transportMessageId?.trim() ?? '';
  if (SES_MESSAGE_ID.test(tid)) or.push({ recipients: { some: { attemptsLog: { some: { outcome: 'delivered', remoteText: { contains: tid } } } } } });
  if (or.length === 0) return null;
  if (c.accountIds?.length === 0) return null;
  const rows = await tx.outboundMessage.findMany({
    where: { OR: or, ...(c.accountIds === undefined ? {} : { accountId: { in: [...c.accountIds] } }) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    select: {
      id: true,
      accountId: true,
      messageId: true,
      recipients:
        address === null
          ? { take: 0, select: { id: true, state: true, address: true } }
          : { where: { address: { equals: address.trim(), mode: 'insensitive' } }, select: { id: true, state: true, address: true }, take: 1 },
    },
  });
  const withRecipient = rows.find((r) => r.recipients.length > 0);
  const row = withRecipient ?? rows[0];
  if (row === undefined) return null;
  return { outboundMessageId: row.id, accountId: row.accountId, messageId: row.messageId, recipient: row.recipients[0] ?? null };
}

interface Inserted {
  readonly id: string;
  readonly duplicate: boolean;
}

/** Claims `dedupeKey` (ON CONFLICT DO NOTHING, so a concurrent twin never aborts the transaction). */
async function claim(tx: Tx, row: { kind: 'bounce' | 'complaint'; source: FeedbackSource; dedupeKey: string; reportedAt: Date }): Promise<Inserted> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO delivery_feedback (kind, source, dedupe_key, action, reported_at)
    VALUES (${row.kind}, ${row.source}, ${row.dedupeKey}, 'recorded', ${row.reportedAt})
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id::text AS id`;
  const id = inserted[0]?.id;
  if (id !== undefined) return { id, duplicate: false };
  const existing = await tx.deliveryFeedback.findUniqueOrThrow({ where: { dedupeKey: row.dedupeKey }, select: { id: true } });
  return { id: existing.id, duplicate: true };
}

function clip(text: string | null): string | null {
  if (text === null) return null;
  const t = text.replace(/[\r\n]+/g, ' ').trim();
  return t === '' ? null : t.slice(0, MAX_DIAGNOSTIC);
}

export interface AsyncBounceInput {
  readonly source: 'dsn' | 'ses';
  readonly dedupeKey: string;
  /** The failed recipient, as the report names it. */
  readonly address: string;
  /** Enhanced status (5.1.1), or null when the report gave none. */
  readonly status: string | null;
  readonly code: number | null;
  readonly diagnostic: string | null;
  /** The message will not reach this recipient: a DSN `Action: failed`, an SES `Permanent` bounce. */
  readonly final: boolean;
  /** SES bounceType/bounceSubType, recorded as-is. */
  readonly feedbackType?: string | null;
  readonly correlation: Correlation;
  /** Authenticated by its transport (a verified SNS signature). Only a trusted bounce changes a
   * recipient or suppresses an address; an untrusted one (an SMTP DSN) is recorded, nothing more. */
  readonly trusted: boolean;
  /** Reasons the caller refuses to act on this report at all (unauthenticated sender, quarantine). */
  readonly refuse?: readonly string[];
  readonly inboundMessageId?: string | null;
  /** Report metadata only (reporting MTA, arrival date); never a body. */
  readonly detail?: Record<string, JsonValue>;
  readonly reportedAt: Date;
  readonly now: Date;
  /** Audit request id: `inbound:<id>` for the pipeline, the HTTP request id for SNS. */
  readonly requestId: string;
}

export interface AsyncBounceResult {
  readonly feedbackId: string;
  /** This event was already recorded (a replayed job, a redelivered notification): nothing was done. */
  readonly duplicate: boolean;
  readonly action: FeedbackAction;
  readonly outboundMessageId: string | null;
  readonly recipientId: string | null;
  readonly marked: boolean;
  readonly suppressed: boolean;
  readonly reasons: string[];
}

/**
 * Record one asynchronous bounce, in `tx`. Only when `trusted` (a signed SES notification) is it
 * acted on: the correlated recipient is marked bounced (delivered → bounced only) and, for a final
 * 5.1.x or status-less bounce, the address is suppressed through recordHardBounce. An untrusted
 * report (an SMTP DSN) is recorded only. Idempotent by `dedupeKey`.
 */
export async function recordAsyncBounce(tx: Tx, input: AsyncBounceInput): Promise<AsyncBounceResult> {
  const address = suppressionKey(input.address);
  const { id, duplicate } = await claim(tx, { kind: 'bounce', source: input.source, dedupeKey: input.dedupeKey, reportedAt: input.reportedAt });
  if (duplicate) {
    const row = await tx.deliveryFeedback.findUniqueOrThrow({ where: { id } });
    return {
      feedbackId: id,
      duplicate: true,
      action: row.action as FeedbackAction,
      outboundMessageId: row.outboundMessageId,
      recipientId: row.outboundRecipientId,
      marked: false,
      suppressed: false,
      reasons: ['already recorded; nothing done again'],
    };
  }

  const diagnostic = clip(input.diagnostic);
  const reasons: string[] = [];
  let action: FeedbackAction;
  let corr: CorrelatedOutbound | null = null;
  let marked = false;
  let suppressed = false;

  if (input.refuse !== undefined && input.refuse.length > 0) {
    action = 'ignored';
    reasons.push(...input.refuse);
  } else {
    corr = await correlateOutbound(tx, input.correlation, address);
    const recipient = corr?.recipient ?? null;
    if (corr === null) reasons.push('no outbound message matches the report (Message-ID/ENVID)' + (input.correlation.accountIds === undefined ? '' : ' among mail the receiving account sent'));
    else if (recipient === null) reasons.push(`outbound message ${corr.outboundMessageId} has no recipient ${address}`);

    if (!input.trusted) {
      // An SMTP DSN: informational only (see the top of this file).
      reasons.push('an SMTP DSN cannot be authenticated: recorded for the sender and admin, nothing changed');
    } else {
      if (recipient !== null && input.final) {
        if (recipient.state === RecipientState.delivered) {
          const text = `[SES bounce notification] ${diagnostic ?? input.status ?? 'bounced after delivery'}`;
          const moved = await tx.outboundRecipient.updateMany({
            where: { id: recipient.id, state: RecipientState.delivered },
            data: { state: RecipientState.bounced, lastCode: input.code, lastEnhanced: input.status, lastText: text.slice(0, MAX_DIAGNOSTIC) },
          });
          marked = moved.count === 1;
          if (marked) {
            await tx.deliveryAttempt.create({
              data: {
                recipientId: recipient.id,
                // When Postroom learned of it, so the timeline reads delivered → bounced; the remote's
                // own time is the feedback row's reportedAt.
                startedAt: input.now,
                finishedAt: input.now,
                transport: 'ses-notification',
                mxHost: typeof input.detail?.['remoteMta'] === 'string' ? input.detail['remoteMta'] : null,
                remoteCode: input.code,
                remoteEnhanced: input.status,
                remoteText: diagnostic,
                outcome: 'bounced',
              },
            });
            reasons.push(`recipient ${recipient.id} was delivered; the remote's later ${input.status ?? 'failure'} marks it bounced`);
          } else {
            reasons.push(`recipient ${recipient.id} left delivered between read and write; not changed`);
          }
        } else if (recipient.state === RecipientState.bounced) {
          reasons.push(`recipient ${recipient.id} is already bounced; nothing to change`);
        } else {
          reasons.push(`recipient ${recipient.id} is ${recipient.state}: the queue owns it, so the report is only recorded`);
        }
      } else if (recipient !== null) {
        reasons.push(`not a final failure (${input.feedbackType ?? 'transient'}); recorded only`);
      }

      const addressStatus = input.status !== null && ADDRESS_STATUS.test(input.status);
      const eligible = input.final && (addressStatus || input.status === null);
      // Unless the queue already bounced it: the synchronous path has then decided, and counted, already.
      if (eligible && recipient?.state !== RecipientState.bounced) {
        await recordHardBounce(tx, {
          address,
          recipientId: recipient?.id ?? null,
          code: input.code,
          enhanced: input.status ?? '',
          text: diagnostic ?? `${input.source} permanent bounce`,
          at: input.now,
          requestId: input.requestId,
          actorLabel: 'ses-sns',
        });
        suppressed = true;
        reasons.push(input.status === null ? 'permanent bounce with no status from a signed notification: address suppressed' : `${input.status} is an address status (5.1.x): address suppressed (PST-REQ-176)`);
      } else if (input.final && !eligible) {
        reasons.push(`${input.status ?? 'no status'} is not 5.1.x: the address is not suppressed`);
      }
    }
    action = marked && suppressed ? 'bounced-suppressed' : marked ? 'bounced' : suppressed ? 'suppressed' : 'recorded';
  }

  await tx.deliveryFeedback.update({
    where: { id },
    data: {
      address,
      outboundMessageId: corr?.outboundMessageId ?? null,
      outboundRecipientId: corr?.recipient?.id ?? null,
      inboundMessageId: input.inboundMessageId ?? null,
      status: input.status,
      feedbackType: input.feedbackType ?? null,
      diagnostic,
      action,
      reasons,
      detail: input.detail ?? {},
    },
  });
  await recordAudit(tx, {
    actor: { kind: 'system', label: input.source === 'dsn' ? 'async-dsn' : 'ses-sns' },
    action: 'delivery.async-bounce',
    entityType: 'delivery_feedback',
    entityId: id,
    before: null,
    after: { source: input.source, address, status: input.status, action, outboundMessageId: corr?.outboundMessageId ?? null, recipientId: corr?.recipient?.id ?? null, marked, suppressed, reasons },
    context: { requestId: input.requestId },
  });
  return { feedbackId: id, duplicate: false, action, outboundMessageId: corr?.outboundMessageId ?? null, recipientId: corr?.recipient?.id ?? null, marked, suppressed, reasons };
}

export interface ComplaintInput {
  readonly source: 'arf' | 'ses';
  readonly dedupeKey: string;
  /** ARF Feedback-Type / SES complaintFeedbackType (abuse, fraud, …), or null. */
  readonly feedbackType: string | null;
  /** The complaining recipient, when the report names one (many providers redact it). */
  readonly address: string | null;
  readonly correlation: Correlation;
  /** Signed (SES): alert even when the outbound row cannot be found. */
  readonly trusted: boolean;
  readonly inboundMessageId?: string | null;
  readonly detail?: Record<string, JsonValue>;
  readonly reportedAt: Date;
  /** For the hourly alert cap. */
  readonly now: Date;
  /** Complaint alerts per rolling hour, server-wide (default COMPLAINT_ALERTS_PER_HOUR). */
  readonly alertsPerHour?: number;
  readonly requestId: string;
}

/**
 * At most this many complaint alerts (ARF and SES together) in any rolling hour, counted from
 * delivery_feedback.alertedAt. An ARF report is unsigned — anyone who knows one of our Message-IDs
 * can send one — so alerts are capped to keep forged reports from burying the operator; the rows
 * are still all recorded.
 */
export const COMPLAINT_ALERTS_PER_HOUR = 5;
const HOUR_MS = 3_600_000;

export interface ComplaintResult {
  readonly feedbackId: string;
  readonly duplicate: boolean;
  readonly outboundMessageId: string | null;
  readonly accountId: string | null;
  /** Send one operator alert for this row (then markAlerted). False for a duplicate; for an unsigned
   * report that names no message of ours, or about a message already alerted on (one alert per
   * outbound message, ever); and once COMPLAINT_ALERTS_PER_HOUR alerts went out in the last hour. */
  readonly alertDue: boolean;
  readonly reasons: string[];
}

/** Record one complaint against the outbound message it names. Changes no mail. Idempotent by `dedupeKey`. */
export async function recordComplaint(tx: Tx, input: ComplaintInput): Promise<ComplaintResult> {
  const address = input.address === null ? null : suppressionKey(input.address);
  const { id, duplicate } = await claim(tx, { kind: 'complaint', source: input.source, dedupeKey: input.dedupeKey, reportedAt: input.reportedAt });
  if (duplicate) {
    const row = await tx.deliveryFeedback.findUniqueOrThrow({ where: { id }, select: { outboundMessageId: true } });
    return { feedbackId: id, duplicate: true, outboundMessageId: row.outboundMessageId, accountId: null, alertDue: false, reasons: ['already recorded; nothing done again'] };
  }
  const corr = await correlateOutbound(tx, input.correlation, address);
  const reasons: string[] = [];
  if (corr === null) reasons.push('no outbound message matches the report (Message-ID/ENVID)');
  else reasons.push(`complaint about outbound message ${corr.outboundMessageId}`);
  let alertDue = corr !== null || input.trusted;
  if (!alertDue) reasons.push('no alert: an unsigned report about no message of ours');
  if (alertDue && !input.trusted && corr !== null) {
    const earlier = await tx.deliveryFeedback.count({ where: { kind: 'complaint', outboundMessageId: corr.outboundMessageId, alertedAt: { not: null }, id: { not: id } } });
    if (earlier > 0) {
      alertDue = false;
      reasons.push('no alert: the operator was already alerted about this outbound message');
    }
  }
  if (alertDue) {
    const cap = input.alertsPerHour ?? COMPLAINT_ALERTS_PER_HOUR;
    const recent = await tx.deliveryFeedback.count({ where: { kind: 'complaint', alertedAt: { gte: new Date(input.now.getTime() - HOUR_MS) } } });
    if (recent >= cap) {
      alertDue = false;
      reasons.push(`no alert: ${String(recent)} complaint alerts in the last hour (cap ${String(cap)}); recorded only`);
    }
  }
  if (alertDue) reasons.push('operator alert due');
  await tx.deliveryFeedback.update({
    where: { id },
    data: {
      address,
      outboundMessageId: corr?.outboundMessageId ?? null,
      outboundRecipientId: corr?.recipient?.id ?? null,
      inboundMessageId: input.inboundMessageId ?? null,
      feedbackType: input.feedbackType,
      action: 'recorded',
      reasons,
      detail: input.detail ?? {},
    },
  });
  await recordAudit(tx, {
    actor: { kind: 'system', label: input.source === 'arf' ? 'arf' : 'ses-sns' },
    action: 'delivery.complaint',
    entityType: 'delivery_feedback',
    entityId: id,
    before: null,
    after: { source: input.source, feedbackType: input.feedbackType, address, outboundMessageId: corr?.outboundMessageId ?? null, reasons },
    context: { requestId: input.requestId },
  });
  return { feedbackId: id, duplicate: false, outboundMessageId: corr?.outboundMessageId ?? null, accountId: corr?.accountId ?? null, alertDue, reasons };
}

/** The one operator alert for a complaint row. Keyed by the row, so the alert sender's hourly dedupe
 * never swallows a second, different complaint. */
export function complaintAlert(c: { feedbackId: string; source: 'arf' | 'ses'; feedbackType: string | null; address: string | null; outboundMessageId: string | null; messageId?: string | null }): {
  subject: string;
  text: string;
  key: string;
} {
  const via = c.source === 'arf' ? 'an ARF feedback report' : 'an SES complaint notification';
  return {
    key: `complaint:${c.feedbackId}`,
    subject: `Postroom: complaint (${c.feedbackType ?? 'unspecified'}) about outbound mail`,
    text: [
      `A recipient complained about mail Postroom sent, reported by ${via}.`,
      '',
      `Feedback type: ${c.feedbackType ?? 'unspecified'}`,
      `Recipient: ${c.address ?? 'redacted by the reporter'}`,
      `Outbound message: ${c.outboundMessageId ?? 'not found'}${c.messageId === undefined || c.messageId === null ? '' : ` (${c.messageId})`}`,
      `Record: delivery_feedback ${c.feedbackId}`,
      '',
      'Complaints count toward the SES complaint rate; a high rate can pause the SES account.',
    ].join('\n'),
  };
}

/** Stamp the complaint row once its alert has been sent. */
export async function markAlerted(tx: Tx, feedbackId: string, at: Date): Promise<void> {
  await tx.deliveryFeedback.updateMany({ where: { id: feedbackId, alertedAt: null }, data: { alertedAt: at } });
}
