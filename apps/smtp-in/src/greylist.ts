// Greylisting seam. PST-T-2.8 owns this file and replaces the body; until then every triplet passes.
import type { Db } from '@postroom/db';

export interface GreylistInput {
  /** The real client IP (after PROXY v2). */
  readonly clientIp: string;
  /** MAIL FROM, or null for `<>`. */
  readonly mailFrom: string | null;
  /** The normalised recipient address that was accepted. */
  readonly recipient: string;
}

/** 'defer' makes smtp-in answer the RCPT with 451 4.7.1. */
export type GreylistVerdict = 'pass' | 'defer';

export function checkGreylist(_db: Db | null, _input: GreylistInput): Promise<GreylistVerdict> {
  return Promise.resolve('pass');
}
