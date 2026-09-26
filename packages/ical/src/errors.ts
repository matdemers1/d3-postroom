// The only error classes @postroom/ical throws. Anything else escaping the package is a bug — the
// property tests and the fuzz target (fuzz/ical/target.mjs) both assert exactly that.

/** Base class: every error this package throws is an `ICalError`. */
export class ICalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ICalError';
  }
}

/** The input is not well-formed iCalendar (or a value is not of its declared type). */
export class ICalParseError extends ICalError {
  /** 1-based physical line number, when the error is tied to one. */
  readonly line: number | undefined;
  constructor(message: string, line?: number) {
    super(line === undefined ? message : `line ${String(line)}: ${message}`);
    this.name = 'ICalParseError';
    this.line = line;
  }
}

/** The input exceeds a configured bound (size, nesting depth, property count). */
export class ICalLimitError extends ICalError {
  constructor(message: string) {
    super(message);
    this.name = 'ICalLimitError';
  }
}
