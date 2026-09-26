// The streaming IMAP command reader (PST-REQ-070; literal abuse is PST-T-4.1's adversarial suite).
//
// A byte-level state machine fed Buffers at arbitrary boundaries. It splits the client's stream into
// whole commands — the text lines and the literals between them — without tokenising anything but
// the literal markers at the end of each line, and hands each complete command to `parseCommand`.
//
// Lines end ONLY at CRLF. A bare LF or a lone CR fails the command (tagged BAD) and the reader
// resynchronises at the next line end.
//
// Literals:
//   {n}    synchronizing: the reader emits `continue`; the daemon answers "+ ..." (or refuses the
//          literal with a tagged NO/BAD and calls `rejectLiteral()`, since the client will not send
//          it). The reader carries on reading the literal's bytes either way unless refused.
//   {n+}   non-synchronizing (RFC 7888). Under LITERAL- only n ≤ 4096 is allowed; a larger one
//          means the client is already sending bytes we cannot interpret, so it is fatal (BYE and
//          close). With `literalMode: 'none'` every {n+} is fatal.
//   ~{n}   literal8 (RFC 3516) — accepted anywhere by the reader; the parser decides where it is legal.
//
// APPEND's message literal is never buffered: the reader recognises the APPEND command and emits
// `append-begin` (with the command text before it, for `parseAppendPrefix`), then `append-data`
// slices as they arrive, then `append-end` with whatever followed the literal on the line (normally
// nothing). Every other literal is buffered into the command, bounded by `maxCommandSize`.
//
// Limits (each violation is an `error` event carrying the tag when it is known):
//   maxLineLength   one text line, excluding CRLF and literal data            (64 KiB)
//   maxCommandSize  a whole command, text plus buffered literals, not APPEND data (1 MiB)
//   maxLiterals     literals in one command                                  (64)
//   maxAppendSize   one APPEND message literal                               (100 MB)
// A non-fatal error drops the rest of the command — including any non-synchronizing literals it
// announces, whose bytes are skipped without being kept — and reading resumes with the next command.
//
// Memory: the reader holds the chunks pushed and not yet consumed, one partial line (≤ maxLineLength)
// and the command being assembled (≤ maxCommandSize). Callers push one chunk, then pull events until
// `next()` returns null. `append-data` chunks are slices of the pushed buffer: consume or copy them
// before pushing again.

export type LiteralMode = 'literal-' | 'literal+' | 'none';

export interface CommandReaderOptions {
  readonly maxLineLength?: number;
  readonly maxCommandSize?: number;
  readonly maxLiterals?: number;
  readonly maxAppendSize?: number;
  readonly literalMode?: LiteralMode;
}

export type ReaderErrorCode =
  | 'bare-lf'
  | 'bare-cr'
  | 'line-too-long'
  | 'command-too-large'
  | 'literal-too-large'
  | 'too-many-literals'
  | 'non-sync-literal-too-large'
  | 'non-sync-literal-refused';

export interface ReaderError {
  readonly code: ReaderErrorCode;
  /** The command's tag when it could be read, so the daemon can answer "<tag> BAD ...". */
  readonly tag: string | null;
  /** Fatal: the stream can no longer be interpreted; send "* BYE" and close. */
  readonly fatal: boolean;
  readonly message: string;
}

