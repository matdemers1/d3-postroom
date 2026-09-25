// The strict SMTP line reader (PST-REQ-049, PST-REQ-050).
//
// A byte-level state machine fed Buffers at arbitrary boundaries. It never decodes the stream as a
// string and never holds more than: the chunks it has been given and not yet consumed, plus one
// partial command line (at most `maxLineLength` octets). Callers push one chunk and pull events
// until `next()` returns null before pushing another, so the retained total stays bounded by one
// socket read plus one line.
//
// Command mode: a line ends ONLY at CRLF. A bare LF, or a CR not followed by LF, is reported the
// moment it is seen and the rest of that line is drained without being kept. So is a line longer
// than `maxLineLength`.
//
// DATA mode: body bytes are emitted as they arrive (slices of the input, never copies of the
// message), dot-unstuffed, and DATA ends ONLY at <CRLF>.<CRLF>. Any bare LF or bare CR (or NUL)
// marks the message rejected but the reader keeps consuming until the true terminator, so the
// session stays in step with the client and no smuggled "\n.\n" can ever end the message early.
// Size is counted as it goes; past `maxSize` the reader stops emitting and keeps draining.
//
// Max line length: RFC 5321 §4.5.3.1.4 sets 512 octets including CRLF for command lines, and lets
// extensions raise it (RFC 1870 SIZE, RFC 4954 AUTH, RFC 6531 UTF-8 addresses with 64-octet local
// parts of multibyte characters). We default to 2048 octets excluding CRLF: generous enough for
// every real EHLO/MAIL/RCPT/AUTH PLAIN line, small enough that a line is never a memory lever.

export type LineError = 'bare-lf' | 'bare-cr' | 'line-too-long';
export type DataRejection = 'bare-lf' | 'bare-cr' | 'nul' | 'too-large';

export type LineReaderEvent =
  /** A complete command line, without its CRLF. A copy; safe to keep. */
  | { readonly type: 'line'; readonly line: Buffer }
  /** A malformed command line; the remainder of it up to CRLF is discarded silently. */
  | { readonly type: 'line-error'; readonly error: LineError }
  /** Dot-unstuffed message bytes. A slice of a pushed chunk — consume or copy before reuse. */
  | { readonly type: 'data'; readonly chunk: Buffer }
  /** The message has just become unacceptable; no more `data` events until `data-end`. */
  | { readonly type: 'data-rejected'; readonly reason: DataRejection }
  /** <CRLF>.<CRLF> seen. The reader is back in command mode. `size` counts unstuffed octets. */
  | { readonly type: 'data-end'; readonly size: number; readonly rejection: DataRejection | null };

export interface LineReaderOptions {
  readonly maxLineLength?: number;
}

export interface StartDataOptions {
  /** Largest message accepted, in octets after dot-unstuffing. */
  readonly maxSize?: number;
}

export const DEFAULT_MAX_LINE_LENGTH = 2048;

const CR = 13;
const LF = 10;
const DOT = 46;
const NUL = 0;
const CR_BUF = Buffer.from([CR]);

const enum DataState {
  /** Just after CRLF (or at the start of DATA). */
  LineStart,
  /** Inside a line. */
  Mid,
  /** Saw CR; waiting for LF. */
  CR,
  /** Saw "." at a line start (dropped: stuffing or terminator). */
  Dot,
  /** Saw "." then CR at a line start; LF next ends DATA. */
  DotCR,
}

export class SmtpLineReader {
  readonly maxLineLength: number;
  private readonly queue: Buffer[] = [];
  private offset = 0;
  private readonly events: LineReaderEvent[] = [];
  private mode: 'command' | 'data' = 'command';

  // Command mode.
  private readonly lineBuf: Buffer;
  private lineLen = 0;
  private cmdCR = false;
  private discarding = false;

  // DATA mode.
  private ds: DataState = DataState.LineStart;
  private size = 0;
  private maxSize = Number.POSITIVE_INFINITY;
  private rejection: DataRejection | null = null;
  private rejectionReported = false;

  /** Highest `bufferedBytes` observed after any push — instrumentation for PST-REQ-050. */
  maxBufferedBytes = 0;

  constructor(options: LineReaderOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    this.lineBuf = Buffer.alloc(this.maxLineLength);
  }

  /** Octets held: unconsumed input plus the partial command line. */
  get bufferedBytes(): number {
    let n = this.lineLen - this.offset;
    for (const b of this.queue) n += b.length;
    return n;
  }

  get inData(): boolean {
    return this.mode === 'data';
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
    const held = this.bufferedBytes;
    if (held > this.maxBufferedBytes) this.maxBufferedBytes = held;
  }

  /** Switch to DATA mode after the 354 reply. Only valid between lines in command mode. */
  startData(options: StartDataOptions = {}): void {
    if (this.mode !== 'command' || this.lineLen !== 0 || this.cmdCR || this.discarding) {
      throw new Error('startData() is only valid at a command line boundary');
    }
    this.mode = 'data';
    this.ds = DataState.LineStart;
    this.size = 0;
    this.maxSize = options.maxSize ?? Number.POSITIVE_INFINITY;
    this.rejection = null;
    this.rejectionReported = false;
  }

