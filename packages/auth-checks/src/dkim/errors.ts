// Typed DKIM errors. None carries key material; header text is quoted only by field name.

export class DkimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The header block exceeded the configured bound before the blank line was found. */
export class HeaderTooLargeError extends DkimError {}
