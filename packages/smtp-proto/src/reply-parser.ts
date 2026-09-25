// Client-side reply parser (RFC 5321 §4.2.1): incremental, byte-level, strict CRLF.
//
// The delivery client feeds it whatever the socket yields; it returns every reply completed by that
// chunk. A malformed reply throws `SmtpReplyError` and leaves the parser failed — a client that
// cannot frame the server's replies cannot know what the server accepted, so it must drop the
// connection and retry later rather than guess.

import type { SmtpReply } from './reply.js';

export class SmtpReplyError extends Error {
  override readonly name = 'SmtpReplyError';
}

export interface ReplyParserOptions {
  /** Longest reply line accepted, excluding CRLF. RFC 5321 says 512; real servers exceed it. */
  readonly maxLineLength?: number;
  /** Most lines in one (multiline) reply. */
  readonly maxLines?: number;
}

const CR = 13;
const LF = 10;
const decoder = new TextDecoder('utf-8');

export class ReplyParser {
  private readonly maxLineLength: number;
  private readonly maxLines: number;
  private readonly line: Buffer;
  private lineLen = 0;
  private sawCR = false;
  private failed: SmtpReplyError | null = null;
  private code: number | null = null;
  private texts: string[] = [];

  constructor(options: ReplyParserOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? 4096;
    this.maxLines = options.maxLines ?? 256;
    this.line = Buffer.alloc(this.maxLineLength);
  }

  /** True while part of a reply has been received but not its final line. */
  get pending(): boolean {
    return this.code !== null || this.lineLen > 0 || this.sawCR;
  }

  push(chunk: Uint8Array): SmtpReply[] {
    if (this.failed) throw this.failed;
    const out: SmtpReply[] = [];
    for (const b of chunk) {
      if (this.sawCR) {
        this.sawCR = false;
        if (b !== LF) this.fail('bare CR in reply');
        const r = this.endLine();
        if (r) out.push(r);
        continue;
      }
      if (b === CR) {
        this.sawCR = true;
        continue;
      }
      if (b === LF) this.fail('bare LF in reply');
      if (this.lineLen >= this.maxLineLength) this.fail('reply line too long');
      this.line[this.lineLen++] = b;
    }
    return out;
  }

  private fail(message: string): never {
    this.failed = new SmtpReplyError(message);
    throw this.failed;
  }

  private endLine(): SmtpReply | null {
    const raw = this.line.subarray(0, this.lineLen);
    this.lineLen = 0;
    if (raw.length < 3) this.fail('reply line shorter than a code');
    const d0 = raw[0] ?? 0;
    const d1 = raw[1] ?? 0;
    const d2 = raw[2] ?? 0;
    if (d0 < 0x32 || d0 > 0x35 || d1 < 0x30 || d1 > 0x35 || d2 < 0x30 || d2 > 0x39) {
      this.fail('invalid reply code');
    }
    const code = (d0 - 0x30) * 100 + (d1 - 0x30) * 10 + (d2 - 0x30);
    let last: boolean;
    if (raw.length === 3) last = true;
    else if (raw[3] === 0x20) last = true;
    else if (raw[3] === 0x2d) last = false;
    else this.fail('invalid reply separator');
    if (this.code !== null && this.code !== code) this.fail('inconsistent codes in multiline reply');
    this.code = code;
    this.texts.push(raw.length > 4 ? decoder.decode(raw.subarray(4)) : '');
    if (this.texts.length > this.maxLines) this.fail('too many reply lines');
    if (!last) return null;
    const r = finishReply(code, this.texts);
    this.code = null;
    this.texts = [];
    return r;
  }
}

/** Split an enhanced status code (RFC 2034) off every line when the first line carries one. */
function finishReply(code: number, texts: string[]): SmtpReply {
  const first = texts[0] ?? '';
  const m = /^([245]\.\d{1,3}\.\d{1,3})(?: |$)/.exec(first);
  const enhanced = m?.[1];
  if (enhanced === undefined || enhanced[0] !== String(code)[0]) return { code, lines: texts };
  const lines = texts.map((t) => {
    if (t === enhanced) return '';
    if (t.startsWith(`${enhanced} `)) return t.slice(enhanced.length + 1);
    return t;
  });
  return { code, enhanced, lines };
}
