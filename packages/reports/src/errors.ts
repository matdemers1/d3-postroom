// The only error any function in this package throws on bad input (PST-REQ-088): a parser that
// throws anything else on hostile bytes is a bug, and the fuzz target says so.

export type ReportErrorCode =
  /** Input (or a decompressed payload) exceeds a size limit — the decompression-bomb guard included. */
  | 'too-large'
  /** Elements nested deeper than the limit. */
  | 'too-deep'
  /** More elements, attributes or records than the limit. */
  | 'too-many'
  /** Not well-formed XML. */
  | 'xml-syntax'
  /** A DOCTYPE: refused outright, so no external entity and no entity expansion can ever happen. */
  | 'dtd-refused'
  /** An entity reference other than the five predefined ones or a character reference. */
  | 'unknown-entity'
  /** The XML declares an encoding other than UTF-8 / US-ASCII. */
  | 'unsupported-encoding'
  /** Not valid JSON. */
  | 'json-syntax'
  /** Well-formed, but not a DMARC aggregate report (wrong root, missing required element). */
  | 'not-dmarc'
  /** Well-formed JSON, but not a TLS-RPT report. */
  | 'not-tlsrpt'
  /** A required field is present but its value is out of range or of the wrong shape. */
  | 'invalid-field'
  /** A gzip stream that does not inflate. */
  | 'gzip'
  /** A ZIP archive this reader refuses: encrypted, ZIP64, unknown method, bad CRC, several reports. */
  | 'zip';

export class ReportError extends Error {
  override readonly name = 'ReportError';
  constructor(
    readonly code: ReportErrorCode,
    message: string,
  ) {
    super(message);
  }
}
