// The MIME structure of a stored message with the byte offsets of every part (PST-REQ-070).
//
// FETCH needs three things @postroom/mime's decoding parser does not keep: where each part's header
// block and body sit in the raw message (BODY[1.2], BODY[1.MIME], partial fetches), the encoded
// size and line count of each body (BODYSTRUCTURE), and the raw header fields (ENVELOPE,
// HEADER.FIELDS). This scanner reads the message once, as a stream, line by line, and keeps only:
//   - the first CAPTURE octets of each body line (enough to recognise a boundary delimiter),
//   - the header lines of each part, bounded per part and per message.
// Header parsing (fields, Content-Type, parameters) is @postroom/mime's; only the framing is here.
//
// RFC 2046 §5.1.1: the line break before a boundary delimiter belongs to the delimiter, so a part's
// body ends before it. The line count of a body is its LF count, plus one for a final line without
// a line break.
import { parseContentType, parseHeaderBlock, type ContentType, type HeaderList } from '@postroom/mime';

/** Octets of a body line kept for boundary recognition (a boundary is at most 70, we allow 200). */
const CAPTURE = 1024;
const MAX_BOUNDARY = 200;
/** Header octets kept per part, and per message. Beyond these the headers are truncated. */
export const MAX_PART_HEADER_BYTES = 256 * 1024;
export const MAX_MESSAGE_HEADER_BYTES = 2 * 1024 * 1024;
export const MAX_DEPTH = 32;
export const MAX_PARTS = 5000;

export type NodeKind = 'leaf' | 'multipart' | 'message';

export interface MimeNode {
  /** Offset of the first header octet. */
  readonly headerStart: number;
  /** Offset of the first body octet (after the blank line). */
  bodyStart: number;
  /** Offset one past the last body octet. */
  bodyEnd: number;
  headers: HeaderList;
  headersTruncated: boolean;
  contentType: ContentType;
  /** Whether a Content-Type header was present at all. */
  hasContentType: boolean;
  kind: NodeKind;
  boundary: string | null;
  readonly children: MimeNode[];
  /** For message/rfc822 and message/global: the enclosed message. */
  message: MimeNode | null;
  /** Lines of the body. */
  lines: number;
  readonly depth: number;
  /** Decoded (BINARY) size, computed on first request. */
  binarySize?: number;
}

export interface MessageStructure {
  readonly root: MimeNode;
  readonly size: number;
}

interface Frame {
  readonly node: MimeNode;
  readonly defaultType: string;
  state: 'headers' | 'body';
  headerChunks: Buffer[];
  headerLen: number;
  /** Multipart only: before the first delimiter, between parts, after the close delimiter. */
  mp: 'preamble' | 'parts' | 'epilogue';
  /** Completed lines in the body so far, and the content length of the last of them. */
  lineCount: number;
  lastLen: number;
}

function emptyHeaders(): HeaderList {
  return parseHeaderBlock(Buffer.alloc(0));
}

function newNode(headerStart: number, depth: number, defaultType: string): MimeNode {
  return {
    headerStart,
    bodyStart: headerStart,
    bodyEnd: headerStart,
    headers: emptyHeaders(),
    headersTruncated: false,
    contentType: parseContentType(null, defaultType),
    hasContentType: false,
    kind: 'leaf',
    boundary: null,
    children: [],
    message: null,
    lines: 0,
    depth,
  };
}

/** Push-based scanner: `write` chunks in order, then `end()` for the tree. */
export class StructureScanner {
  private pos = 0;
  private lineStart = 0;
  private line: Buffer[] = [];
  private lineLen = 0;
  private lineCap: number;
  private last = -1;
  private beforeLast = -1;
  private prevBreak = 0;
  private readonly stack: Frame[] = [];
  private readonly root: MimeNode;
  private headerBudget = MAX_MESSAGE_HEADER_BYTES;
  private parts = 1;
  private ended = false;

  constructor() {
    this.root = newNode(0, 0, 'text/plain');
    this.stack.push(this.frame(this.root, 'text/plain'));
    this.lineCap = this.capForLine();
  }

  write(chunk: Uint8Array): void {
    if (this.ended) throw new Error('StructureScanner: write after end');
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    let i = 0;
    while (i < buf.length) {
      const lf = buf.indexOf(0x0a, i);
      const end = lf < 0 ? buf.length : lf + 1;
      this.capture(buf.subarray(i, end));
      this.pos += end - i;
      if (lf >= 0) this.endLine(true);
      i = end;
    }
  }

