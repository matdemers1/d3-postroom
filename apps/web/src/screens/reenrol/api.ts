// Client calls for TOTP re-enrolment after a recovery-code sign-in (PST-T-16.26, PST-REQ-200). Kept
// beside the screen that uses them rather than in ../../api, through its shared `call` (CSRF header,
// error mapping).
import { call } from '../../api';

/** The second sign-in step's answer, read for whether the session must re-enrol first. */
export interface SignedIn {
  next: 'done';
  account?: { id: string; displayName: string; isAdmin: boolean };
  /** True when a recovery code signed this session in: 'Set up a new authenticator' comes next. */
  reenrolRequired?: boolean;
}

/** A new TOTP key bound to this session. Nothing on the account changes until a code proves it. */
export interface ReenrolKey {
  secret: string;
  otpauthUri: string;
  expiresAt: string;
  /** The account's address, for the recovery-codes download. */
  address: string | null;
}

export interface ReenrolCompleted {
  ok: true;
  /** The ten new recovery codes, shown once. */
  recoveryCodes: string[];
  createdAt: string;
}

export const reenrolApi = {
  /** POST /api/auth/signin/totp, read for `reenrolRequired`. */
  signInTotp: (input: { challenge: string; code: string }) => call<SignedIn>('POST', '/api/auth/signin/totp', input),
  /** 409 reenrol_not_required when this session signed in with its authenticator. */
  begin: () => call<ReenrolKey>('POST', '/api/auth/totp/reenrol/begin'),
  /** 401 invalid_code for a wrong code; 400 reenrol_expired when the key has gone. */
  complete: (code: string) => call<ReenrolCompleted>('POST', '/api/auth/totp/reenrol/complete', { code }),
};
