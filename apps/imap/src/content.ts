// Message content for FETCH and SEARCH: the per-blob structure cache and byte-range streams over the
// decrypted blob (PST-REQ-050: nothing here holds a whole message).
//
// The blob store decrypts from the start of the file (the AEAD stream cannot seek), so a range read
// streams up to its end and stops; a header read therefore costs only the first chunk.
import type { Readable } from 'node:stream';
import type { BlobStore } from '@postroom/blobstore';
import { createTransferDecoder } from '@postroom/mime';
import { scanStructure, transferEncoding, type MessageStructure, type MimeNode } from './structure.js';

/** Just the part of the blob store this module reads with (tests pass an in-memory one). */
export type BlobReader = Pick<BlobStore, 'get'>;

export interface StructureCache {
  get(sha256: string): Promise<MessageStructure>;
  /** Remember a structure computed elsewhere (APPEND scans while it stores). */
  put(sha256: string, structure: MessageStructure): void;
  readonly size: number;
}

/**
 * An in-process LRU of computed structures, keyed by the blob's SHA-256 — content-addressed, so an
 * entry is never stale. Concurrent requests for one blob share a single scan.
 */
export function createStructureCache(blobs: BlobReader, maxEntries = 1000): StructureCache {
  const entries = new Map<string, MessageStructure>();
  const inflight = new Map<string, Promise<MessageStructure>>();
  const remember = (sha: string, s: MessageStructure): void => {
    entries.delete(sha);
    entries.set(sha, s);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done === true) break;
      entries.delete(oldest.value);
    }
  };
  return {
    get size() {
      return entries.size;
    },
    put: remember,
    get: (sha) => {
      const hit = entries.get(sha);
      if (hit !== undefined) {
        remember(sha, hit);
        return Promise.resolve(hit);
      }
      const running = inflight.get(sha);
      if (running !== undefined) return running;
      const p = (async () => {
        const stream = await blobs.get(sha);
        try {
          const s = await scanStructure(stream);
          remember(sha, s);
          return s;
        } finally {
          inflight.delete(sha);
          stream.destroy();
        }
      })();
      inflight.set(sha, p);
      return p;
    },
  };
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
  throw new TypeError('blob streams must yield bytes');
}

/** Octets [start, end) of the plaintext, streamed. */
export async function* blobRange(blobs: BlobReader, sha256: string, start: number, end: number): AsyncGenerator<Buffer> {
  if (end <= start) return;
  const stream: Readable = await blobs.get(sha256);
  let pos = 0;
  try {
    for await (const raw of stream) {
      const chunk = asBuffer(raw);
      const from = pos;
      pos += chunk.length;
      if (pos <= start) continue;
      const a = Math.max(0, start - from);
      const b = Math.min(chunk.length, end - from);
      if (b > a) yield chunk.subarray(a, b);
      if (pos >= end) break;
    }
  } finally {
    stream.destroy();
  }
}

/** Read a (small) range into memory. */
export async function readRange(blobs: BlobReader, sha256: string, start: number, end: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of blobRange(blobs, sha256, start, end)) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

/** Encodings BINARY can undo (RFC 3516); anything else is [UNKNOWN-CTE]. */
export function binaryDecodable(node: MimeNode): boolean {
  if (node.kind !== 'leaf') return true;
  const e = transferEncoding(node);
  return e === '7bit' || e === '8bit' || e === 'binary' || e === 'base64' || e === 'quoted-printable';
}

/** The decoded body of a leaf (identity for multiparts and messages, which BINARY returns as-is). */
export async function* decodedBody(blobs: BlobReader, sha256: string, node: MimeNode): AsyncGenerator<Buffer> {
  const encoding = node.kind === 'leaf' ? transferEncoding(node) : '7bit';
  const decoder = createTransferDecoder(encoding);
  for await (const chunk of blobRange(blobs, sha256, node.bodyStart, node.bodyEnd)) {
    const out = decoder.write(chunk);
    if (out.length > 0) yield out;
  }
  const tail = decoder.end();
  if (tail.length > 0) yield tail;
}

/** BINARY.SIZE: one decoding pass, remembered on the (cached) node. */
export async function binarySize(blobs: BlobReader, sha256: string, node: MimeNode): Promise<number> {
  if (node.binarySize !== undefined) return node.binarySize;
  let n = 0;
  for await (const c of decodedBody(blobs, sha256, node)) n += c.length;
  node.binarySize = n;
  return n;
}

/** Skip `offset` octets of a stream and yield at most `length` more. */
export async function* sliceStream(source: AsyncIterable<Buffer>, offset: number, length: number): AsyncGenerator<Buffer> {
  if (length <= 0) return;
  let pos = 0;
  const end = offset + length;
  for await (const chunk of source) {
    const from = pos;
    pos += chunk.length;
    if (pos <= offset) continue;
    const a = Math.max(0, offset - from);
    const b = Math.min(chunk.length, end - from);
    if (b > a) yield chunk.subarray(a, b);
    if (pos >= end) break;
  }
}
