// Retention policy (PST-T-7.7, PST-REQ-129): how many days a mailbox keeps a message, and what
// happens when that runs out.
//
// A retention_policy row for the mailbox wins; `days: null` there means "keep forever" and turns a
// default off. Without a row, the mailbox's special use decides:
//   · Junk     30 days, then MOVE to Trash;
//   · Trash    30 days after it entered Trash (message.trashed_at, the visible clock), then EXPUNGE;
//   · Rejects  14 days after it was received (smtp-in's REJECTS_RETENTION_DAYS, the date it already
//              tells the sender-side record, PST-REQ-059), then EXPUNGE;
//   · anything else: no default — kept forever unless a row says otherwise, and then MOVED to Trash.
// Only Trash and Rejects ever expunge: "no silent deletion" means everything else passes through
// Trash first, where the clock starts again.
//
// The API computes the same Trash clock for the message list (apps/api/src/mail/store.ts carries a
// copy of DEFAULT_RETENTION_DAYS.trash); keep the two in step.
import type { SpecialUse } from '@postroom/db';

export const DAY_MS = 86_400_000;

/** Built-in defaults by special use. Mirrors smtp-in's REJECTS_RETENTION_DAYS for Rejects. */
export const DEFAULT_RETENTION_DAYS: Readonly<Partial<Record<SpecialUse, number>>> = {
  junk: 30,
  trash: 30,
  rejects: 14,
};

export type RetentionAction =
  /** Messages whose trashed_at is older than `days` are expunged. */
  | { readonly kind: 'expire-trash'; readonly days: number }
  /** Messages received more than `days` ago are expunged (Rejects only). */
  | { readonly kind: 'expire-rejects'; readonly days: number }
  /** Messages received more than `days` ago move to the account's Trash. */
  | { readonly kind: 'to-trash'; readonly days: number };

/**
 * The effective number of days, or null for "kept forever". `policyDays` is undefined when the
 * mailbox has no retention_policy row, null when the row says forever.
 */
export function effectiveDays(specialUse: SpecialUse | null, policyDays: number | null | undefined): number | null {
  if (policyDays !== undefined) return policyDays;
  return specialUse === null ? null : (DEFAULT_RETENTION_DAYS[specialUse] ?? null);
}

/** What the sweep does to a mailbox, or null when it keeps its messages forever. */
export function retentionAction(specialUse: SpecialUse | null, policyDays: number | null | undefined): RetentionAction | null {
  const days = effectiveDays(specialUse, policyDays);
  if (days === null) return null;
  if (specialUse === 'trash') return { kind: 'expire-trash', days };
  if (specialUse === 'rejects') return { kind: 'expire-rejects', days };
  return { kind: 'to-trash', days };
}