export type ReaderEvent =
  /** A whole command: the wire bytes without the final CRLF, literals inline. A copy. */
  | { readonly type: 'command'; readonly tag: string | null; readonly bytes: Buffer }
  /** A synchronizing literal was announced; answer "+ ..." or call `rejectLiteral()`. */
  | { readonly type: 'continue'; readonly tag: string | null; readonly size: number }
  /**
   * An APPEND message literal begins. `prefix` is the command text up to and including the literal
   * marker (for `parseAppendPrefix`); when `continued`, it is only the text after the previous
   * message (MULTIAPPEND). When `synchronizing`, answer "+ ..." or call `rejectLiteral()`.
   */
  | {
      readonly type: 'append-begin';
      readonly tag: string | null;
      readonly prefix: Buffer;
      readonly size: number;
      readonly binary: boolean;
      readonly synchronizing: boolean;
      readonly continued: boolean;
    }
  /** Message bytes; a slice of a pushed chunk. */
  | { readonly type: 'append-data'; readonly chunk: Buffer }
  /** The APPEND command ended; `trailing` is the text after the last message literal (normally empty). */
  | { readonly type: 'append-end'; readonly tag: string | null; readonly trailing: Buffer }
  /** A line read verbatim after `expectRawLine()` (IDLE's DONE, an AUTHENTICATE response). */
  | { readonly type: 'raw-line'; readonly line: Buffer }
  | { readonly type: 'error'; readonly error: ReaderError };

export const DEFAULT_MAX_LINE_LENGTH = 64 * 1024;
export const DEFAULT_MAX_COMMAND_SIZE = 1024 * 1024;
export const DEFAULT_MAX_LITERALS = 64;
export const DEFAULT_MAX_APPEND_SIZE = 100 * 1000 * 1000;
/** RFC 7888 §4: the largest non-synchronizing literal a LITERAL- server accepts. */
export const LITERAL_MINUS_MAX = 4096;

const CR = 13;
const LF = 10;
const SP = 32;
const CRLF = Buffer.from('\r\n');
/** Long enough to hold "~{" + 20 digits + "+}" + CR. */
const TAIL = 32;

export interface LiteralMarker {
  /** Offset of the marker ("{" or "~") within the line. */
  readonly start: number;
  /** Announced size; `Infinity` when the digits do not fit. */
  readonly size: number;
  readonly nonSync: boolean;
  readonly binary: boolean;
}

/** The literal marker ending a line (without CRLF), if any: `{n}`, `{n+}`, `~{n}`, `~{n+}`. */
export function literalMarkerAt(line: Buffer): LiteralMarker | null {
  let i = line.length - 1;
  if (line[i] !== 0x7d) return null; // }
  i--;
  const nonSync = line[i] === 0x2b; // +
  if (nonSync) i--;
  const digitsEnd = i + 1;
  while (i >= 0 && (line[i] ?? 0) >= 0x30 && (line[i] ?? 0) <= 0x39) i--;
  if (i + 1 === digitsEnd || line[i] !== 0x7b) return null; // {
  const digits = line.toString('latin1', i + 1, digitsEnd);
  const size = digits.length > 15 ? Infinity : Number(digits);
  const binary = i > 0 && line[i - 1] === 0x7e; // ~
  return { start: binary ? i - 1 : i, size, nonSync, binary };
}

function isTagChar(c: number): boolean {
  // ASTRING-CHAR minus "+": CHAR except atom-specials, plus "]".
  return c > 0x20 && c < 0x7f && c !== 0x28 && c !== 0x29 && c !== 0x7b && c !== 0x25 && c !== 0x2a && c !== 0x22 && c !== 0x5c && c !== 0x2b;
}

/** The tag at the start of a command's first line, or null if it has none that is valid. */
export function extractTag(line: Buffer): string | null {
  const limit = Math.min(line.length, 256);
  let i = 0;
  while (i < limit && isTagChar(line[i] ?? 0)) i++;
  if (i === 0 || line[i] !== SP) return null;
  return line.toString('latin1', 0, i);
}

/** For "tag APPEND ..." returns the offset of the first argument; otherwise -1. */
function appendArgStart(line: Buffer, tag: string | null): number {
  if (tag === null) return -1;
  const at = tag.length + 1;
  if (line.length < at + 7) return -1;
  if (line.toString('latin1', at, at + 6).toUpperCase() !== 'APPEND' || line[at + 6] !== SP) return -1;
  return at + 7;
}

type Mode = 'line' | 'literal' | 'append' | 'discard' | 'skip' | 'dead';

