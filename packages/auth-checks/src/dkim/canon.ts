// DKIM canonicalization (RFC 6376 §3.4), shared by the signer and the verifier.
//
// Headers are small and bounded, so header canonicalization works on one field at a time. The body
// may be 100 MB, so body canonicalization is a streaming state machine: chunks may split anywhere
// (inside a CRLF, inside a whitespace run) and the only state carried between chunks is a count of
// deferred CRLFs and two flags. Content bytes are emitted as soon as they are known to be content.
//
// Strings in this module are latin1 ("binary") so every byte round-trips, including the UTF-8 of
// SMTPUTF8 headers. Input is expected in wire form with CRLF line endings; a bare CR or bare LF is
// treated as an ordinary content byte (the SMTP daemons reject bare line endings before this).

import { createHash, type Hash } from 'node:crypto';

export type Canonicalization = 'simple' | 'relaxed';

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const HTAB = 0x09;

const CRLF = Buffer.from('\r\n', 'latin1');
const SPACE = Buffer.from(' ', 'latin1');
const CR_BYTE = Buffer.from('\r', 'latin1');

// ---- headers (§3.4.1, §3.4.2) ----

/**
 * Canonicalize one header field. `raw` is the field exactly as on the wire, including any folding
 * CRLFs, but WITHOUT the CRLF that terminates it. The result also has no terminating CRLF; the
 * caller appends one when building the hash input.
 */
export function canonicalizeHeader(raw: Buffer | string, mode: Canonicalization): string {
  const text = typeof raw === 'string' ? raw : raw.toString('latin1');
  if (mode === 'simple') return text;
  return relaxedHeader(text);
}

function relaxedHeader(text: string): string {
  const colon = text.indexOf(':');
  // A line without a colon is not a header field; relaxed canonicalization of it is still defined
  // enough to be stable: treat the whole line as the name with an empty value.
  const rawName = colon === -1 ? text : text.slice(0, colon);
  const rawValue = colon === -1 ? '' : text.slice(colon + 1);
  const name = asciiLower(rawName.replace(/\r\n/g, '').replace(/[ \t]+$/, ''));
  const value = rawValue
    .replace(/\r\n/g, '') // unfold: every CRLF inside a field is followed by WSP
    .replace(/[ \t]+/g, ' ') // collapse WSP runs
    .replace(/^ /, '') // no WSP after the colon
    .replace(/ $/, ''); // no trailing WSP
  return colon === -1 ? name : `${name}:${value}`;
}

/** Lowercase ASCII letters only, so latin1 bytes >= 0x80 are never touched. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

// ---- body (§3.4.3, §3.4.4) ----

export type BodySink = (chunk: Buffer) => void;

/**
 * Streaming body canonicalizer. Feed `update()` any chunking of the body; call `end()` once.
 * Canonical bytes are pushed to `sink` as they become final.
 *
 * Carried state: `crlfRun` (CRLFs seen with no content after them yet — they are either interior
 * line ends, emitted when content follows, or trailing empty lines, collapsed at the end), `cr`
 * (a CR whose LF may arrive in the next chunk), and `wsp` (relaxed only: a whitespace run not yet
 * known to be interior or trailing).
 */
export class BodyCanonicalizer {
  readonly mode: Canonicalization;
  private readonly sink: BodySink;
  private crlfRun = 0;
  private cr = false;
  private wsp = false;
  private emittedContent = false;
  private ended = false;

  constructor(mode: Canonicalization, sink: BodySink) {
    this.mode = mode;
    this.sink = sink;
  }

