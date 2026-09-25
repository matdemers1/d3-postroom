// The streaming MIME parser (RFC 5322 + RFC 2045/2046), PST-REQ-050: a message of any size is
// processed as a stream, and the parser never holds more than a bounded buffer.
//
// How it stays bounded. Bytes are consumed in slices of at most `sliceBytes`. Body content is
// passed through (transfer-decoded) as it arrives; the only bytes held back are
//   - the start of a line that might still turn out to be a boundary delimiter (a line can only be
//     a delimiter if it begins with "--" + boundary, so any line not starting with "-" is released
//     at once, and a candidate is released as soon as it stops matching),
//   - the line break before such a candidate (at most two bytes: RFC 2046 §5.1.1 says the CRLF
//     preceding a delimiter belongs to the delimiter, not to the part), and a trailing CR,
//   - header fields while a header block is being read, capped at `maxHeaderBytes` for the whole
//     stack of open parts, with each physical line capped at `maxLineBytes`,
//   - a few bytes of transfer-decoder carry (an incomplete base64 quantum or `=XX` escape).
// `retainedBytes` counts all of these after every slice and `maxRetainedBytes` records the peak;
// `retainedBound` is the ceiling the tests assert against.

import { HeaderList, isContinuation, isFieldStart, makeField, type HeaderField } from './header.js';
import { parseMessageId } from './msgid.js';
import { parseContentDisposition, parseContentType, type Params } from './params.js';
import { createTransferDecoder, isKnownEncoding, normalizeEncoding, type TransferDecoder } from './transfer.js';

const LF = 0x0a;
const CR = 0x0d;
const DASH = 0x2d;
const SP = 0x20;
const HTAB = 0x09;
const EMPTY = Buffer.alloc(0);
const CRLF_BUF = Buffer.from('\r\n');
const LF_BUF = Buffer.from('\n');
const CR_BUF = Buffer.from('\r');
const NL_DASH = Buffer.from('\n-');

/** RFC 2046 allows 70; real mail stays well under 200. Longer is treated as not-multipart. */
export const MAX_BOUNDARY_LENGTH = 200;
/** Transport padding allowed after a delimiter (RFC 2046 §5.1.1 LWSP) before the line stops qualifying. */
const MAX_DELIMITER_PADDING = 256;

export type PartKind = 'leaf' | 'multipart' | 'message';

export interface PartInfo {
  /** Tree position: the message is "1", its children "1.1", "1.2", their children "1.2.1"… An encapsulated message/rfc822 is the single child of its part. */
  readonly id: string;
  readonly parent: string | null;
  readonly depth: number;
  readonly kind: PartKind;
  readonly headers: HeaderList;
  /** `type/subtype`, lowercased; the RFC 2045/2046 default when absent or invalid. */
  readonly contentType: string;
  readonly params: Params;
  /** `inline`, `attachment`, … or null when there is no Content-Disposition. */
  readonly disposition: string | null;
  readonly dispositionParams: Params;
  /** Content-Disposition filename, else Content-Type name (both RFC 2231/2047-decoded). */
  readonly filename: string | null;
  readonly charset: string | null;
  /** Content-Transfer-Encoding, lowercased (default `7bit`). */
  readonly encoding: string;
  /** Content-ID without angle brackets, for `cid:` references. */
  readonly contentId: string | null;
  /** The boundary, when this part is parsed as a multipart. */
  readonly boundary: string | null;
}

export type WarningCode =
  | 'header-8bit-latin1'
  | 'header-block-too-large'
  | 'header-field-too-long'
  | 'header-line-too-long'
  | 'header-junk-continuation'
  | 'header-missing-separator'
  | 'mbox-from-line'
  | 'invalid-content-type'
  | 'multipart-no-boundary'
  | 'multipart-bad-boundary'
  | 'multipart-encoded'
  | 'multipart-missing-close'
  | 'multipart-empty'
  | 'delimiter-after-close'
  | 'depth-limit'
  | 'unknown-encoding'
  | 'malformed-encoding'
  | 'unknown-charset'
  | 'message-encoded'
  | 'too-many-warnings';

