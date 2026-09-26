// An encrypted scratch copy of one inbound message, and the header block captured on the way in.
//
// Why a spool: the trace headers we prepend (Received + Authentication-Results, PST-REQ-069) carry
// the DKIM, DMARC and ARC results, which are only known once the whole body has streamed through
// the verifier — and a 100 MB message is never held in memory (PST-REQ-050). So the body streams:
//
//   1. from the socket (through the DKIM verifier) into this spool, capturing the header block;
//   2. ARC reads the spool once, only when the header block carries ARC fields;
//   3. Received + Authentication-Results + the spool stream into the blob store as the final
//      content-addressed blob, inside the transaction that spools it (data.ts). Commit, then 250.
//
// The spool is not a blob: it has no row and its key is a random DEK that exists only in this
// process's memory, so plaintext never touches disk (PST-REQ-010) and a spool a crash left behind
// is unreadable ciphertext. It lives in the blob store's temp directory, where `BlobStore.gc()`
// removes any a crash abandoned, and it is deleted as soon as the message is answered.
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline as pipelineCb, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDecryptStream, createEncryptStream, generateDek } from '@postroom/crypto';

const SPOOL_AAD = 'postroom-inbound-spool-v1';
/** The header block is captured up to this many bytes (the DKIM verifier's own limit). */
export const MAX_HEADER_BYTES = 1024 * 1024;

const SEPARATOR = Buffer.from('\r\n\r\n', 'latin1');

export interface CapturedHeader {
  /** The header block's bytes including the CRLF ending its last field; null when it exceeded the limit. */
  readonly block: Buffer | null;
  /** True when the message had no empty line: the whole message is header. */
  readonly headerOnly: boolean;
}

/** Collects the header block (bounded) from a stream it does not otherwise touch. */
export class HeaderTap {
  private acc: Buffer[] = [];
  private accBytes = 0;
  private done: CapturedHeader | null = null;

  constructor(private readonly maxBytes = MAX_HEADER_BYTES) {}

  push(chunk: Buffer): void {
    if (this.done !== null) return;
    const searchFrom = Math.max(0, this.accBytes - (SEPARATOR.length - 1));
    this.acc.push(chunk);
    this.accBytes += chunk.length;
    const joined = this.acc.length === 1 ? chunk : Buffer.concat(this.acc);
    this.acc = [joined];
    const at = joined.indexOf(SEPARATOR, searchFrom);
    if (at >= 0) {
      this.done = at + 2 > this.maxBytes ? { block: null, headerOnly: false } : { block: Buffer.from(joined.subarray(0, at + 2)), headerOnly: false };
      this.acc = [];
      return;
    }
    if (this.accBytes > this.maxBytes) {
      this.done = { block: null, headerOnly: false };
      this.acc = [];
    }
  }

  /** The result once the stream has ended. */
  finish(): CapturedHeader {
    if (this.done !== null) return this.done;
    const all = Buffer.concat(this.acc);
    this.acc = [];
    this.done = { block: all, headerOnly: true };
    return this.done;
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'latin1');
  throw new TypeError('spool sources must yield bytes');
}

export class InboundSpool {
  private disposed = false;
  private written = false;
  private bytes = 0;

  private constructor(
    private readonly path: string,
    private readonly dek: Buffer,
  ) {}

  /** A new, empty spool file in `dir` (created 0700 if missing). */
  static async create(dir: string): Promise<InboundSpool> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return new InboundSpool(join(dir, `${randomBytes(16).toString('hex')}.inbound.tmp`), generateDek());
  }

  /** Plaintext bytes written. */
  get size(): number {
    return this.bytes;
  }

  /** Encrypt `source` into the spool, feeding every chunk to `tap`. Once only. */
  async write(source: AsyncIterable<unknown>, tap?: HeaderTap): Promise<void> {
    if (this.written || this.disposed) throw new Error('spool already written');
    this.written = true;
    const counter = { bytes: 0 };
    await pipeline(
      Readable.from(source),
      async function* count(chunks: AsyncIterable<unknown>) {
        for await (const chunk of chunks) {
          const buf = toBuffer(chunk);
          counter.bytes += buf.length;
          tap?.push(buf);
          yield buf;
        }
      },
      createEncryptStream(this.dek, SPOOL_AAD),
      createWriteStream(this.path, { flags: 'wx', mode: 0o600 }),
    );
    this.bytes = counter.bytes;
  }

  /** A fresh plaintext stream of the spool; errors (a failed tag, ENOENT) surface on it. */
  open(): Readable {
    if (!this.written || this.disposed) throw new Error('spool not readable');
    const decrypt = createDecryptStream(this.dek, SPOOL_AAD);
    // pipeline() destroys `decrypt` with either side's error, so the reader sees it.
    pipelineCb(createReadStream(this.path), decrypt, (_err) => undefined);
    return decrypt;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.dek.fill(0);
    await rm(this.path, { force: true });
  }
}
