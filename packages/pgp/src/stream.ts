// Streaming helpers for the signed-part hash (PST-REQ-050: no parser holds a whole message).
//
// `splitLines` turns chunks into lines with bounded memory: a line longer than `maxLine` comes out
// in segments (`eol: false` until its last one). `walkMultipart` runs the RFC 2046 §5.1.1 grammar
// over those lines and hands each body part to a sink as CANONICAL bytes — CRLF between lines, and
// no line break before the next delimiter, because that CRLF belongs to the delimiter. That is
// exactly the octet sequence RFC 3156 §5 and RFC 8551 §3.5 sign.

import { createHash, type Hash } from 'node:crypto';

export interface Line {
  bytes: Buffer;
  /** False for a segment of an over-long line that continues in the next Line. */
  eol: boolean;
}

export type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export async function* splitLines(source: ByteSource, maxLine = 8192): AsyncGenerator<Line> {
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    let buf = carry.length === 0 ? Buffer.from(chunk) : Buffer.concat([carry, chunk]);
    let start = 0;
    for (let lf = buf.indexOf(0x0a, start); lf >= 0; lf = buf.indexOf(0x0a, start)) {
      const end = lf > start && buf[lf - 1] === 0x0d ? lf - 1 : lf;
      yield { bytes: buf.subarray(start, end), eol: true };
      start = lf + 1;
    }
    buf = buf.subarray(start);
    while (buf.length > maxLine) {
      // Keep a trailing CR back: it may be the first half of a CRLF.
      let cut = maxLine;
      if (buf[cut - 1] === 0x0d) cut--;
      yield { bytes: buf.subarray(0, cut), eol: false };
      buf = buf.subarray(cut);
    }
    carry = Buffer.from(buf);
  }
  if (carry.length > 0) yield { bytes: carry, eol: true };
}

export interface PartSink {
  /** Canonical bytes of the part, in order. */
  write(bytes: Buffer): void;
  /** Each complete short line of the part (for spotting armored key blocks). */
  line?(bytes: Buffer): void;
}

export type Delimiter = 'open' | 'close' | null;

export function delimiterKind(line: Buffer, boundary: string): Delimiter {
  const dash = `--${boundary}`;
  if (line.length < dash.length || line.subarray(0, dash.length).toString('latin1') !== dash) return null;
  let rest = line.subarray(dash.length).toString('latin1');
  let kind: Delimiter = 'open';
  if (rest.startsWith('--')) {
    kind = 'close';
    rest = rest.slice(2);
  }
  return /^[ \t]*$/.test(rest) ? kind : null;
}

export interface WalkResult {
  parts: number;
  closed: boolean;
}

const CRLF = Buffer.from('\r\n');

/**
 * Walks the body of a multipart entity. `sinkFor(i)` is asked for a sink as part `i` (0-based)
 * begins; returning null discards that part. `stopAfter` ends the walk (without draining the rest
 * of the input) once that many parts have ended.
 */
export async function walkMultipart(lines: AsyncIterator<Line>, boundary: string, sinkFor: (index: number) => PartSink | null, stopAfter = Infinity): Promise<WalkResult> {
  let index = -1;
  let sink: PartSink | null = null;
  let pendingEol = false;
  let midLine = false;
  for (;;) {
    const next = await lines.next();
    if (next.done === true) break;
    const { bytes, eol } = next.value;
    if (!midLine && eol) {
      const kind = delimiterKind(bytes, boundary);
      if (kind !== null) {
        if (index >= 0 && index + 1 >= stopAfter) return { parts: index + 1, closed: kind === 'close' };
        if (kind === 'close') return { parts: index + 1, closed: true };
        index++;
        sink = sinkFor(index);
        pendingEol = false;
        continue;
      }
    }
    if (sink !== null) {
      if (!midLine && pendingEol) sink.write(CRLF);
      sink.write(bytes);
      if (!midLine && eol) sink.line?.(bytes);
    }
    midLine = !eol;
    pendingEol = eol;
  }
  return { parts: index + 1, closed: false };
}

/** Collects a part in memory up to `cap` bytes; past it, `overflow` is set and the rest dropped. */
export class CollectSink implements PartSink {
  private readonly chunks: Buffer[] = [];
  size = 0;
  overflow = false;

  constructor(private readonly cap: number) {}

  write(bytes: Buffer): void {
    if (this.overflow) return;
    if (this.size + bytes.length > this.cap) {
      this.overflow = true;
      return;
    }
    this.chunks.push(Buffer.from(bytes));
    this.size += bytes.length;
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

export const MULTI_HASHES = ['sha1', 'sha224', 'sha256', 'sha384', 'sha512'] as const;

/**
 * Hashes a part under every digest a signature might name, since the signature (and so its hash
 * algorithm) only arrives in the part AFTER the signed one. Also keeps armored OpenPGP public key
 * blocks it sees (bounded), because a signer's key often rides along as an attachment.
 */
export class HashSink implements PartSink {
  private readonly hashes = new Map<string, Hash>(MULTI_HASHES.map((h) => [h, createHash(h)]));
  size = 0;
  readonly armoredKeys: string[] = [];
  private capture: string[] | null = null;
  private captured = 0;

  constructor(private readonly maxKeyBytes = 256 * 1024) {}

  write(bytes: Buffer): void {
    this.size += bytes.length;
    for (const h of this.hashes.values()) h.update(bytes);
  }

  line(bytes: Buffer): void {
    if (bytes.length > 200 && this.capture === null) return;
    const text = bytes.toString('latin1');
    if (this.capture === null) {
      if (/^-----BEGIN PGP PUBLIC KEY BLOCK-----\s*$/.test(text)) this.capture = [text];
      return;
    }
    this.captured += bytes.length + 2;
    if (this.captured > this.maxKeyBytes) {
      this.capture = null;
      return;
    }
    this.capture.push(text);
    if (/^-----END PGP PUBLIC KEY BLOCK-----\s*$/.test(text)) {
      this.armoredKeys.push(this.capture.join('\n'));
      this.capture = null;
    }
  }

  /** A copy of the running hash, to finish without disturbing the others. */
  copy(name: string): Hash | null {
    return this.hashes.get(name)?.copy() ?? null;
  }
}
