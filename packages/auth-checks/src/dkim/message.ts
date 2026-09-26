// Split an RFC 5322 message into a bounded header block and a streamed body.
//
// The header block is read until the first empty line (CRLF CRLF) and must fit in `maxHeaderBytes`;
// the body is never buffered — it is handed back as an async iterable over the rest of the input.
// Header fields keep their original bytes (folding included) because simple canonicalization and
// the signature's own b= removal both need them verbatim.

import type { Readable } from 'node:stream';
import { asciiLower } from './canon.js';
import { HeaderTooLargeError } from './errors.js';

export const DEFAULT_MAX_HEADER_BYTES = 1024 * 1024;

export interface HeaderField {
  /** Field name as written (before the colon, trailing WSP removed). */
  readonly name: string;
  /** Lowercased name, for matching. */
  readonly key: string;
  /** The field's exact bytes, folding included, without the terminating CRLF. */
  readonly raw: Buffer;
}

export interface SplitMessage {
  /** The header block's exact bytes, including the CRLF ending the last field (not the blank line). */
  readonly headerBlock: Buffer;
  readonly fields: readonly HeaderField[];
  /** The body, after the blank line. Iterate once. */
  readonly body: AsyncIterable<Buffer>;
}

export interface SplitOptions {
  maxHeaderBytes?: number;
}

export type MessageInput = Readable | Buffer | Uint8Array | AsyncIterable<Uint8Array>;

const SEPARATOR = Buffer.from('\r\n\r\n', 'latin1');

export async function splitMessage(input: MessageInput, options: SplitOptions = {}): Promise<SplitMessage> {
  const max = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  if (input instanceof Uint8Array) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.length);
    const { head, rest } = cut(buf, max);
    return { headerBlock: head, fields: parseHeaderFields(head), body: once(rest) };
  }

  const iterator = (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  let acc: Buffer = Buffer.alloc(0);
  for (;;) {
    const next = await iterator.next();
    if (next.done === true) {
      // No blank line: the whole message is header.
      const { head, rest } = cut(acc, max);
      return { headerBlock: head, fields: parseHeaderFields(head), body: once(rest) };
    }
    const chunk = toBuffer(next.value);
    const searchFrom = Math.max(0, acc.length - (SEPARATOR.length - 1));
    acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
    const at = findSeparator(acc, searchFrom);
    if (at === undefined) {
      if (acc.length > max) {
        await closeIterator(iterator);
        throw new HeaderTooLargeError(`header block exceeds ${max} bytes`);
      }
      continue;
    }
    if (at.headEnd > max) {
      await closeIterator(iterator);
      throw new HeaderTooLargeError(`header block exceeds ${max} bytes`);
    }
    const head = acc.subarray(0, at.headEnd);
    const first = acc.subarray(at.bodyStart);
    return { headerBlock: head, fields: parseHeaderFields(head), body: rest(first, iterator) };
  }
}

function toBuffer(chunk: Uint8Array | string): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'latin1');
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length);
}

async function closeIterator(it: AsyncIterator<Uint8Array>): Promise<void> {
  if (it.return !== undefined) await it.return();
}

/** Where the header ends and the body starts, or undefined if the blank line is not in `buf`. */
function findSeparator(buf: Buffer, from: number): { headEnd: number; bodyStart: number } | undefined {
  // A message that starts with CRLF has an empty header block.
  if (buf.length >= 2 && buf[0] === 0x0d && buf[1] === 0x0a) return { headEnd: 0, bodyStart: 2 };
  const i = buf.indexOf(SEPARATOR, from);
  if (i === -1) return undefined;
  return { headEnd: i + 2, bodyStart: i + 4 };
}

function cut(buf: Buffer, max: number): { head: Buffer; rest: Buffer } {
  const at = findSeparator(buf, 0);
  if (at === undefined) {
    if (buf.length > max) throw new HeaderTooLargeError(`header block exceeds ${max} bytes`);
    return { head: buf, rest: Buffer.alloc(0) };
  }
  if (at.headEnd > max) throw new HeaderTooLargeError(`header block exceeds ${max} bytes`);
  return { head: buf.subarray(0, at.headEnd), rest: buf.subarray(at.bodyStart) };
}

// eslint-disable-next-line @typescript-eslint/require-await -- an async generator over one chunk
async function* once(buf: Buffer): AsyncGenerator<Buffer> {
  if (buf.length > 0) yield buf;
}

async function* rest(first: Buffer, it: AsyncIterator<Uint8Array>): AsyncGenerator<Buffer> {
  if (first.length > 0) yield first;
  for (;;) {
    const next = await it.next();
    if (next.done === true) return;
    const chunk = toBuffer(next.value);
    if (chunk.length > 0) yield chunk;
  }
}

/**
 * Split a header block into fields. A field is a line plus every following line that starts with
 * WSP. A leading continuation line (no field to continue) or a line without a colon still becomes
 * a field, so no bytes are silently dropped; it simply never matches a name.
 */
export function parseHeaderFields(block: Buffer): HeaderField[] {
  const fields: HeaderField[] = [];
  let start = 0;
  let pos = 0;
  while (pos < block.length) {
    const nl = block.indexOf('\r\n', pos, 'latin1');
    const lineEnd = nl === -1 ? block.length : nl;
    const nextLine = nl === -1 ? block.length : nl + 2;
    const next = block[nextLine];
    const continues = nextLine < block.length && (next === 0x20 || next === 0x09);
    if (!continues) {
      fields.push(makeField(block.subarray(start, lineEnd)));
      start = nextLine;
    }
    pos = nextLine;
  }
  return fields;
}

function makeField(raw: Buffer): HeaderField {
  const text = raw.toString('latin1');
  const colon = text.indexOf(':');
  const name = colon === -1 ? '' : text.slice(0, colon).replace(/[ \t]+$/, '');
  return { name, key: asciiLower(name), raw };
}

/**
 * Select fields for an h= list (RFC 6376 §5.4.2): each occurrence of a name takes the next instance
 * from the BOTTOM of the header block upward. A name with no instance left selects nothing — which
 * is what makes listing a name more times than it appears ("oversigning") block added instances.
 */
export function selectHeaders(fields: readonly HeaderField[], names: readonly string[]): HeaderField[] {
  const used = new Map<string, number>(); // key -> how many instances consumed from the bottom
  const selected: HeaderField[] = [];
  for (const n of names) {
    const key = asciiLower(n.trim());
    const skip = used.get(key) ?? 0;
    let seen = 0;
    for (let i = fields.length - 1; i >= 0; i--) {
      const f = fields[i];
      if (f?.key !== key) continue;
      if (seen === skip) {
        selected.push(f);
        break;
      }
      seen++;
    }
    used.set(key, skip + 1);
  }
  return selected;
}
