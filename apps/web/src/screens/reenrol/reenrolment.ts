// TOTP re-enrolment after a recovery-code sign-in (PST-T-16.26, PST-REQ-200): the copy and the
// decisions the screen makes, kept pure so they are unit-tested without a DOM or @d3cloud/ui's CSS.
import { ApiError, describeError } from '../../api';

export const REENROL_TITLE = 'Set up a new authenticator';
export const REENROL_DESCRIPTION =
  'You signed in with a recovery code, so replace the authenticator you lost before going on.';
export const REENROL_SUBMIT_LABEL = 'Set up authenticator';
export const REENROL_CONTINUE_LABEL = 'Continue to Postroom';
/** The banner when the key expired and a new one replaced it. */
export const REENROL_EXPIRED_MESSAGE = 'That took too long, so here’s a new key. Scan it again.';

/** Whether a sign-in answer says the session has to set up a new authenticator first. */
export function needsReenrol(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { reenrolRequired?: unknown }).reenrolRequired === true;
}

/** Whether a complete refusal means the key itself is gone, so only a new one can help. */
export function isReenrolKeyGone(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'reenrol_expired';
}

/** Whether a refusal means this session needs no re-enrolment (it was finished elsewhere). */
export function isReenrolDone(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'reenrol_not_required';
}

/** A sentence for a refusal on the re-enrolment screen. */
export function describeReenrolError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_code':
        return 'That code didn’t match. Enter the one your new authenticator shows now.';
      case 'reenrol_expired':
        return REENROL_EXPIRED_MESSAGE;
      case 'reenrol_not_required':
        return 'This session already has a working authenticator.';
      case 'totp_reenrol_required':
        return 'You signed in with a recovery code. Set up a new authenticator first.';
      default:
        break;
    }
  }
  return describeError(error);
}