  end(): MessageStructure {
    if (!this.ended) {
      if (this.pos > this.lineStart) this.endLine(false);
      this.ended = true;
      for (let d = this.stack.length - 1; d >= 0; d--) {
        const f = this.stack[d];
        if (f !== undefined) this.closeAtEof(f);
      }
      this.stack.length = 0;
    }
    return { root: this.root, size: this.pos };
  }

  private frame(node: MimeNode, defaultType: string): Frame {
    return { node, defaultType, state: 'headers', headerChunks: [], headerLen: 0, mp: 'preamble', lineCount: 0, lastLen: 0 };
  }

  private top(): Frame {
    const f = this.stack[this.stack.length - 1];
    if (f === undefined) throw new Error('StructureScanner: no open part');
    return f;
  }

  private capForLine(): number {
    const f = this.stack[this.stack.length - 1];
    if (f?.state === 'headers') {
      return Math.max(CAPTURE, Math.min(MAX_PART_HEADER_BYTES - f.headerLen, this.headerBudget));
    }
    return CAPTURE;
  }

  private capture(seg: Buffer): void {
    if (seg.length >= 2) {
      this.beforeLast = seg[seg.length - 2] ?? -1;
      this.last = seg[seg.length - 1] ?? -1;
    } else if (seg.length === 1) {
      this.beforeLast = this.last;
      this.last = seg[0] ?? -1;
    }
    const room = this.lineCap - this.lineLen;
    if (room > 0) {
      const take = Math.min(room, seg.length);
      this.line.push(Buffer.from(seg.subarray(0, take)));
    }
    this.lineLen += seg.length;
  }

  private endLine(hasLf: boolean): void {
    const start = this.lineStart;
    const end = this.pos;
    const brLen = hasLf ? (end - start >= 2 && this.beforeLast === 0x0d ? 2 : 1) : 0;
    const contentLen = end - start - brLen;
    const raw = this.line.length === 1 ? (this.line[0] ?? Buffer.alloc(0)) : Buffer.concat(this.line);
    const complete = raw.length === end - start;
    this.processLine(start, end, brLen, contentLen, raw, complete);
    this.prevBreak = brLen;
    this.lineStart = end;
    this.line = [];
    this.lineLen = 0;
    this.last = -1;
    this.beforeLast = -1;
    this.lineCap = this.capForLine();
  }

  private countLine(upTo: number, brLen: number, contentLen: number): void {
    for (let d = 0; d <= upTo; d++) {
      const f = this.stack[d];
      if (f === undefined || f.state !== 'body') continue;
      if (brLen > 0) {
        f.lineCount++;
        f.lastLen = contentLen;
      } else if (contentLen > 0) {
        // The final line of the message, without a line break.
        f.lineCount++;
        f.lastLen = -1;
      }
    }
  }

  private processLine(start: number, end: number, brLen: number, contentLen: number, raw: Buffer, complete: boolean): void {
    if (raw.length >= 2 && raw[0] === 0x2d && raw[1] === 0x2d && complete) {
      for (let d = this.stack.length - 1; d >= 0; d--) {
        const f = this.stack[d];
        if (f === undefined || f.node.kind !== 'multipart' || f.state !== 'body' || f.node.boundary === null) continue;
        const match = matchDelimiter(raw.subarray(0, contentLen), f.node.boundary);
        if (match === null) continue;
        if (match === 'close' && f.mp === 'epilogue') continue;
        if (match === 'open' && f.mp === 'epilogue') continue;
        this.closeAbove(d, start);
        this.countLine(d, brLen, contentLen);
        if (match === 'close') {
          f.mp = 'epilogue';
        } else {
          f.mp = 'parts';
          if (this.parts < MAX_PARTS && f.node.depth + 1 < MAX_DEPTH) {
            this.parts++;
            const childDefault = f.node.contentType.subtype === 'digest' ? 'message/rfc822' : 'text/plain';
            const child = newNode(end, f.node.depth + 1, childDefault);
            f.node.children.push(child);
            this.stack.push(this.frame(child, childDefault));
          }
        }
        return;
      }
    }
    const top = this.top();
    this.countLine(this.stack.length - 1, brLen, contentLen);
    if (top.state !== 'headers') return;
    if (contentLen === 0 && brLen > 0) {
      top.node.bodyStart = end;
      this.finishHeaders(top, end);
      return;
    }
    if (!complete || top.headerLen + raw.length > MAX_PART_HEADER_BYTES || raw.length > this.headerBudget) {
      top.node.headersTruncated = true;
      return;
    }
    top.headerChunks.push(raw);
    top.headerLen += raw.length;
    this.headerBudget -= raw.length;
  }