export interface MimeWarning {
  readonly code: WarningCode;
  readonly message: string;
  readonly partId: string | null;
}

export interface ParseStats {
  readonly bytesIn: number;
  readonly parts: number;
  readonly warnings: number;
  /** Peak bytes the parser itself held across slices. */
  readonly maxRetainedBytes: number;
  /** The ceiling `maxRetainedBytes` can never exceed for these options. */
  readonly retainedBound: number;
}

export type MimeEvent =
  | { readonly type: 'headers'; readonly part: PartInfo; readonly headers: HeaderList }
  | { readonly type: 'body'; readonly part: PartInfo; readonly chunk: Buffer }
  | { readonly type: 'end-part'; readonly part: PartInfo; readonly size: number }
  | { readonly type: 'warning'; readonly warning: MimeWarning }
  | { readonly type: 'end'; readonly stats: ParseStats };

export interface ParseOptions {
  /** Header bytes retained at once across every open part (default 1 MiB). */
  maxHeaderBytes?: number;
  /** One header field, folded lines included (default 64 KiB). */
  maxFieldBytes?: number;
  /** One physical header line (default 64 KiB). */
  maxLineBytes?: number;
  /** Nesting of multiparts and encapsulated messages (default 32). */
  maxDepth?: number;
  /** Warnings emitted before a single `too-many-warnings` (default 100). */
  maxWarnings?: number;
  /** Input is processed in slices of at most this many bytes (default 64 KiB). */
  sliceBytes?: number;
}

type Mode = 'headers' | PartKind;

interface Frame {
  readonly id: string;
  readonly parent: Frame | null;
  readonly depth: number;
  readonly defaultType: string;
  mode: Mode;
  part: PartInfo | null;
  // header block
  fields: HeaderField[];
  field: Buffer[];
  fieldBytes: number;
  fieldTruncated: boolean;
  headerBytes: number;
  headerOverflow: boolean;
  // multipart
  delimiter: Buffer | null;
  mpState: 'preamble' | 'child' | 'epilogue';
  children: number;
  // leaf
  decoder: TransferDecoder | null;
  size: number;
}

interface Match {
  frameIndex: number;
  close: boolean;
}

function newFrame(id: string, parent: Frame | null, defaultType: string): Frame {
  return {
    id,
    parent,
    depth: parent === null ? 0 : parent.depth + 1,
    defaultType,
    mode: 'headers',
    part: null,
    fields: [],
    field: [],
    fieldBytes: 0,
    fieldTruncated: false,
    headerBytes: 0,
    headerOverflow: false,
    delimiter: null,
    mpState: 'preamble',
    children: 0,
    decoder: null,
    size: 0,
  };
}

const IDENTITY = new Set(['7bit', '8bit', 'binary']);
const BOUNDARY_CHARS = /^[0-9A-Za-z'()+_,\-./:=? ]*[0-9A-Za-z'()+_,\-./:=?]$/;

function isPadding(buf: Uint8Array, from: number): boolean {
  for (let i = from; i < buf.length; i++) {
    const c = buf[i];
    if (c !== SP && c !== HTAB && c !== CR) return false;
  }
  return true;
}

/**
 * Push-based streaming parser. Feed bytes with `write`, finish with `end`; events are delivered
 * synchronously to the callback. `parseMessage` wraps this as an async iterator.
 */
export class MimeParser {
  private readonly onEvent: (event: MimeEvent) => void;
  private readonly maxHeaderBytes: number;
  private readonly maxFieldBytes: number;
  private readonly maxLineBytes: number;
  private readonly maxDepth: number;
  private readonly maxWarnings: number;
  private readonly sliceBytes: number;

  private readonly stack: Frame[] = [];
  /** Active delimiters, parallel to multipart frames in the stack (innermost last). */
  private delimiters: { delim: Buffer; frame: Frame }[] = [];
  private carry: Buffer = EMPTY;
  private lineOverflow = false;
  private atLineStart = true;
  private pendingEol: Buffer | null = null;
  private heldCr = false;
  private finished = false;
  private headerBytesRetained = 0;
  private sawAnyHeaderLine = false;

