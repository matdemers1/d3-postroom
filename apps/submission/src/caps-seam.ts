// The seam PST-T-1.10 (per-credential recipient caps, freeze on trip) plugs into.
//
// Submission calls `checkCaps` exactly once per message, after the message is spooled and signed and
// before the accepting transaction opens, with the authenticated credential and every accepted
// recipient. Until PST-T-1.10 lands (in src/caps/), everything is allowed.
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
