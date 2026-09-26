// Client-side streaming response reader, for the IMAP import client (PST-T-10.2, PST-REQ-152).
//
// `ResponseReader` buffers every literal a response announces, which is right for a test client and
// wrong for an importer: a FETCH BODY[] literal may be a 100 MB message, and no parser in Postroom
// holds a whole message (PST-REQ-050). `StreamingResponseReader` splits the same byte stream at the
// same boundaries, but any literal of at least `streamLiteralsFrom` octets is handed out as it
// arrives — `literal-start`, then `literal-data` views into the pushed chunks, then `literal-end` —
// and never retained. The response it belongs to is still parsed and returned whole once its last
// line arrives, with each streamed literal standing in as an empty literal (`{0}`), and `streamed`
// counting how many were cut out, so the caller pairs the bytes it consumed with the response's
// other items (UID, FLAGS, INTERNALDATE), whatever order the server sent them in.
//
// Never throws: malformed input yields an `error` response, and a limit breach makes it fatal.

import { Ch } from './lexer.js';
import { literalMarkerAt } from './reader.js';
import { parseResponse, type ParsedResponse, type ResponseReaderOptions } from './response-parser.js';

export type ResponseStreamEvent =
  | {
      readonly type: 'response';
      readonly response: ParsedResponse;
      /** How many literals of this response were streamed out (and stand as `{0}` in it). */
      readonly streamed: number;
    }
  | {
      readonly type: 'literal-start';
      /** Octets that follow as `literal-data` events. */
      readonly size: number;
      /** The response so far, up to the literal marker (excluded), e.g. `* 3 FETCH (UID 7 BODY[] `. */
      readonly prefix: Buffer;
      readonly binary: boolean;
    }
  /** A view into a pushed chunk: consume or copy it before pushing more. */
  | { readonly type: 'literal-data'; readonly data: Buffer }
  | { readonly type: 'literal-end' };

export interface StreamingResponseReaderOptions extends ResponseReaderOptions {
  /** Literals this size or larger are streamed out rather than buffered. Default 64 KiB; minimum 1. */
  readonly streamLiteralsFrom?: number;
  /** The largest streamed literal accepted. Default 4 GiB. */
  readonly maxStreamedLiteralSize?: number;
}

const CRLF = Buffer.from('\r\n');

export class StreamingResponseReader {
  readonly maxLineLength: number;
  readonly maxLiteralSize: number;
  readonly maxResponseSize: number;
  readonly streamLiteralsFrom: number;
  readonly maxStreamedLiteralSize: number;
  private readonly parseOptions: ResponseReaderOptions;
  private readonly queue: Buffer[] = [];
  private offset = 0;
  private line: Buffer[] = [];
  private lineLen = 0;
  private parts: Buffer[] = [];
  private size = 0;
  /** Octets left of a buffered literal, or -1. */
  private remaining = -1;
  /** Octets left of a streamed literal, or -1. */
  private streaming = -1;
  private streamedCount = 0;
  private dead = false;

  constructor(options: StreamingResponseReaderOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? 64 * 1024;
    this.maxLiteralSize = options.maxLiteralSize ?? 1024 * 1024;
    this.maxResponseSize = options.maxResponseSize ?? 8 * 1024 * 1024;
    this.streamLiteralsFrom = Math.max(1, options.streamLiteralsFrom ?? 64 * 1024);
    this.maxStreamedLiteralSize = options.maxStreamedLiteralSize ?? 4 * 1024 * 1024 * 1024;
    this.parseOptions = options;
  }

  /** Octets held right now: unread input plus the response being assembled (never a streamed literal's). */
  get bufferedBytes(): number {
    let q = 0;
    for (const c of this.queue) q += c.length;
    return q - this.offset + this.lineLen + this.size;
  }

  push(chunk: Uint8Array): void {
    if (this.dead || chunk.length === 0) return;
    this.queue.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
  }

  next(): ResponseStreamEvent | null {
    while (!this.dead) {
      if (this.streaming === 0) {
        this.streaming = -1;
        return { type: 'literal-end' };
      }
      const chunk = this.queue[0];
      if (!chunk) return null;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
        continue;
      }
      if (this.streaming > 0) {
        const n = Math.min(this.streaming, chunk.length - this.offset);
        const data = chunk.subarray(this.offset, this.offset + n);
        this.offset += n;
        this.streaming -= n;
        return { type: 'literal-data', data };
      }
      if (this.remaining >= 0) {
        const n = Math.min(this.remaining, chunk.length - this.offset);
        this.parts.push(Buffer.from(chunk.subarray(this.offset, this.offset + n)));
        this.offset += n;
        this.remaining -= n;
        if (this.remaining === 0) this.remaining = -1;
        continue;
      }
      const lf = chunk.indexOf(Ch.LF, this.offset);
      const end = lf < 0 ? chunk.length : lf;
      if (this.lineLen + end - this.offset > this.maxLineLength + 1) return this.fatal('response line too long');
      this.line.push(Buffer.from(chunk.subarray(this.offset, end)));
      this.lineLen += end - this.offset;
      if (lf < 0) {
        this.offset = chunk.length;
        continue;
      }
      this.offset = lf + 1;
      const raw = Buffer.concat(this.line);
      this.line = [];
      this.lineLen = 0;
      if (raw[raw.length - 1] !== Ch.CR) {
        this.resetResponse();
        return { type: 'response', response: { kind: 'error', message: 'response line ended with a bare LF', fatal: false }, streamed: 0 };
      }
      const text = raw.subarray(0, raw.length - 1);
      const marker = literalMarkerAt(text);
      if (marker && marker.size >= this.streamLiteralsFrom) {
        if (marker.size > this.maxStreamedLiteralSize) return this.fatal(`literal of ${marker.size} octets is over the limit`);
        const head = text.subarray(0, marker.start);
        const stand = Buffer.from(marker.binary ? '~{0}' : '{0}', 'latin1');
        this.size += head.length + stand.length + 2;
        if (this.size > this.maxResponseSize) return this.fatal('response over the size limit');
        this.parts.push(head, stand, CRLF);
        this.streamedCount++;
        this.streaming = marker.size;
        return { type: 'literal-start', size: marker.size, prefix: Buffer.concat([...this.parts.slice(0, -2)]), binary: marker.binary };
      }
      this.size += text.length + 2;
      if (marker) {
        if (marker.size > this.maxLiteralSize) return this.fatal(`literal of ${marker.size} octets is over the limit`);
        if (this.size + marker.size > this.maxResponseSize) return this.fatal('response over the size limit');
        this.parts.push(text, CRLF);
        this.size += marker.size;
        this.remaining = marker.size;
        if (this.remaining === 0) this.remaining = -1;
        continue;
      }
      if (this.size > this.maxResponseSize) return this.fatal('response over the size limit');
      this.parts.push(text);
      const whole = Buffer.concat(this.parts);
      const streamed = this.streamedCount;
      this.resetResponse();
      return { type: 'response', response: parseResponse(whole, this.parseOptions), streamed };
    }
    return null;
  }

  private resetResponse(): void {
    this.parts = [];
    this.size = 0;
    this.remaining = -1;
    this.streamedCount = 0;
  }

  private fatal(message: string): ResponseStreamEvent {
    this.dead = true;
    this.queue.length = 0;
    this.line = [];
    this.lineLen = 0;
    this.streaming = -1;
    this.resetResponse();
    return { type: 'response', response: { kind: 'error', message, fatal: true }, streamed: 0 };
  }
}