  private bytesIn = 0;
  private parts = 0;
  private warnings = 0;
  private peak = 0;
  readonly retainedBound: number;

  constructor(onEvent: (event: MimeEvent) => void, options: ParseOptions = {}) {
    this.onEvent = onEvent;
    this.maxHeaderBytes = options.maxHeaderBytes ?? 1024 * 1024;
    this.maxFieldBytes = options.maxFieldBytes ?? 64 * 1024;
    this.maxLineBytes = options.maxLineBytes ?? 64 * 1024;
    this.maxDepth = options.maxDepth ?? 32;
    this.maxWarnings = options.maxWarnings ?? 100;
    this.sliceBytes = Math.max(1, options.sliceBytes ?? 64 * 1024);
    // Header bytes + one capped header line or one candidate line (which grows by at most one
    // slice past its limit before being judged) + CR/CRLF + decoder carry.
    this.retainedBound =
      this.maxHeaderBytes + Math.max(this.maxLineBytes, MAX_BOUNDARY_LENGTH + 4 + MAX_DELIMITER_PADDING) + this.sliceBytes + 2 + 1024 + 8;
    this.stack.push(newFrame('1', null, 'text/plain'));
  }

  /** Bytes the parser holds right now. */
  get retainedBytes(): number {
    const top = this.stack[this.stack.length - 1];
    return this.carry.length + this.headerBytesRetained + (this.pendingEol?.length ?? 0) + (this.heldCr ? 1 : 0) + (top?.decoder?.carried ?? 0);
  }

  get maxRetainedBytes(): number {
    return this.peak;
  }

  write(chunk: Uint8Array): void {
    if (this.finished) throw new Error('MimeParser: write after end');
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    for (let off = 0; off < buf.length; off += this.sliceBytes) {
      const slice = buf.subarray(off, Math.min(buf.length, off + this.sliceBytes));
      this.bytesIn += slice.length;
      this.process(slice);
      this.track();
    }
  }

  end(): void {
    if (this.finished) return;
    if (this.carry.length > 0 || this.lineOverflow) {
      const line = this.carry;
      this.carry = EMPTY;
      if (this.top.mode === 'headers') this.headerLine(line, EMPTY);
      else this.bodyLine(line, EMPTY);
    }
    this.lineOverflow = false;
    if (this.heldCr) {
      this.heldCr = false;
      this.content(CR_BUF);
    }
    if (this.pendingEol !== null && this.top.mode !== 'headers') {
      // No delimiter followed, so the line break was content after all.
      const eol = this.pendingEol;
      this.pendingEol = null;
      this.content(eol);
    }
    while (this.stack.length > 0) this.closeTop();
    this.finished = true;
    this.track();
    this.onEvent({
      type: 'end',
      stats: { bytesIn: this.bytesIn, parts: this.parts, warnings: this.warnings, maxRetainedBytes: this.peak, retainedBound: this.retainedBound },
    });
  }

  private get top(): Frame {
    return this.stack[this.stack.length - 1] as Frame;
  }

  private track(): void {
    const now = this.retainedBytes;
    if (now > this.peak) this.peak = now;
  }

  private warn(code: WarningCode, message: string, frame: Frame | null): void {
    this.warnings++;
    if (this.warnings > this.maxWarnings) return;
    if (this.warnings === this.maxWarnings) {
      this.onEvent({ type: 'warning', warning: { code: 'too-many-warnings', message: 'further warnings suppressed', partId: frame?.id ?? null } });
      return;
    }
    this.onEvent({ type: 'warning', warning: { code, message, partId: frame?.id ?? null } });
  }

  // --- the byte loop --------------------------------------------------------------------------

