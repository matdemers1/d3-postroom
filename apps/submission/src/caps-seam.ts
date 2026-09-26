// The seam PST-T-1.10 (per-credential recipient caps, freeze on trip) plugs into.
//
// Two calls, two different guarantees:
//
//   `checkCaps`      — called at RCPT time with this transaction's accepted recipients plus the
//                       candidate. Early and best-effort: a plain read against already-persisted
//                       rows, with no lock. Good enough to refuse most cap-busting sessions before
//                       they finish DATA, but two concurrent sessions can both pass it (PST-ADR
//                       note: the count-then-insert window is real). It must never be the only guard.
//
//   `enforceCaps`     — called once, inside the same transaction that will insert the message's
//                       recipients, before that insert. It takes `pg_advisory_xact_lock` on the
//                       credential first, so only one submission at a time can be mid-decision for
//                       it; a concurrent submission blocks until this transaction commits or rolls
//                       back, then recounts against what actually landed. This is the authoritative
//                       check: exceeding a window here freezes the credential (audited) and throws,
//                       rolling back everything this message would have queued.
//
// Until PST-T-1.10 lands (in src/caps/), everything is allowed and nothing is enforced.
import type { Prisma } from '@postroom/db';
import type { SmtpReply } from '@postroom/smtp-proto';

export interface SubmissionCredential {
  readonly accountId: string;
  readonly appPasswordId: string;
}

export type CapDecision =
  | { readonly action: 'allow' }
  /** Refuse this message with `reply` (a 4xx or 5xx); nothing is queued. */
  | { readonly action: 'reject'; readonly reply: SmtpReply };

export type CheckCaps = (credential: SubmissionCredential, recipients: readonly string[]) => Promise<CapDecision>;

/** The placeholder: no caps yet. */
export const allowAllCaps: CheckCaps = () => Promise.resolve({ action: 'allow' });

/**
 * Run inside the accepting transaction, before the insert. Resolves when the message may proceed;
 * throws {@link CapExceededError} when it may not (the credential is frozen, audited, by the time it
 * throws — the transaction is rolled back by the throw itself, since Prisma only commits a
 * transaction whose callback resolves).
 */
export type EnforceCaps = (
  tx: Prisma.TransactionClient,
  credential: SubmissionCredential,
  recipients: readonly string[],
  now: Date,
) => Promise<void>;

/** The placeholder: nothing enforced. */
export const allowAllEnforcement: EnforceCaps = () => Promise.resolve();

/** Thrown by an `EnforceCaps` that refused the message. `alert`, if present, must be awaited only
 * after the transaction has settled (rolled back): it is a network call and must not hold the
 * transaction open. */
export class CapExceededError extends Error {
  constructor(
    public readonly reply: SmtpReply,
    public readonly alert?: () => Promise<void>,
  ) {
    super('recipient cap exceeded');
    this.name = 'CapExceededError';
  }
}
