// An encrypted scratch copy of one submitted message, read back twice.
//
// Why a spool at all: the DKIM-Signature headers go at the top of the stored message, but they can
// only be computed once the whole body has been hashed, and a 100 MB message is never held in
// memory (PST-REQ-050). So the message streams through three times:
//
//   1. the (header-fixed) submission streams from the socket into this spool;
//   2. the signer reads the spool once (body hash + header hash) and returns the signatures;
//   3. signatures + the spool stream into the blob store as the final, content-addressed blob,
//      inside the transaction that queues it.
//
// The spool is not a blob: it has no row, is never named by content, and its key is a random DEK
// that exists only in this process's memory — plaintext never touches disk (PST-REQ-010), and a
// spool left behind by a crash is unreadable ciphertext. It lives in the blob store's own temp
// directory, so `BlobStore.gc()` removes any a crash abandoned, and it is deleted as soon as the
// message is accepted or refused.
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline as pipelineCb, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDecryptStream, createEncryptStream, generateDek } from '@postroom/crypto';

const SPOOL_AAD = 'postroom-submission-spool-v1';

export class Spool {
  private disposed = false;
  private written = false;
  private bytes = 0;

  private constructor(
    private readonly path: string,
    private readonly dek: Buffer,
  ) {}

  /** A new, empty spool file in `dir` (created 0700 if missing). */
  static async create(dir: string): Promise<Spool> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return new Spool(join(dir, `${randomBytes(16).toString('hex')}.spool.tmp`), generateDek());
  }

  get size(): number {
    return this.bytes;
  }

  /** Encrypt `source` into the spool. Once only. */
  async write(source: AsyncIterable<Uint8Array>): Promise<void> {
    if (this.written || this.disposed) throw new Error('spool already written');
    this.written = true;
    const counter = { bytes: 0 };
    await pipeline(
      Readable.from(source),
      async function* count(chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          counter.bytes += chunk.length;
          yield chunk;
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
