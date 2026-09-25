// KEK load, per-blob DEKs, AEAD wrap/unwrap and the sealed KEK recovery bundle (PST-ADR-009).
export const PACKAGE = '@postroom/crypto';

export { BundleUnsealError, CryptoError, DecryptError, KekLoadError } from './errors.js';
export {
  exportKekBase64,
  generateKek,
  Kek,
  KEK_BYTES,
  KEK_ENV_VAR,
  kekFromBase64,
  loadKek,
  type KekSource,
} from './kek.js';
export {
  DEK_BYTES,
  decryptBuffer,
  encryptBuffer,
  generateDek,
  openWithKek,
  sealedKekId,
  sealWithKek,
  unwrapDek,
  wrapDek,
  WRAPPED_DEK_BYTES,
  type Aad,
} from './aead.js';
export {
  createDecryptStream,
  createEncryptStream,
  encryptedSize,
  SEGMENT_BYTES,
  STREAM_HEADER_BYTES,
} from './stream.js';
export {
  BUNDLE_VERSION,
  DEFAULT_KDF_PARAMS,
  sealKekBundle,
  serializeKekBundle,
  unsealKekBundle,
  type KdfParams,
  type KekBundle,
  type SealOptions,
} from './bundle.js';
export { sha256Hex, timingSafeEqualStr } from './hash.js';
