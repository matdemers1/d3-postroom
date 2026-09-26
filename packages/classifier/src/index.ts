// Signal extraction and sorting for the self-sorting inbox — every decision stores its reasons (PST-ADR-007).
export const PACKAGE = '@postroom/classifier';

export {
  extractSignals,
  normalizeAddress,
  type AccountContext,
  type AccountPins,
  type AuthResultLike,
  type AuthVerdicts,
  type DirectnessSignal,
  type Directness,
  type DmarcResultLike,
  type HeaderLike,
  type MembershipSignals,
  type Signal,
  type SignalInput,
  type Signals,
} from './signals.js';

export { decide, type Bucket, type Decision } from './decide.js';
