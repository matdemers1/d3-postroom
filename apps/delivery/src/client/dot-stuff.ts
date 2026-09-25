// Streaming DATA encoder (RFC 5321 §4.5.2): CRLF-normalise and dot-stuff a message chunk by chunk,
// then close it with <CRLF>.<CRLF>. The blob store already holds CRLF, so normalisation is a guard:
// a bare CR or LF that reached the wire would be an SMTP-smuggling vector (a remote that treats
// <LF>.<LF> as the end of data would see a second message the sender never wrote).
//
// Never buffers more than one chunk: `push` returns the encoded bytes for the chunk it was given.

const CR = 0x0d;
const LF = 0x0a;
const DOT = 0x2e;

export class DotStuffer {
  private atLineStart = true;
  private pendingCR = false;
  private ended = false;

  /** Encode one chunk. The result may be empty (a chunk that was a lone trailing CR). */
  push(chunk: Uint8Array): Buffer {
    if (this.ended) throw new Error('DotStuffer: push after end');
    // Worst case every byte becomes two (every byte a bare LF, or a dot at the start of a line).
    const out = Buffer.allocUnsafe(chunk.length * 2 + 2);
    let n = 0;
    for (const b of chunk) {
      if (this.pendingCR) {
        this.pendingCR = false;
        out[n++] = CR;
        out[n++] = LF;
        this.atLineStart = true;
        if (b === LF) continue;
        // A bare CR became CRLF; fall through and encode b as the start of a new line.
      }
      if (b === CR) {
        this.pendingCR = true;
        continue;
      }
      if (b === LF) {
        out[n++] = CR;
        out[n++] = LF;
        this.atLineStart = true;
        continue;
      }
      if (this.atLineStart && b === DOT) out[n++] = DOT;
      out[n++] = b;
      this.atLineStart = false;
    }
    return out.subarray(0, n);
  }

  /** The bytes that finish the body: a line end if the message lacked one, then ".\r\n". */
  end(): Buffer {
    if (this.ended) throw new Error('DotStuffer: end called twice');
    this.ended = true;
    let tail = '';
    if (this.pendingCR) {
      tail += '\r\n';
      this.atLineStart = true;
    }
    if (!this.atLineStart) tail += '\r\n';
    return Buffer.from(`${tail}.\r\n`, 'latin1');
  }
}