  /**
   * Throw away everything buffered and not yet consumed — used when STARTTLS completes
   * (PST-REQ-029): bytes that arrived in plaintext after the STARTTLS line are never executed.
   * Returns the number of octets discarded.
   */
  discardPending(): number {
    let n = -this.offset + this.lineLen;
    for (const b of this.queue) n += b.length;
    this.queue.length = 0;
    this.offset = 0;
    this.events.length = 0;
    this.lineLen = 0;
    this.cmdCR = false;
    this.discarding = false;
    this.mode = 'command';
    return n;
  }

  /** The next event, or null when more input is needed. Never throws on any input. */
  next(): LineReaderEvent | null {
    for (;;) {
      const queued = this.events.shift();
      if (queued) return queued;
      const head = this.queue[0];
      if (head === undefined) return null;
      if (this.offset >= head.length) {
        this.queue.shift();
        this.offset = 0;
        continue;
      }
      if (this.mode === 'command') {
        const ev = this.scanCommand(head);
        if (ev) return ev;
      } else {
        this.scanData(head);
      }
    }
  }

  private scanCommand(buf: Buffer): LineReaderEvent | null {
    while (this.offset < buf.length) {
      const b = buf[this.offset++] ?? 0;
      if (this.cmdCR) {
        this.cmdCR = false;
        if (b === LF) {
          if (this.discarding) {
            this.discarding = false;
            this.lineLen = 0;
            continue;
          }
          const line = Buffer.from(this.lineBuf.subarray(0, this.lineLen));
          this.lineLen = 0;
          return { type: 'line', line };
        }
        // The previous CR was bare. This byte may itself be a CR that starts a real CRLF.
        if (b === CR) this.cmdCR = true;
        if (!this.discarding) return this.lineError('bare-cr');
        continue;
      }
      if (b === CR) {
        this.cmdCR = true;
        continue;
      }
      if (b === LF) {
        if (!this.discarding) return this.lineError('bare-lf');
        continue;
      }
      if (this.discarding) continue;
      if (this.lineLen >= this.maxLineLength) return this.lineError('line-too-long');
      this.lineBuf[this.lineLen++] = b;
    }
    return null;
  }

  private lineError(error: LineError): LineReaderEvent {
    this.discarding = true;
    this.lineLen = 0;
    return { type: 'line-error', error };
  }

  private reject(reason: DataRejection): void {
    this.rejection ??= reason;
  }

  private emit(segment: Buffer): void {
    if (segment.length === 0) return;
    this.size += segment.length;
    if (this.size > this.maxSize) this.reject('too-large');
    if (this.rejection !== null) return;
    this.events.push({ type: 'data', chunk: segment });
  }

  /** Consume the rest of `buf` (or up to the terminator), queueing events. */
  private scanData(buf: Buffer): void {
    let i = this.offset;
    let runStart = i;
    let ended = false;
    const n = buf.length;
    loop: for (; i < n; i++) {
      const b = buf[i] ?? 0;
      if (this.ds === DataState.LineStart && b === DOT) {
        // Drop the leading dot: it is either stuffing or the start of the terminator.
        this.emit(buf.subarray(runStart, i));
        runStart = i + 1;
        this.ds = DataState.Dot;
        continue;
      }
      switch (this.ds) {
        case DataState.LineStart:
        case DataState.Mid:
          if (b === CR) this.ds = DataState.CR;
          else {
            if (b === LF) this.reject('bare-lf');
            else if (b === NUL) this.reject('nul');
            this.ds = DataState.Mid;
          }
          break;
        case DataState.CR:
          if (b === LF) this.ds = DataState.LineStart;
          else if (b === CR) this.reject('bare-cr');
          else {
            this.reject('bare-cr');
            if (b === NUL) this.reject('nul');
            this.ds = DataState.Mid;
          }
          break;
        case DataState.Dot:
          if (b === CR) {
            // Hold the CR back: if LF follows, this is the terminator and the CR is not body.
            this.emit(buf.subarray(runStart, i));
            runStart = i + 1;
            this.ds = DataState.DotCR;
          } else {
            if (b === LF) this.reject('bare-lf');
            else if (b === NUL) this.reject('nul');
            this.ds = DataState.Mid;
          }
          break;
        case DataState.DotCR:
          if (b === LF) {
            ended = true;
            i++;
            break loop;
          }
          // ".<CR>" not followed by LF: the held CR is bare body data.
          this.reject('bare-cr');
          this.emit(CR_BUF);
          if (b === CR) this.ds = DataState.CR;
          else {
            if (b === NUL) this.reject('nul');
            this.ds = DataState.Mid;
          }
          break;
      }
    }
    if (!ended) this.emit(buf.subarray(runStart, i));
    this.offset = i;
    if (this.rejection !== null && !this.rejectionReported) {
      this.rejectionReported = true;
      this.events.push({ type: 'data-rejected', reason: this.rejection });
    }
    if (ended) {
      this.events.push({ type: 'data-end', size: this.size, rejection: this.rejection });
      this.mode = 'command';
      this.maxSize = Number.POSITIVE_INFINITY;
    }
  }
}