export class CommandReader {
  readonly maxLineLength: number;
  readonly maxCommandSize: number;
  readonly maxLiterals: number;
  readonly maxAppendSize: number;
  readonly literalMode: LiteralMode;

  private readonly queue: Buffer[] = [];
  private offset = 0;
  private readonly events: ReaderEvent[] = [];
  private mode: Mode = 'line';

  // The line being read.
  private lineParts: Buffer[] = [];
  private lineLen = 0;
  private rawLine = false;

  // The command being assembled.
  private parts: Buffer[] = [];
  private cmdSize = 0;
  private fragment = 0;
  private tag: string | null = null;
  private appendAt = -1;
  private appendStreamed = false;
  private literals = 0;
  private remaining = 0;
  private awaitingSync = false;

  // Discarding the rest of a failed command.
  private tail = Buffer.alloc(0);

  constructor(options: CommandReaderOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    this.maxCommandSize = options.maxCommandSize ?? DEFAULT_MAX_COMMAND_SIZE;
    this.maxLiterals = options.maxLiterals ?? DEFAULT_MAX_LITERALS;
    this.maxAppendSize = options.maxAppendSize ?? DEFAULT_MAX_APPEND_SIZE;
    this.literalMode = options.literalMode ?? 'literal-';
  }

  /** Octets held: unconsumed input, the partial line and the command being assembled. */
  get bufferedBytes(): number {
    let queued = 0;
    for (const c of this.queue) queued += c.length;
    return queued - this.offset + this.lineLen + this.cmdSize;
  }

  /** True after a fatal error; everything pushed from then on is ignored. */
  get dead(): boolean {
    return this.mode === 'dead';
  }

  push(chunk: Uint8Array): void {
    if (this.mode === 'dead' || chunk.length === 0) return;
    this.queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
  }

  next(): ReaderEvent | null {
    if (this.events.length === 0) this.pump();
    return this.events.shift() ?? null;
  }

  /**
   * Refuse the synchronizing literal just announced by a `continue` or `append-begin` event (the
   * daemon has answered with a tagged NO/BAD, so the client will not send it). The command is
   * dropped. Returns false if there is no such literal pending.
   */
  rejectLiteral(): boolean {
    if (!this.awaitingSync || this.events.length > 0) return false;
    this.awaitingSync = false;
    this.resetCommand();
    this.mode = 'line';
    return true;
  }

  /** Read the next line verbatim, with no literal processing (IDLE's DONE, SASL responses). */
  expectRawLine(): void {
    this.rawLine = true;
  }