  /** Header block over: decide what the body is. `at` is where the body starts. */
  private finishHeaders(f: Frame, at: number): void {
    const node = f.node;
    node.headers = parseHeaderBlock(Buffer.concat(f.headerChunks));
    f.headerChunks = [];
    const ctHeader = node.headers.get('content-type');
    node.hasContentType = ctHeader !== null;
    node.contentType = parseContentType(ctHeader, f.defaultType);
    f.state = 'body';
    const ct = node.contentType;
    const encoding = transferEncoding(node);
    const boundary = ct.params['boundary'];
    if (ct.type === 'multipart' && boundary !== undefined && boundary.length > 0 && boundary.length <= MAX_BOUNDARY) {
      node.kind = 'multipart';
      node.boundary = boundary;
      return;
    }
    if (
      (ct.mimeType === 'message/rfc822' || ct.mimeType === 'message/global') &&
      encoding !== 'base64' &&
      encoding !== 'quoted-printable' &&
      node.depth + 1 < MAX_DEPTH &&
      this.parts < MAX_PARTS
    ) {
      this.parts++;
      node.kind = 'message';
      const inner = newNode(at, node.depth + 1, 'text/plain');
      node.message = inner;
      this.stack.push(this.frame(inner, 'text/plain'));
    }
  }

  /** A delimiter at `at` (a line start) ends every part above stack index `d`. */
  private closeAbove(d: number, at: number): void {
    while (this.stack.length - 1 > d) {
      const f = this.stack.pop();
      if (f === undefined) break;
      const end = Math.max(f.node.headerStart, at - this.prevBreak);
      if (f.state === 'headers') {
        f.node.bodyStart = end;
        const depth = this.stack.length;
        this.finishHeaders(f, end);
        // finishHeaders may have opened an enclosed message; it is empty and closes here too.
        if (this.stack.length > depth) {
          const inner = this.stack.pop();
          if (inner !== undefined) {
            inner.node.bodyStart = end;
            inner.node.bodyEnd = end;
          }
        }
      }
      f.node.bodyEnd = Math.max(f.node.bodyStart, end);
      // The last completed line's break belongs to the delimiter.
      f.node.lines = f.lineCount === 0 ? 0 : f.lineCount - 1 + (f.lastLen > 0 ? 1 : 0);
    }
  }

  private closeAtEof(f: Frame): void {
    if (f.state === 'headers') {
      f.node.bodyStart = this.pos;
      this.finishHeaders(f, this.pos);
      if (f.node.message !== null) {
        f.node.message.bodyStart = this.pos;
        f.node.message.bodyEnd = this.pos;
      }
    }
    f.node.bodyEnd = this.pos;
    f.node.lines = f.lineCount;
  }
}

function matchDelimiter(content: Buffer, boundary: string): 'open' | 'close' | null {
  const b = Buffer.from(boundary, 'latin1');
  if (content.length < 2 + b.length) return null;
  if (!content.subarray(2, 2 + b.length).equals(b)) return null;
  let i = 2 + b.length;
  let close = false;
  if (content[i] === 0x2d && content[i + 1] === 0x2d) {
    close = true;
    i += 2;
  }
  for (; i < content.length; i++) {
    const c = content[i];
    if (c !== 0x20 && c !== 0x09) return null;
  }
  return close ? 'close' : 'open';
}

/** Content-Transfer-Encoding, lowercased; 7bit when absent. */
export function transferEncoding(node: MimeNode): string {
  const v = node.headers.get('content-transfer-encoding');
  if (v === null) return '7bit';
  const t = v.trim().toLowerCase();
  return t === '' ? '7bit' : t;
}

/** Scan a whole stream. */
export async function scanStructure(source: AsyncIterable<Uint8Array>): Promise<MessageStructure> {
  const scanner = new StructureScanner();
  for await (const chunk of source) scanner.write(chunk);
  return scanner.end();
}

// --- part addressing (RFC 3501 §6.4.5) -----------------------------------------------------------

/** Part `n` of a message node: its n-th child when multipart, else itself for n = 1. */
function messagePart(m: MimeNode, n: number): MimeNode | null {
  if (m.kind === 'multipart') return m.children[n - 1] ?? null;
  return n === 1 ? m : null;
}

/** Part `n` below an already-addressed part. */
function subPart(node: MimeNode, n: number): MimeNode | null {
  if (node.kind === 'multipart') return node.children[n - 1] ?? null;
  if (node.kind === 'message' && node.message !== null) return messagePart(node.message, n);
  return null;
}

/** The node a dotted part path names, or null when there is no such part. */
export function resolvePart(root: MimeNode, path: readonly number[]): MimeNode | null {
  const first = path[0];
  if (first === undefined) return root;
  let node = messagePart(root, first);
  for (let i = 1; i < path.length && node !== null; i++) node = subPart(node, path[i] ?? 0);
  return node;
}
