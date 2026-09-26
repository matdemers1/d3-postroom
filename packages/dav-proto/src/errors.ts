// The only error classes @postroom/dav-proto throws. Anything else escaping the package is a bug —
// the property tests and the fuzz target (fuzz/dav-proto/target.mjs) both assert exactly that.

/** Base class: every error this package throws is a `DavError`. */
export class DavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DavError';
  }
}

/** Why a document was refused. `dtd` covers every DOCTYPE/ENTITY declaration: XXE is not a mode. */
export type XmlErrorCode = 'syntax' | 'namespace' | 'dtd' | 'entity' | 'limit' | 'encoding';

/** The body is not well-formed, namespace-well-formed XML, or it breaks a limit. */
export class XmlError extends DavError {
  readonly code: XmlErrorCode;
  /** 0-based character offset into the decoded text, when the error is tied to one. */
  readonly offset: number | undefined;
  constructor(code: XmlErrorCode, message: string, offset?: number) {
    super(offset === undefined ? message : `${message} (at ${String(offset)})`);
    this.name = 'XmlError';
    this.code = code;
    this.offset = offset;
  }
}

/**
 * A well-formed request the server must refuse. `status` is the HTTP status to answer with;
 * `condition`, when set, names the precondition element (Clark notation, `{DAV:}propfind-finite-depth`)
 * to put in a DAV:error body (RFC 4918 §16).
 */
export class DavRequestError extends DavError {
  readonly status: number;
  readonly condition: string | undefined;
  constructor(status: number, message: string, condition?: string) {
    super(message);
    this.name = 'DavRequestError';
    this.status = status;
    this.condition = condition;
  }
}
