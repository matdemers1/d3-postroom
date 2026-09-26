// Every parser in this package throws only its own error type, so a caller (and the fuzz target)
// can tell "this input is malformed" from "this code has a bug".

/** Malformed or unsupported OpenPGP input. `reason` is a short, stable, kebab-case name. */
export class PgpError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'PgpError';
    this.reason = reason;
  }
}

/** Something this package deliberately does not implement (a v6 key, SEIPD v2, a primitive Node lacks). */
export class UnsupportedError extends PgpError {
  constructor(reason: string, message?: string) {
    super(reason, message);
    this.name = 'UnsupportedError';
  }
}

/** Malformed DER/BER. The only error the DER reader throws. */
export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerError';
  }
}

/**
 * Valid BER that is not DER (X.690 §10): an indefinite length, or a length not in its shortest
 * form. Its own type so a caller can name "this sender used BER" apart from "this is garbage";
 * it is still a DerError, so "the DER reader throws only DerError" holds.
 */
export class NotDerError extends DerError {
  constructor(message: string) {
    super(message);
    this.name = 'NotDerError';
  }
}

/** Malformed or unsupported CMS/PKCS#7 structure. */
export class CmsError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'CmsError';
    this.reason = reason;
  }
}

/** Malformed ASCII armor or radix-64. */
export class ArmorError extends PgpError {
  constructor(reason: string, message?: string) {
    super(reason, message);
    this.name = 'ArmorError';
  }
}
