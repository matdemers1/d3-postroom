// The first-run setup form's state, kept pure so it can be unit-tested without a DOM or
// @d3cloud/ui's CSS (PST-T-16.6). Two steps: the operator account, then TOTP enrolment. An
// enrolment that dies (the server forgot the enrol token — it lives 15 minutes, and a fifth wrong
// code burns it) returns to the first step with everything typed except the passwords, rather than
// leaving a dead enrolment step on screen (PST-DA-038).
import { ApiError, describeError } from '../../api';

export interface Enrolment {
  enrolToken: string;
  secret: string;
  otpauthUri: string;
}

export interface SetupForm {
  setupToken: string;
  displayName: string;
  login: string;
  password: string;
  confirm: string;
  /** null on the first step; the server's answer to setup/begin on the enrolment step. */
  enrol: Enrolment | null;
  code: string;
  error: string | null;
}

export const EMPTY_SETUP_FORM: SetupForm = {
  setupToken: '',
  displayName: '',
  login: '',
  password: '',
  confirm: '',
  enrol: null,
  code: '',
  error: null,
};

/** What the banner says when the enrolment expired and the form went back to the first step. */
export const EXPIRED_MESSAGE = 'That took too long — press Continue to get a new key.';

/**
 * Whether a setup/complete refusal means the enrol token itself is gone or unusable, so retrying
 * the code can never succeed: `setup_expired`, or a 400 that names the `enrolToken` field.
 */
export function isEnrolTokenError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === 'setup_expired') return true;
  if (error.code !== 'invalid_request') return false;
  const body = error.body as { fields?: { path?: unknown }[] } | null | undefined;
  return Array.isArray(body?.fields) && body.fields.some((f) => f.path === 'enrolToken');
}

/** Back to the first step: setup token, display name and login kept; passwords and code cleared. */
export function restart(form: SetupForm, error: string | null): SetupForm {
  return { ...form, password: '', confirm: '', enrol: null, code: '', error };
}

/**
 * The form after setup/complete refused. An enrol-token error restarts the form; anything else
 * (a wrong code, the server unreachable) stays on the enrolment step with the code cleared.
 */
export function afterCompleteFailure(form: SetupForm, caught: unknown): SetupForm {
  if (isEnrolTokenError(caught)) return restart(form, EXPIRED_MESSAGE);
  return { ...form, code: '', error: describeError(caught) };
}

/** The 'Start over' button on the enrolment step: the first step again, no banner. */
export function startOver(form: SetupForm): SetupForm {
  return restart(form, null);
}

/**
 * A TOTP key in four-character groups, for reading and typing by hand. The groups are rendered as
 * separate elements rather than joined with spaces, so selecting and copying the key still gives
 * the ungrouped secret; this is the list of groups.
 */
export function keyGroups(secret: string): string[] {
  const groups: string[] = [];
  for (let i = 0; i < secret.length; i += 4) groups.push(secret.slice(i, i + 4));
  return groups;
}

/** Where the operator lands after Finish setup: the setup wizard, not an empty Inbox (PST-DA-036). */
export const AFTER_SETUP = '/admin/setup';