  private pump(): void {
    this.awaitingSync = false;
    while (this.events.length === 0 && this.mode !== 'dead') {
      if (this.mode === 'literal' && this.remaining === 0) {
        this.mode = 'line';
        continue;
      }
      if (this.mode === 'append' && this.remaining === 0) {
        this.mode = 'line';
        continue;
      }
      if (this.mode === 'skip' && this.remaining === 0) {
        this.mode = 'discard';
        continue;
      }
      const chunk = this.queue[0];
      if (!chunk) return;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
        continue;
      }
      switch (this.mode) {
        case 'line':
          this.stepLine(chunk);
          break;
        case 'literal': {
          const n = Math.min(this.remaining, chunk.length - this.offset);
          this.parts.push(Buffer.from(chunk.subarray(this.offset, this.offset + n)));
          this.offset += n;
          this.remaining -= n;
          break;
        }
        case 'append': {
          const n = Math.min(this.remaining, chunk.length - this.offset);
          this.events.push({ type: 'append-data', chunk: chunk.subarray(this.offset, this.offset + n) });
          this.offset += n;
          this.remaining -= n;
          break;
        }
        case 'skip': {
          const n = Math.min(this.remaining, chunk.length - this.offset);
          this.offset += n;
          this.remaining -= n;
          break;
        }
        case 'discard':
          this.stepDiscard(chunk);
          break;
      }
    }
  }

  private stepLine(chunk: Buffer): void {
    const lf = chunk.indexOf(LF, this.offset);
    const end = lf < 0 ? chunk.length : lf;
    const piece = chunk.subarray(this.offset, end);
    // +1: the CR before LF is still in the line at this point.
    if (this.lineLen + piece.length > this.maxLineLength + 1) {
      const head = Buffer.concat([...this.lineParts, piece.subarray(0, 256)]);
      const tag = this.fragment === 0 && !this.rawLine ? extractTag(head) : this.tag;
      this.rawLine = false;
      // The tail may straddle what was already collected: keep the line's last TAIL octets.
      this.tail = Buffer.from(Buffer.concat([...this.lineParts, piece]).subarray(-TAIL));
      this.lineParts = [];
      this.lineLen = 0;
      this.offset = end;
      this.emitError('line-too-long', tag, false, `line longer than ${this.maxLineLength} octets`);
      this.resetCommand();
      this.tag = tag;
      this.mode = 'discard';
      return;
    }
    if (piece.length > 0) {
      this.lineParts.push(Buffer.from(piece));
      this.lineLen += piece.length;
    }
    if (lf < 0) {
      this.offset = chunk.length;
      return;
    }
    this.offset = lf + 1;
    const raw = this.lineParts.length === 1 ? (this.lineParts[0] ?? Buffer.alloc(0)) : Buffer.concat(this.lineParts);
    this.lineParts = [];
    this.lineLen = 0;
    this.completeLine(raw);
  }

  private completeLine(raw: Buffer): void {
    const crlf = raw.length > 0 && raw[raw.length - 1] === CR;
    const line = crlf ? raw.subarray(0, raw.length - 1) : raw;
    const first = this.fragment === 0 && !this.rawLine;
    const tag = first ? extractTag(line) : this.tag;
    if (!crlf) {
      this.failLine('bare-lf', tag, line, 'line ended with a bare LF; IMAP lines end with CRLF');
      return;
    }
    if (line.includes(CR)) {
      this.failLine('bare-cr', tag, line, 'bare CR inside a line');
      return;
    }
    if (this.rawLine) {
      this.rawLine = false;
      this.events.push({ type: 'raw-line', line });
      return;
    }
    if (line.length > this.maxLineLength) {
      {
      this.failLine('line-too-long', tag, line, `line longer than ${this.maxLineLength} octets`);
      return;
    }
    }
    if (first) {
      this.tag = tag;
      this.appendAt = appendArgStart(line, tag);
    }
    const marker = literalMarkerAt(line);
    this.cmdSize += line.length + (marker ? 2 : 0);
    if (this.cmdSize > this.maxCommandSize) {
      {
      this.failLine('command-too-large', tag, line, `command larger than ${this.maxCommandSize} octets`);
      return;
    }
    }
    if (!marker) {
      if (this.appendStreamed) {
        this.events.push({ type: 'append-end', tag, trailing: line });
      } else {
        this.parts.push(line);
        const bytes = this.parts.length === 1 ? line : Buffer.concat(this.parts);
        this.events.push({ type: 'command', tag, bytes });
      }
      this.resetCommand();
      return;
    }
    this.literals++;
    if (this.literals > this.maxLiterals) {
      {
      this.failLine('too-many-literals', tag, line, `more than ${this.maxLiterals} literals in one command`);
      return;
    }
    }
    if (marker.nonSync && this.nonSyncFatal(marker, tag)) return;
    const streaming = this.appendAt >= 0 && !(first && marker.start === this.appendAt);
    this.fragment++;
    if (streaming) {
      if (marker.size > this.maxAppendSize) {
        {
      this.failLine('literal-too-large', tag, line, `message literal larger than ${this.maxAppendSize} octets`);
      return;
    }
      }
      const prefix = this.appendStreamed ? line : Buffer.concat([...this.parts, line]);
      this.events.push({
        type: 'append-begin',
        tag,
        prefix,
        size: marker.size,
        binary: marker.binary,
        synchronizing: !marker.nonSync,
        continued: this.appendStreamed,
      });
      this.appendStreamed = true;
      this.parts = [];
      this.cmdSize = 0;
      this.mode = 'append';
      this.remaining = marker.size;
      this.awaitingSync = !marker.nonSync;
      return;
    }
    if (this.cmdSize + marker.size > this.maxCommandSize) {
      {
      this.failLine('literal-too-large', tag, line, `literal would make the command larger than ${this.maxCommandSize} octets`);
      return;
    }
    }
    this.parts.push(line, CRLF);
    this.cmdSize += marker.size;
    this.mode = 'literal';
    this.remaining = marker.size;
    if (!marker.nonSync) {
      this.events.push({ type: 'continue', tag, size: marker.size });
      this.awaitingSync = true;
    }
  }

  /** Emits the fatal error and returns true when a non-synchronizing literal cannot be accepted. */
  private nonSyncFatal(marker: LiteralMarker, tag: string | null): boolean {
    if (this.literalMode === 'none') {
      this.emitError('non-sync-literal-refused', tag, true, 'non-synchronizing literals are not supported');
      return true;
    }
    if (this.literalMode === 'literal-' && marker.size > LITERAL_MINUS_MAX) {
      this.emitError('non-sync-literal-too-large', tag, true, `non-synchronizing literal larger than ${LITERAL_MINUS_MAX} octets (LITERAL-)`);
      return true;
    }
    return false;
  }

  /**
   * The command fails at a complete line. If that line announces a non-synchronizing literal the
   * client is already sending it: skip its bytes (or give up, if it could not be allowed at all) and
   * discard the rest of the command.
   */
  private failLine(code: ReaderErrorCode, tag: string | null, line: Buffer, message: string): void {
    this.rawLine = false;
    this.emitError(code, tag, false, message);
    this.resetCommand();
    this.afterFailedLine(line, tag);
  }

  private afterFailedLine(line: Buffer, tag: string | null): void {
    const marker = literalMarkerAt(line);
    if (!marker || !marker.nonSync) {
      this.mode = 'line';
      return;
    }
    if (this.nonSyncFatal(marker, tag) || !Number.isFinite(marker.size)) {
      if (this.mode !== 'dead') this.emitError('non-sync-literal-too-large', tag, true, 'unbounded non-synchronizing literal');
      return;
    }
    this.tag = tag;
    this.mode = 'skip';
    this.remaining = marker.size;
  }

  private stepDiscard(chunk: Buffer): void {
    const lf = chunk.indexOf(LF, this.offset);
    const end = lf < 0 ? chunk.length : lf;
    const piece = chunk.subarray(this.offset, end);
    this.tail =
      piece.length >= TAIL
        ? Buffer.from(piece.subarray(piece.length - TAIL))
        : Buffer.concat([this.tail, piece]).subarray(-TAIL);
    if (lf < 0) {
      this.offset = chunk.length;
      return;
    }
    this.offset = lf + 1;
    const t = this.tail[this.tail.length - 1] === CR ? this.tail.subarray(0, this.tail.length - 1) : this.tail;
    this.tail = Buffer.alloc(0);
    const tag = this.tag;
    this.resetCommand();
    this.afterFailedLine(t, tag);
  }

  private emitError(code: ReaderErrorCode, tag: string | null, fatal: boolean, message: string): void {
    this.events.push({ type: 'error', error: { code, tag, fatal, message } });
    if (fatal) {
      this.mode = 'dead';
      this.queue.length = 0;
      this.offset = 0;
      this.resetCommand();
      this.lineParts = [];
      this.lineLen = 0;
    }
  }

  private resetCommand(): void {
    this.parts = [];
    this.cmdSize = 0;
    this.fragment = 0;
    this.tag = null;
    this.appendAt = -1;
    this.appendStreamed = false;
    this.literals = 0;
    this.remaining = 0;
  }
}
