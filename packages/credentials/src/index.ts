// App passwords: generate, hash, scope, verify for the protocol daemons (PST-REQ-027).
export const PACKAGE = '@postroom/credentials';

export {
  BASE32_ALPHABET,
  PREFIX_LENGTH,
  SECRET_LENGTH,
  generateAppPassword,
  groupForDisplay,
  parseAppPassword,
  randomBase32,
  type GeneratedAppPassword,
  type ParsedAppPassword,
} from './generate.js';
export { APP_PASSWORD_ARGON2_OPTIONS, hashAppPassword, verifyAppPasswordHash } from './hash.js';
export {
  APP_PASSWORD_SCOPES,
  MAX_LABEL_LENGTH,
  CredentialError,
  createAppPassword,
  isScope,
  listAppPasswords,
  revokeAppPassword,
  toView,
  type AppPasswordView,
  type CreateAppPasswordInput,
  type CreatedAppPassword,
  type CredentialErrorCode,
  type CredentialOptions,
  type RevokeAppPasswordInput,
} from './store.js';
export {
  verifyProtocolLogin,
  type ProtocolLoginFailure,
  type ProtocolLoginOptions,
  type ProtocolLoginRequest,
  type ProtocolLoginResult,
} from './verify.js';
