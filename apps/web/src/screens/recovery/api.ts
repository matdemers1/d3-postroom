// Client calls for TOTP recovery codes (PST-T-16.7, PST-REQ-197). Kept beside the screens that use
// them rather than in ../../api, through its shared `call` (CSRF header, error mapping).
import { call } from '../../api';

export interface SetupCompleted {
  ok: true;
  account: { id: string; address: string };
  /** The ten codes, shown once. Absent only from a server older than PST-T-16.7. */
  recoveryCodes?: string[];
}

export interface RecoveryStatus {
  total: number;
  remaining: number;
  /** When the current set was issued; null when the account has none. */
  createdAt: string | null;
}

export const recoveryApi = {
  /** POST /api/auth/setup/complete, read for the recovery codes it now returns. */
  setupComplete: (input: { setupToken: string; enrolToken: string; code: string }) =>
    call<SetupCompleted>('POST', '/api/auth/setup/complete', input),
  status: () => call<RecoveryStatus>('GET', '/api/auth/recovery-codes'),
  /** Needs a step-up from the last five minutes: 403 step_up_required otherwise. */
  regenerate: () => call<{ recoveryCodes: string[]; createdAt: string }>('POST', '/api/auth/recovery-codes'),
};
