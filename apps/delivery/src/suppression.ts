// The suppression list (PST-T-11.10): addresses a delivery attempt proved do not exist, which no
// sending path may queue mail to again until an admin removes them.
//
//   PST-REQ-176  a permanent failure in enhanced-status class 5.1 (bad mailbox 5.1.1, bad domain
//                5.1.2, null MX 5.1.10, …) adds the address, with the remote reply, in the same
//                transaction that records the bounce.
//   PST-REQ-179  every sending path refuses a suppressed recipient (acceptSubmission and SMTP RCPT
//                read `findSuppressed`).
//   PST-REQ-181  every change is audited, naming the address, the actor and the reason.
//
// Only 5.1.x is evidence about the *address*. 5.7.x is policy (the remote does not like us, or
// this message), 5.2.x a full mailbox, 4xx is temporary, an expiry bounce is our queue giving up,
// and an admin bounce is an operator's decision about one message: none of those says the address
// is dead, and suppressing on them would silently stop mail to people who can still receive it.
import { recordAudit, type RequestContext } from '@postroom/audit';
import type { Db, Prisma } from '@postroom/db';
import type { AttemptOutcome, Transition } from './state.js';

type Tx = Prisma.TransactionClient | Db;

/** SuppressedRecipient.reason. */
export type SuppressionReason = 'hard-bounce' | 'manual';

/** The enhanced status codes that suppress: class 5, subject 1 (RFC 3463 §3.2, "Address Status"). */
const ADDRESS_STATUS = /^5\.1\.\d{1,3}$/;

/**
 * The key an address is suppressed under: the whole address, trimmed and lowercased. Lowercasing the
 * local part is deliberate: RFC 5321 lets a receiver treat it case-sensitively, but a mailbox that
 * does not exist as `Bob` is not one we want to keep retrying as `bob`, and a list that could be
 * dodged by changing case would not be a list.
 */
export function suppressionKey(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Whether this attempt's result puts the recipient on the suppression list (PST-REQ-176): the
 * transition is a bounce *because the remote said so* (not an expiry), the reply was a 5xx, and its
 * enhanced code is in class 5.1. Pure, so the policy is unit-tested without a database.
 */
export function shouldSuppress(outcome: AttemptOutcome, transition: Pick<Transition, 'state' | 'bounceReason'>): boolean {
  if (transition.state !== 'bounced' || transition.bounceReason !== 'permanent') return false;
  if (outcome.kind !== 'permanent') return false;
  if (outcome.code < 500 || outcome.code > 599) return false;
  return outcome.enhanced !== undefined && ADDRESS_STATUS.test(outcome.enhanced.trim());
}

export interface HardBounce {
  address: string;
  /** The outbound recipient that bounced; null for an asynchronous bounce Postroom could not tie to
   * one (PST-T-11.15: an SES Permanent bounce for a queue row already purged). */
  recipientId: string | null;
  /** The SMTP reply code; null when an asynchronous report gave only an enhanced status. */
  code: number | null;
  enhanced: string;
  text: string;
  at: Date;
  /** The audit row's request id; default `delivery:<recipientId>` (the synchronous bounce path). */
  requestId?: string;
  /** The audit actor's label; default 'delivery'. */
  actorLabel?: string;
}

/**
 * Upsert the hard bounce into the suppression list and audit it, through `tx` (the worker's outcome
 * transaction, so the bounce and its suppression commit together or not at all). A repeat bounce of
 * an address already listed bumps its count and keeps the newest reply; a manual row stays manual.
 * ON CONFLICT rather than read-then-write: two domain groups can bounce one address concurrently.
 */
export async function recordHardBounce(tx: Tx, bounce: HardBounce): Promise<void> {
  const address = suppressionKey(bounce.address);
  const rows = await tx.$queryRaw<{ id: string; bounce_count: number }[]>`
    INSERT INTO suppressed_recipient (address, reason, code, enhanced, text, source_recipient_id, bounce_count, first_at, last_at, created_at)
    VALUES (${address}, 'hard-bounce', ${bounce.code}::int, ${bounce.enhanced}, ${bounce.text}, ${bounce.recipientId}::uuid, 1, ${bounce.at}, ${bounce.at}, ${bounce.at})
    ON CONFLICT (address) DO UPDATE SET
      code = EXCLUDED.code,
      enhanced = EXCLUDED.enhanced,
      text = EXCLUDED.text,
      source_recipient_id = EXCLUDED.source_recipient_id,
      bounce_count = suppressed_recipient.bounce_count + 1,
      last_at = EXCLUDED.last_at
    RETURNING id::text AS id, bounce_count`;
  const row = rows[0];
  await recordAudit(tx, {
    actor: { kind: 'system', label: bounce.actorLabel ?? 'delivery' },
    action: 'suppression.add',
    entityType: 'suppressed_recipient',
    entityId: row?.id ?? null,
    before: null,
    after: {
      address,
      reason: 'hard-bounce',
      code: bounce.code,
      enhanced: bounce.enhanced,
      text: bounce.text,
      sourceRecipientId: bounce.recipientId,
      bounceCount: row?.bounce_count ?? 1,
    },
    context: { requestId: bounce.requestId ?? `delivery:${bounce.recipientId ?? 'none'}` } satisfies RequestContext,
  });
}

export interface SuppressedMatch {
  /** The key it is listed under. */
  address: string;
  reason: string;
  code: number | null;
  enhanced: string | null;
  text: string | null;
}

/** The listed entries among `addresses` (matched by suppressionKey), in key order. */
export async function findSuppressed(tx: Tx, addresses: readonly string[]): Promise<SuppressedMatch[]> {
  const keys = [...new Set(addresses.map(suppressionKey).filter((a) => a !== ''))];
  if (keys.length === 0) return [];
  const rows = await tx.suppressedRecipient.findMany({
    where: { address: { in: keys } },
    select: { address: true, reason: true, code: true, enhanced: true, text: true },
    orderBy: { address: 'asc' },
  });
  return rows;
}
