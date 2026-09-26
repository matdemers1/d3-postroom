// The only error classes @postroom/vcard throws. Anything else escaping the package is a bug — the
// property tests and the fuzz target (fuzz/vcard/target.mjs) both assert exactly that.

/** Base class: every error this package throws is a `VCardError`. */
export class VCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VCardError';
  }
}

/** The input is not a well-formed vCard. */
export class VCardParseError extends VCardError {
  /** 1-based physical line number, when the error is tied to one. */
  readonly line: number | undefined;
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `line ${String(line)}: ${message}`);
    this.name = 'VCardParseError';
    this.line = line;
  }
}

/** The input exceeds a configured bound (size, line count, card count). */
export class VCardLimitError extends VCardError {
  constructor(message: string) {
    super(message);
    this.name = 'VCardLimitError';
  }
}
