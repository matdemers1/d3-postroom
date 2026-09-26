// Authentication throttling with a tarpit and audit for IMAP, submission, DAV and ManageSieve.
export const PACKAGE = '@postroom/auth-throttle';

export { createAuthThrottle } from './throttle.js';
export type { AuthAttempt, AuthThrottle, AuthThrottleOptions, Gate, GateOutcome, Sleep } from './throttle.js';
export { auditLedger, memoryLedger, FAILURE_ACTION, FAILURE_ENTITY } from './ledger.js';
export type { FailureCounts, FailureEntry, FailureLedger, FailureQuery } from './ledger.js';
export { networkOf, normalizeIp, sourceOf } from './network.js';
