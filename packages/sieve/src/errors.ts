// The only two error classes this package ever throws (PST-REQ-088: the fuzz target asserts it).
// A SieveSyntaxError is a compile-time rejection — lexing, parsing or validation — and always names
// the line and column it refers to. A SieveRuntimeError is raised while a compiled script runs; the
// interpreter catches it and falls back to the implicit keep (RFC 5228 §2.10.6), so callers of
// `execute` only ever see it as `result.error`.

export interface SourcePos {
  /** 1-based line. */
  readonly line: number;
  /** 1-based column, in UTF-16 code units. */
  readonly column: number;
}

export type SyntaxErrorCode =
  | 'too-large'
  | 'bad-char'
  | 'unterminated-string'
  | 'unterminated-comment'
  | 'unterminated-text'
  | 'bad-number'
  | 'string-too-long'
  | 'list-too-long'
  | 'too-deep'
  | 'unexpected-token'
  | 'unknown-command'
  | 'unknown-test'
  | 'unknown-extension'
  | 'not-required'
  | 'require-position'
  | 'bad-arguments'
  | 'bad-value'
  | 'orphan-else';

export class SieveSyntaxError extends Error {
  override readonly name = 'SieveSyntaxError';
  readonly code: SyntaxErrorCode;
  readonly line: number;
  readonly column: number;
  /** The message without the position prefix. */
  readonly detail: string;

  constructor(code: SyntaxErrorCode, detail: string, pos: SourcePos) {
    super(`line ${pos.line}, column ${pos.column}: ${detail}`);
    this.code = code;
    this.line = pos.line;
    this.column = pos.column;
    this.detail = detail;
  }
}

export type RuntimeErrorCode = 'work-limit' | 'action-limit' | 'bad-value' | 'duplicate-vacation';

export class SieveRuntimeError extends Error {
  override readonly name = 'SieveRuntimeError';
  readonly code: RuntimeErrorCode;
  readonly line: number;
  readonly column: number;
  readonly detail: string;

  constructor(code: RuntimeErrorCode, detail: string, pos: SourcePos) {
    super(`line ${pos.line}, column ${pos.column}: ${detail}`);
    this.code = code;
    this.line = pos.line;
    this.column = pos.column;
    this.detail = detail;
  }
}

export function isSieveError(err: unknown): err is SieveSyntaxError | SieveRuntimeError {
  return err instanceof SieveSyntaxError || err instanceof SieveRuntimeError;
}
