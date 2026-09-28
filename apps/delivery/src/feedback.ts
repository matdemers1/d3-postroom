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
// How a bounce changes a recipient. The state machine (state.ts) has no edge out of `delivered`,
// because the queue never moves a delivered recipient again, and that stays true: this module is
// the only writer of the one extra edge, `delivered → bounced`, taken only when a report ties a
// specific outbound recipient to a failure. The recipient keeps its deliveredAt (when the remote
// accepted) and gains a DeliveryAttempt row with outcome `bounced`, transport `async-dsn` or
// `ses-notification`, and the remote's status and diagnostic, so the delivery timeline shows what
// happened and in what order; lastText is prefixed with where the news came from. A recipient in
// any other state is left alone: queued/deferred/attempting belong to the queue, bounced already
// is bounced, cancelled was never sent. No failure DSN is generated for an async bounce: for a DSN
// the sender already has the remote's own report in their INBOX.
//
// Why a DSN cannot be used to suppress someone else's mail (the forgery reasoning). A DSN is just
// a message anyone can send. So an inbound DSN only acts when (1) it comes from a null reverse-path
// or a MAILER-DAEMON/postmaster From (the caller checks, apps/worker/src/feedback), (2) it names the
// original by Message-ID or ENVID, (3) that original is outbound mail sent by an account the DSN was
// delivered to, and (4) the failed recipient is one of that message's recipients. Message-IDs we
// generate are random UUIDs, so only a party that received the message (or saw its headers) can
// name it; and such a party can at worst mark its *own* address as bounced, which is the same as
// refusing the mail. One account's inbound DSN never touches another account's outbound rows.
// An SES notification is authenticated by its SNS signature instead, so it is `trusted`: a
// Permanent bounce suppresses the address even when the outbound row is gone.
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
  /** Authenticated by its transport (a verified SNS signature): may suppress without a queue row. */
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
 * Record one asynchronous bounce and act on it, in `tx`: mark the correlated recipient bounced
 * (delivered → bounced only) and, for a final 5.1.x (or, trusted, a final bounce with no status),
 * suppress the address through recordHardBounce. Idempotent by `dedupeKey`.
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

    if (recipient !== null && input.final) {
      if (recipient.state === RecipientState.delivered) {
        const origin = input.source === 'dsn' ? 'async DSN' : 'SES bounce notification';
        const text = `[${origin}] ${diagnostic ?? input.status ?? 'bounced after delivery'}`;
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
              transport: input.source === 'dsn' ? 'async-dsn' : 'ses-notification',
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
    const eligible = input.final && (addressStatus || (input.trusted && input.status === null));
    // Untrusted (an SMTP DSN): only when this very report tied itself to a recipient we had
    // delivered. Trusted (signed SES): unless the queue already bounced it (the synchronous path has
    // then decided, and counted, already).
    const allowed = input.trusted ? recipient?.state !== RecipientState.bounced : marked;
    if (eligible && allowed) {
      await recordHardBounce(tx, {
        address,
        recipientId: recipient?.id ?? null,
        code: input.code,
        enhanced: input.status ?? '',
        text: diagnostic ?? `${input.source} permanent bounce`,
        at: input.now,
        requestId: input.requestId,
        actorLabel: input.source === 'dsn' ? 'async-dsn' : 'ses-sns',
      });
      suppressed = true;
      reasons.push(input.status === null ? 'permanent bounce with no status from a signed notification: address suppressed' : `${input.status} is an address status (5.1.x): address suppressed (PST-REQ-176)`);
    } else if (input.final && !addressStatus && !(input.trusted && input.status === null)) {
      reasons.push(`${input.status ?? 'no status'} is not 5.1.x: the address is not suppressed`);
    } else if (eligible) {
      reasons.push('not suppressed: the report did not bounce a delivered recipient of ours');
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
  readonly requestId: string;
}

export interface ComplaintResult {
  readonly feedbackId: string;
  readonly duplicate: boolean;
  readonly outboundMessageId: string | null;
  readonly accountId: string | null;
  /** Send one operator alert for this row (then markAlerted). False for a duplicate, and for an
   * unsigned report that names no message of ours: an alert anyone could trigger is noise. */
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
  const alertDue = corr !== null || input.trusted;
  reasons.push(alertDue ? 'operator alert due' : 'no alert: an unsigned report about no message of ours');
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
