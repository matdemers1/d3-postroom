// Typed errors. None of them ever carries key material, a passphrase, or the input that was
// rejected: a message that echoes a key is a key in a log file.

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The KEK could not be loaded: missing, not base64, or not exactly 32 bytes. */
export class KekLoadError extends CryptoError {}

/**
 * Authenticated decryption failed: wrong key, wrong AAD, a flipped bit, a truncated or reordered
 * stream, or an unknown format version. Callers must treat the data as untrusted and absent.
 */
export class DecryptError extends CryptoError {}

/** A recovery bundle would not unseal: wrong passphrase, tampered bundle, or malformed fields. */
export class BundleUnsealError extends CryptoError {}
