// Recovery codes in the browser (PST-T-16.7, PST-REQ-197): what Copy all and Download .txt hand
// over, and the copy every surface shares. Pure, so it is unit-tested without a DOM.
import { ApiError, describeError } from '../../api';

export const RECOVERY_FILENAME = 'postroom-recovery-codes.txt';
export const SAVED_LABEL = 'I have saved these';
export const USE_RECOVERY_LABEL = 'Use a recovery code instead';
export const USE_AUTHENTICATOR_LABEL = 'Use your authenticator instead';

/** Copy all: one code per line, nothing else, so it pastes cleanly into a password manager. */
export function recoveryCodesClipboard(codes: readonly string[]): string {
  return codes.join('\n');
}

/** Download .txt: the codes with enough around them to make sense when found a year from now. */
export function recoveryCodesText(codes: readonly string[], opts: { address?: string | null; createdAt: Date }): string {
  const issued = opts.createdAt.toISOString().slice(0, 10);
  const lines = [
    opts.address === undefined || opts.address === null || opts.address === ''
      ? 'Postroom recovery codes'
      : `Postroom recovery codes for ${opts.address}`,
    `Issued ${issued}`,
    '',
    'Each code works once, in place of a code from your authenticator app.',
    'Making a new set in Settings › Security & devices stops these from working.',
    '',
    ...codes,
    '',
  ];
  // CRLF, so Notepad shows the lines too.
  return lines.join('\r\n');
}

/** Grouped 5-5 already by the server; this only re-groups a code that arrived without its dash. */
export function displayCode(code: string): string {
  const bare = code.replace(/-/g, '');
  return bare.length === 10 ? `${bare.slice(0, 5)}-${bare.slice(5)}` : code;
}

/** The sign-in error for a recovery code: a used code and a wrong one read the same, on purpose. */
export function describeRecoveryError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'invalid_code') return 'That recovery code didn’t match, or it’s already been used.';
  return describeError(error);
}