  private process(buf: Buffer): void {
    let pos = 0;
    const len = buf.length;
    while (pos < len) {
      if (this.top.mode === 'headers') {
        pos = this.headerBytes(buf, pos);
        continue;
      }
      if (!this.atLineStart) {
        pos = this.scanMidLine(buf, pos);
        continue;
      }
      if (this.delimiters.length === 0 || (this.carry.length === 0 && buf[pos] !== DASH)) {
        // This line cannot be a delimiter: release the held line break and stream it.
        this.flushPendingEol();
        this.atLineStart = false;
        continue;
      }
      const lf = buf.indexOf(LF, pos);
      const end = lf < 0 ? len : lf + 1;
      this.carry = this.carry.length === 0 ? Buffer.from(buf.subarray(pos, end)) : Buffer.concat([this.carry, buf.subarray(pos, end)]);
      pos = end;
      if (lf >= 0) {
        const line = this.carry;
        this.carry = EMPTY;
        const eolLen = line.length >= 2 && line[line.length - 2] === CR ? 2 : 1;
        this.bodyLine(line.subarray(0, line.length - eolLen), eolLen === 2 ? CRLF_BUF : LF_BUF);
      } else if (!this.couldBeDelimiter(this.carry)) {
        const partial = this.carry;
        this.carry = EMPTY;
        this.flushPendingEol();
        this.atLineStart = false;
        if (partial[partial.length - 1] === CR) {
          this.content(partial.subarray(0, partial.length - 1));
          this.heldCr = true;
        } else {
          this.content(partial);
        }
      }
    }
  }

  /** Stream content up to the next line that starts with "-" (a possible delimiter). */
  private scanMidLine(buf: Buffer, pos: number): number {
    const len = buf.length;
    if (this.heldCr) {
      this.heldCr = false;
      if (buf[pos] === LF) {
        this.pendingEol = CRLF_BUF;
        this.atLineStart = true;
        return pos + 1;
      }
      this.content(CR_BUF);
    }
    if (this.delimiters.length === 0) {
      this.content(buf.subarray(pos));
      return len;
    }
    const idx = buf.indexOf(NL_DASH, pos);
    if (idx >= 0) {
      const eolStart = idx > pos && buf[idx - 1] === CR ? idx - 1 : idx;
      this.content(buf.subarray(pos, eolStart));
      this.pendingEol = eolStart === idx ? LF_BUF : CRLF_BUF;
      this.atLineStart = true;
      return idx + 1;
    }
    const last = buf[len - 1];
    if (last === LF) {
      const eolStart = len - 1 > pos && buf[len - 2] === CR ? len - 2 : len - 1;
      this.content(buf.subarray(pos, eolStart));
      this.pendingEol = eolStart === len - 1 ? LF_BUF : CRLF_BUF;
      this.atLineStart = true;
    } else if (last === CR) {
      this.content(buf.subarray(pos, len - 1));
      this.heldCr = true;
    } else {
      this.content(buf.subarray(pos));
    }
    return len;
  }

  private flushPendingEol(): void {
    if (this.pendingEol !== null) {
      const eol = this.pendingEol;
      this.pendingEol = null;
      this.content(eol);
    }
  }

  /** A complete body line (without its line break). */
  private bodyLine(line: Buffer, eol: Buffer): void {
    const match = this.matchDelimiter(line);
    if (match !== null) {
      this.pendingEol = null; // the line break before a delimiter belongs to the delimiter
      this.atLineStart = true;
      this.onDelimiter(match);
      return;
    }
    this.flushPendingEol();
    this.content(line);
    this.pendingEol = eol.length === 0 ? null : eol;
    this.atLineStart = true;
  }

  private matchDelimiter(line: Uint8Array): Match | null {
    if (line.length < 3 || line[0] !== DASH || line[1] !== DASH) return null;
    for (let i = this.delimiters.length - 1; i >= 0; i--) {
      const { delim, frame } = this.delimiters[i] as { delim: Buffer; frame: Frame };
      if (line.length < delim.length) continue;
      if (Buffer.compare(delim, line.subarray(0, delim.length)) !== 0) continue;
      const close = line[delim.length] === DASH && line[delim.length + 1] === DASH;
      if (!isPadding(line, delim.length + (close ? 2 : 0))) continue;
      return { frameIndex: this.stack.indexOf(frame), close };
    }
    return null;
  }

