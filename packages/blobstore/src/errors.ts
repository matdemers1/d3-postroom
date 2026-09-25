// Typed errors. None of them echoes the rejected input: a blob name from a client is untrusted.

export class BlobStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A blob name that is not exactly 64 lowercase hex characters. Raised before any filesystem access. */
export class InvalidBlobNameError extends BlobStoreError {
  constructor() {
    super('invalid blob name: expected 64 lowercase hex characters');
  }
}

/** No row for this blob. */
export class BlobNotFoundError extends BlobStoreError {
  constructor(readonly sha256: string) {
    super(`blob ${sha256} not found`);
  }
}
