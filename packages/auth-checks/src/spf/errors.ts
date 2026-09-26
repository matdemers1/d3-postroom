// Typed SPF errors (RFC 7208 SS2.6). Callers branch on `instanceof`, never on message text.
// A "permerror" is a syntax or policy problem the publishing domain must fix; a "temperror" is
// this evaluation's DNS trouble and may succeed on retry. Neither is thrown out of
// `evaluateSpf` - `check_host` throws them internally and the top level maps them to a result.

export class SpfPermError extends Error {
  constructor(
    message: string,
    public readonly mechanism?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class SpfTempError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