  private couldBeDelimiter(partial: Buffer): boolean {
    for (const { delim } of this.delimiters) {
      const n = Math.min(partial.length, delim.length);
      if (Buffer.compare(delim.subarray(0, n), partial.subarray(0, n)) !== 0) continue;
      if (partial.length <= delim.length) return true;
      if (partial.length - delim.length > 2 + MAX_DELIMITER_PADDING) continue;
      let ok = true;
      for (let i = delim.length; i < partial.length; i++) {
        const c = partial[i];
        const dashOk = c === DASH && i < delim.length + 2;
        if (!dashOk && c !== SP && c !== HTAB && c !== CR) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  // --- content routing ---------------------------------------------------------------------------

  private content(buf: Buffer): void {
    if (buf.length === 0) return;
    const frame = this.top;
    if (frame.mode !== 'leaf' || frame.decoder === null || frame.part === null) return; // preamble, epilogue
    const decoded = frame.decoder.write(buf);
    if (decoded.length > 0) {
      frame.size += decoded.length;
      this.onEvent({ type: 'body', part: frame.part, chunk: decoded });
    }
  }

  // --- headers ----------------------------------------------------------------------------------

  /** Accumulate header bytes until a complete line, then handle it. */
  private headerBytes(buf: Buffer, pos: number): number {
    const lf = buf.indexOf(LF, pos);
    const end = lf < 0 ? buf.length : lf + 1;
    if (!this.lineOverflow) {
      const room = this.maxLineBytes - this.carry.length;
      const take = Math.min(room, end - pos);
      if (take > 0) {
        const seg = buf.subarray(pos, pos + take);
        this.carry = this.carry.length === 0 ? Buffer.from(seg) : Buffer.concat([this.carry, seg]);
      }
      if (take < end - pos) {
        this.lineOverflow = true;
        this.warn('header-line-too-long', `a header line exceeded ${String(this.maxLineBytes)} bytes; the rest was dropped`, this.top);
      }
    }
    if (lf < 0) return end;
    let line = this.carry;
    this.carry = EMPTY;
    let eol: Buffer;
    if (this.lineOverflow) {
      this.lineOverflow = false;
      if (line[line.length - 1] === LF) line = line.subarray(0, line.length - 1);
      eol = LF_BUF;
    } else {
      const eolLen = line.length >= 2 && line[line.length - 2] === CR ? 2 : 1;
      eol = eolLen === 2 ? CRLF_BUF : LF_BUF;
      line = line.subarray(0, line.length - eolLen);
    }
    this.headerLine(line, eol);
    return end;
  }

  /** One complete header-block line (without its line break). */
  private headerLine(line: Buffer, eol: Buffer): void {
    const frame = this.top;
    if (line.length === 0) {
      this.finishHeaders();
      this.atLineStart = true;
      this.pendingEol = null;
      return;
    }
    const match = this.matchDelimiter(line);
    if (match !== null) {
      this.warn('header-missing-separator', 'a delimiter interrupted a header block', frame);
      this.finishHeaders();
      this.pendingEol = null;
      this.atLineStart = true;
      this.onDelimiter(match);
      return;
    }
    if (isContinuation(line)) {
      if (frame.field.length > 0 || frame.fieldTruncated) {
        this.appendField(frame, eol, line);
      } else if (!frame.headerOverflow) {
        this.warn('header-junk-continuation', 'a folded line with no field before it was ignored', frame);
      }
      return;
    }
    if (isFieldStart(line)) {
      this.endField(frame);
      this.appendField(frame, EMPTY, line);
      this.sawAnyHeaderLine = true;
      return;
    }
    if (frame.parent === null && !this.sawAnyHeaderLine && frame.fields.length === 0 && line.subarray(0, 5).toString('latin1') === 'From ') {
      this.warn('mbox-from-line', 'an mbox "From " separator line was skipped', frame);
      return;
    }
    // Not a header: the header block ended without its blank line. This line is body.
    this.warn('header-missing-separator', 'a non-header line ended the header block', frame);
    this.finishHeaders();
    this.pendingEol = null;
    this.atLineStart = true;
    this.process(Buffer.concat([line, eol]));
  }

  private appendField(frame: Frame, eol: Buffer, line: Buffer): void {
    if (frame.headerOverflow) return;
    const add = eol.length + line.length;
    if (frame.fieldTruncated) return;
    if (frame.fieldBytes + add > this.maxFieldBytes) {
      frame.fieldTruncated = true;
      this.warn('header-field-too-long', `a header field exceeded ${String(this.maxFieldBytes)} bytes and was truncated`, frame);
      return;
    }
    if (this.headerBytesRetained + add > this.maxHeaderBytes) {
      frame.headerOverflow = true;
      frame.field = [];
      this.headerBytesRetained -= frame.fieldBytes;
      frame.headerBytes -= frame.fieldBytes;
      frame.fieldBytes = 0;
      this.warn('header-block-too-large', `headers exceeded ${String(this.maxHeaderBytes)} bytes; later fields were dropped`, frame);
      return;
    }
    if (eol.length > 0) frame.field.push(eol);
    frame.field.push(line);
    frame.fieldBytes += add;
    frame.headerBytes += add;
    this.headerBytesRetained += add;
  }

  private endField(frame: Frame): void {
    if (frame.field.length > 0) {
      const field = makeField(Buffer.concat(frame.field), frame.fieldTruncated);
      if (field.latin1) this.warn('header-8bit-latin1', `${field.name} held 8-bit bytes that are not UTF-8; read as Latin-1`, frame);
      frame.fields.push(field);
    }
    frame.field = [];
    frame.fieldBytes = 0;
    frame.fieldTruncated = false;
  }

  private finishHeaders(): void {
    const frame = this.top;
    this.endField(frame);
    const headers = new HeaderList(frame.fields);
    frame.fields = [];
    const rawType = headers.get('content-type');
    const ct = parseContentType(rawType, frame.defaultType);
    if (rawType !== null && !ct.valid) this.warn('invalid-content-type', `unparseable Content-Type; treated as ${frame.defaultType}`, frame);
    const encoding = normalizeEncoding(headers.get('content-transfer-encoding'));
    const disp = parseContentDisposition(headers.get('content-disposition'));
    const dispositionParams = disp?.params ?? (Object.create(null) as Params);
    const cidRaw = headers.get('content-id');

    let kind: PartKind = 'leaf';
    let boundary: string | null = null;
    if (ct.type === 'multipart') {
      const b = ct.params.boundary ?? null;
      if (b === null || b === '') {
        this.warn('multipart-no-boundary', 'multipart without a boundary; treated as a single part', frame);
      } else if (b.length > MAX_BOUNDARY_LENGTH || !BOUNDARY_CHARS.test(b)) {
        this.warn('multipart-bad-boundary', 'multipart boundary is too long or has invalid characters; treated as a single part', frame);
      } else if (!IDENTITY.has(encoding)) {
        this.warn('multipart-encoded', `multipart with Content-Transfer-Encoding ${encoding}; treated as a single part`, frame);
      } else if (frame.depth >= this.maxDepth) {
        this.warn('depth-limit', `nesting deeper than ${String(this.maxDepth)}; treated as a single part`, frame);
      } else {
        kind = 'multipart';
        boundary = b;
      }
    } else if (ct.mimeType === 'message/rfc822' || ct.mimeType === 'message/global') {
      if (!IDENTITY.has(encoding)) {
        this.warn('message-encoded', `encapsulated message with Content-Transfer-Encoding ${encoding}; treated as a single part`, frame);
      } else if (frame.depth >= this.maxDepth) {
        this.warn('depth-limit', `nesting deeper than ${String(this.maxDepth)}; treated as a single part`, frame);
      } else {
        kind = 'message';
      }
    }
    if (kind === 'leaf' && !isKnownEncoding(encoding)) {
      this.warn('unknown-encoding', `unknown Content-Transfer-Encoding ${encoding}; passed through undecoded`, frame);
    }

    const part: PartInfo = {
      id: frame.id,
      parent: frame.parent?.id ?? null,
      depth: frame.depth,
      kind,
      headers,
      contentType: ct.mimeType,
      params: ct.params,
      disposition: disp?.type ?? null,
      dispositionParams,
      filename: dispositionParams.filename ?? ct.params.name ?? null,
      charset: ct.params.charset ?? null,
      encoding,
      contentId: cidRaw === null ? null : parseMessageId(cidRaw) ?? (cidRaw.replace(/^<|>$/g, '').trim() || null),
      boundary,
    };
    frame.part = part;
    frame.mode = kind;
    this.parts++;
    this.onEvent({ type: 'headers', part, headers });

    if (kind === 'leaf') {
      frame.decoder = createTransferDecoder(encoding);
    } else if (kind === 'multipart') {
      frame.delimiter = Buffer.from(`--${boundary ?? ''}`, 'utf8');
      frame.mpState = 'preamble';
      this.delimiters.push({ delim: frame.delimiter, frame });
    } else {
      this.stack.push(newFrame(`${frame.id}.1`, frame, 'text/plain'));
    }
  }

  // --- structure --------------------------------------------------------------------------------

  private onDelimiter(match: Match): void {
    while (this.stack.length - 1 > match.frameIndex) this.closeTop();
    const frame = this.top;
    if (frame.mpState === 'epilogue') {
      this.warn('delimiter-after-close', 'a delimiter after the closing delimiter was ignored', frame);
      return;
    }
    if (match.close) {
      if (frame.children === 0) this.warn('multipart-empty', 'multipart with no body parts', frame);
      frame.mpState = 'epilogue';
      return;
    }
    frame.mpState = 'child';
    frame.children++;
    const childDefault = frame.part?.contentType === 'multipart/digest' ? 'message/rfc822' : 'text/plain';
    this.stack.push(newFrame(`${frame.id}.${String(frame.children)}`, frame, childDefault));
  }

  /** End the innermost open part, flushing its decoder, and emit `end-part`. */
  private closeTop(): void {
    // A part cut off inside its header block still gets its headers event. An encapsulated message
    // pushes its own (empty) child, which is finished too and closes first.
    while (this.top.mode === 'headers') this.finishHeaders();
    const frame = this.top;
    this.stack.pop();
    this.headerBytesRetained -= frame.headerBytes;
    frame.headerBytes = 0;
    if (frame.mode === 'leaf' && frame.decoder !== null && frame.part !== null) {
      const tail = frame.decoder.end();
      if (tail.length > 0) {
        frame.size += tail.length;
        this.onEvent({ type: 'body', part: frame.part, chunk: tail });
      }
      if (frame.decoder.malformed) this.warn('malformed-encoding', `${frame.part.encoding} content had invalid bytes; they were skipped or kept literally`, frame);
    }
    if (frame.mode === 'multipart') {
      this.delimiters = this.delimiters.filter((d) => d.frame !== frame);
      if (frame.mpState !== 'epilogue') this.warn('multipart-missing-close', 'multipart ended without its closing delimiter', frame);
    }
    if (frame.part !== null) this.onEvent({ type: 'end-part', part: frame.part, size: frame.size });
  }
}

/** Anything `parseMessage` can read from: a Node Readable, an (async) iterable of chunks, or one buffer. */
export type MessageSource = AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string> | Uint8Array | string;

async function* chunks(source: MessageSource): AsyncGenerator<Uint8Array> {
  if (typeof source === 'string') {
    yield Buffer.from(source, 'utf8');
    return;
  }
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  for await (const chunk of source) yield typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
}

/**
 * Parse a message as a stream of events: `headers` → `body`* → `end-part` for every part in
 * document order, `warning` whenever something was tolerated, and a final `end` with stats. At most
 * one slice's worth of events is queued between yields.
 */
export async function* parseMessage(source: MessageSource, options: ParseOptions = {}): AsyncGenerator<MimeEvent, void, undefined> {
  let queue: MimeEvent[] = [];
  const parser = new MimeParser((event) => queue.push(event), options);
  const slice = Math.max(1, options.sliceBytes ?? 64 * 1024);
  for await (const chunk of chunks(source)) {
    for (let off = 0; off < chunk.length; off += slice) {
      parser.write(chunk.subarray(off, Math.min(chunk.length, off + slice)));
      const ready = queue;
      queue = [];
      yield* ready;
    }
  }
  parser.end();
  yield* queue;
}
