// Streaming blob encryption (PST-REQ-010): a message of 100 MB is never held in memory.
//
// Format 0x21, a STREAM construction (Hoang, Reyhanitabar, Rogaway, Vizár 2015) over AES-256-GCM,
// laid out as Tink's streaming AEAD is:
//
//   header   [0x21][noncePrefix 7]                 8 bytes, prefix random per stream
//   segment  [ciphertext][tag 16]                   every segment but the last carries exactly
//                                                   SEGMENT_BYTES of plaintext; the last carries
//                                                   0..SEGMENT_BYTES (an empty blob is one empty
//                                                   final segment: just a tag)
//
//   nonce(i) = noncePrefix || uint32be(i) || lastFlag     (7 + 4 + 1 = 12 bytes)
//   aad      = header || caller aad                       (binds every segment to this blob)
//
// What that buys:
//   - tampering: every segment is authenticated by GCM;
//   - reordering: the segment index is in the nonce, so segment i only opens at position i;
//   - truncation: only the final segment is sealed with lastFlag = 1, so a stream cut at a segment
//     boundary ends on a segment that fails to open as final; appended bytes make the real final
//     segment be read as non-final, which also fails.
//
// The decryptor never emits a segment's plaintext before that segment's tag has verified, and any
// failure is a stream error (DecryptError). The plaintext already emitted for earlier segments is
// authentic but incomplete, so a consumer must not treat a blob as read until the stream ends
// cleanly.

import { randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import {
  aadBytes,
  assertDek,
  FORMAT_DEK_STREAM,
  gcmOpen,
  gcmSeal,
  TAG_BYTES,
  type Aad,
} from './aead.js';
import { DecryptError } from './errors.js';

export const SEGMENT_BYTES = 64 * 1024;
const PREFIX_BYTES = 7;
export const STREAM_HEADER_BYTES = 1 + PREFIX_BYTES;
const MAX_SEGMENTS = 0xffff_ffff;

function segmentNonce(prefix: Buffer, index: number, last: boolean): Buffer {
  if (index > MAX_SEGMENTS) throw new RangeError('stream too long for its segment counter');
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, PREFIX_BYTES);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

/** Size of the ciphertext for a plaintext of `plainBytes`. */
export function encryptedSize(plainBytes: number): number {
  const segments = Math.max(1, Math.ceil(plainBytes / SEGMENT_BYTES));
  return STREAM_HEADER_BYTES + plainBytes + segments * TAG_BYTES;
}

function toBuffer(chunk: unknown, encoding: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding);
  throw new TypeError('stream chunks must be Buffer, Uint8Array or string');
}

/** A Transform that encrypts plaintext into format 0x21 under a per-blob DEK. */
export function createEncryptStream(dek: Uint8Array, aad: Aad): Transform {
  assertDek(dek);
  const key = Buffer.from(dek);
  const prefix = randomBytes(PREFIX_BYTES);
  const header = Buffer.concat([Buffer.of(FORMAT_DEK_STREAM), prefix]);
  const segAad = Buffer.concat([header, aadBytes(aad)]);
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  let headerSent = false;

  const sendHeader = (t: Transform): void => {
    if (!headerSent) {
      headerSent = true;
      t.push(header);
    }
  };

  return new Transform({
    transform(this: Transform, chunk: unknown, encoding: BufferEncoding, cb: TransformCallback) {
      try {
        sendHeader(this);
        pending = pending.length === 0 ? toBuffer(chunk, encoding) : Buffer.concat([pending, toBuffer(chunk, encoding)]);
        // Strictly greater: a full segment may still turn out to be the last one.
        let offset = 0;
        while (pending.length - offset > SEGMENT_BYTES) {
          const plain = pending.subarray(offset, offset + SEGMENT_BYTES);
          this.push(gcmSeal(key, segmentNonce(prefix, index, false), segAad, plain));
          index += 1;
          offset += SEGMENT_BYTES;
        }
        // Copy the remainder so the caller's (possibly large) chunk is not retained.
        pending = offset === 0 ? pending : Buffer.from(pending.subarray(offset));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(this: Transform, cb: TransformCallback) {
      try {
        sendHeader(this);
        this.push(gcmSeal(key, segmentNonce(prefix, index, true), segAad, pending));
        pending = Buffer.alloc(0);
        key.fill(0);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

/** A Transform that decrypts format 0x21. Errors with DecryptError on any tamper or truncation. */
export function createDecryptStream(dek: Uint8Array, aad: Aad): Transform {
  assertDek(dek);
  const key = Buffer.from(dek);
  const callerAad = aadBytes(aad);
  const sealedSegment = SEGMENT_BYTES + TAG_BYTES;
  let pending: Buffer = Buffer.alloc(0);
  let prefix: Buffer | undefined;
  let segAad: Buffer | undefined;
  let index = 0;

  const readHeader = (): boolean => {
    if (prefix !== undefined) return true;
    if (pending.length < STREAM_HEADER_BYTES) return false;
    if (pending[0] !== FORMAT_DEK_STREAM) throw new DecryptError('unknown stream format');
    const header = Buffer.from(pending.subarray(0, STREAM_HEADER_BYTES));
    prefix = header.subarray(1);
    segAad = Buffer.concat([header, callerAad]);
    pending = pending.subarray(STREAM_HEADER_BYTES);
    return true;
  };

  return new Transform({
    transform(this: Transform, chunk: unknown, encoding: BufferEncoding, cb: TransformCallback) {
      try {
        pending = pending.length === 0 ? toBuffer(chunk, encoding) : Buffer.concat([pending, toBuffer(chunk, encoding)]);
        if (!readHeader() || prefix === undefined || segAad === undefined) {
          cb();
          return;
        }
        let offset = 0;
        while (pending.length - offset > sealedSegment) {
          const sealed = pending.subarray(offset, offset + sealedSegment);
          this.push(gcmOpen(key, segmentNonce(prefix, index, false), segAad, sealed));
          index += 1;
          offset += sealedSegment;
        }
        pending = offset === 0 ? pending : Buffer.from(pending.subarray(offset));
        cb();
      } catch (err) {
        cb(err instanceof DecryptError ? err : new DecryptError('stream authentication failed'));
      }
    },
    flush(this: Transform, cb: TransformCallback) {
      try {
        if (!readHeader() || prefix === undefined || segAad === undefined) {
          throw new DecryptError('stream truncated: no header');
        }
        if (pending.length < TAG_BYTES) throw new DecryptError('stream truncated');
        this.push(gcmOpen(key, segmentNonce(prefix, index, true), segAad, pending));
        pending = Buffer.alloc(0);
        key.fill(0);
        cb();
      } catch (err) {
        cb(err instanceof DecryptError ? err : new DecryptError('stream authentication failed'));
      }
    },
  });
}