  update(chunk: Uint8Array): void {
    if (this.ended) throw new Error('BodyCanonicalizer: update after end');
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
    const relaxed = this.mode === 'relaxed';
    let runStart = 0;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      const special = b === CR || b === LF || (relaxed && (b === SP || b === HTAB));
      if (!special) {
        if (this.cr) {
          // Previous byte was a bare CR: it is content.
          this.cr = false;
          this.content(CR_BYTE);
        }
        continue;
      }
      // Flush the plain content run before this special byte.
      if (i > runStart) this.content(buf.subarray(runStart, i));
      runStart = i + 1;
      if (b === LF) {
        if (this.cr) {
          this.cr = false;
          this.wsp = false; // relaxed: WSP at end of line is ignored
          this.crlfRun++;
        } else {
          this.content(buf.subarray(i, i + 1)); // bare LF is content
        }
        continue;
      }
      if (this.cr) {
        // A CR not followed by LF.
        this.cr = false;
        this.content(CR_BYTE);
      }
      if (b === CR) {
        this.cr = true;
      } else {
        this.wsp = true; // relaxed SP/HTAB
      }
    }
    if (buf.length > runStart) {
      if (this.cr) {
        this.cr = false;
        this.content(CR_BYTE);
      }
      this.content(buf.subarray(runStart));
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.cr) {
      this.cr = false;
      this.content(CR_BYTE);
    }
    this.wsp = false; // trailing WSP of an unterminated last line
    if (this.emittedContent) {
      // Trailing empty lines collapse; a missing final CRLF is added (both modes).
      this.sink(CRLF);
    } else if (this.mode === 'simple') {
      this.sink(CRLF); // simple: an empty body is a single CRLF
    }
    // relaxed: an empty body stays empty
  }

  private content(bytes: Buffer): void {
    for (; this.crlfRun > 0; this.crlfRun--) this.sink(CRLF);
    if (this.wsp) {
      this.wsp = false;
      this.sink(SPACE);
    }
    this.emittedContent = true;
    this.sink(bytes);
  }
}

/**
 * Streaming SHA-256 body hash with an optional `l=` limit: only the first `limit` canonical bytes
 * are hashed. `canonicalLength` is the full canonical length, so a verifier can reject an `l=`
 * that exceeds the body.
 */
export class BodyHasher {
  private readonly hash: Hash = createHash('sha256');
  private readonly canon: BodyCanonicalizer;
  private readonly limit: number | undefined;
  private hashed = 0;
  private total = 0;
  private result: Buffer | undefined;

  constructor(mode: Canonicalization, limit?: number) {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new RangeError('body length limit must be a non-negative integer');
    }
    this.limit = limit;
    this.canon = new BodyCanonicalizer(mode, (chunk) => {
      this.total += chunk.length;
      if (this.limit === undefined) {
        this.hash.update(chunk);
        return;
      }
      const room = this.limit - this.hashed;
      if (room <= 0) return;
      const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
      this.hashed += part.length;
      this.hash.update(part);
    });
  }

  update(chunk: Uint8Array): this {
    this.canon.update(chunk);
    return this;
  }

  /** Finish and return the raw 32-byte digest. Idempotent. */
  digest(): Buffer {
    if (this.result === undefined) {
      this.canon.end();
      this.result = this.hash.digest();
    }
    return this.result;
  }

  /** Canonical body length in bytes (complete only after `digest()`). */
  get canonicalLength(): number {
    return this.total;
  }
}

/** One-shot body canonicalization, for tests and small bodies. */
export function canonicalizeBody(body: Uint8Array | string, mode: Canonicalization): Buffer {
  const parts: Buffer[] = [];
  const c = new BodyCanonicalizer(mode, (chunk) => parts.push(Buffer.from(chunk)));
  c.update(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
  c.end();
  return Buffer.concat(parts);
}

/** Parse a `c=` tag value: "header/body", body defaulting to simple, the whole tag to simple/simple. */
export function parseCanonicalization(
  value: string | undefined,
): { header: Canonicalization; body: Canonicalization } | undefined {
  if (value === undefined) return { header: 'simple', body: 'simple' };
  const [h, b = 'simple', extra] = value.split('/');
  if (extra !== undefined) return undefined;
  const header = asciiLower(h ?? '');
  const body = asciiLower(b);
  if ((header !== 'simple' && header !== 'relaxed') || (body !== 'simple' && body !== 'relaxed')) {
    return undefined;
  }
  return { header, body };
}
