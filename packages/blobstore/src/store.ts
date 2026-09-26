// The blob store: encrypted, content-addressed, refcounted, durable before it answers.
//
// PST-REQ-010  every blob is encrypted under its own random DEK; the DEK is wrapped by the KEK and
//              only the wrapped DEK reaches the database. No plaintext ever touches disk.
// PST-REQ-012  a blob is named by the SHA-256 of its plaintext and never modified; storing the same
//              message twice yields one file and refcount 2.
// PST-REQ-060  put() returns only after the file and its directory are fsynced and the row is
//              committed (or, when the caller passes a transaction, is written inside it).
// PST-REQ-050  everything streams: a 100 MB message is never held in memory.
// PST-ADR-009  deletion is crypto-shred: the row holding the wrapped DEK is deleted first, then
//              the file is unlinked. A file whose row is gone is unreadable ciphertext.
//
// AAD choice. The name (plaintext SHA-256) is only known once the whole message has streamed
// through, but the encryptor needs its AAD up front. So the ciphertext stream is sealed with the
// constant AAD `postroom-blob-v1`, and the binding to the name lives on the DEK instead: the DEK is
// wrapped with AAD = the blob's sha256. A DEK is random, single-use and belongs to exactly one
// blob, so a wrapped DEK moved onto another row fails to unwrap, and a file moved under another
// name fails to decrypt under that name's DEK. verify() closes the loop by re-hashing the plaintext.
//
// Concurrency. Every mutation of one blob (placing its file, inserting/incrementing/decrementing its
// row, unlinking its file, gc) runs inside a transaction holding a transaction-scoped advisory lock
// keyed on the name. So two concurrent puts of the same content serialise: the first places its
// file and inserts the row; the second sees the row, increments, and discards its own temp file.
// Nobody ever renames over a file that a committed row points at, because the lock holder only
// places a file after seeing that no row exists.

import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { pipeline as pipelineCb, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createDecryptStream,
  createEncryptStream,
  DecryptError,
  generateDek,
  STREAM_HEADER_BYTES,
  unwrapDek,
  wrapDek,
  type Kek,
} from '@postroom/crypto';
import type { Db, Prisma } from '@postroom/db';
import { BlobNotFoundError, BlobStoreError } from './errors.js';
import { assertBlobName, assertRoot, blobDir, blobPath, isBlobName, tmpDir } from './paths.js';

/** Recorded in `blob.aead`: the stream format of @postroom/crypto (format byte 0x21). */
export const BLOB_AEAD = 'aes-256-gcm-stream-v1';
/** AAD of every blob's ciphertext stream. The name is bound through the wrapped DEK (see above). */
export const BLOB_STREAM_AAD = 'postroom-blob-v1';
/** gc() leaves files younger than this alone, so it never races an in-flight put. */
export const DEFAULT_GC_AGE_MS = 60 * 60 * 1000;

const TX_OPTIONS = { maxWait: 30_000, timeout: 120_000 } as const;

export type TxClient = Prisma.TransactionClient;
export type BlobSource = Readable | AsyncIterable<Uint8Array> | Uint8Array;

export interface BlobLogger {
  warn: (message: string, fields?: Record<string, unknown>) => void;
}

export interface BlobStoreOptions {
  /** Absolute directory holding the tree. Must be on one filesystem (rename is atomic). */
  root: string;
  db: Db;
  /** Wraps every DEK. Never written to the database or a log. */
  kek: Kek;
  logger?: BlobLogger;
}

export interface PutOptions {
  /**
   * Write the row inside the caller's transaction (e.g. the SMTP spool committing the blob and its
   * message rows together). When given, the file and its directory are already fsynced when put()
   * returns, but the row is only durable when the CALLER commits; the caller owns the commit and
   * must not answer 250 before it. The advisory lock on the name is held until that commit, so keep
   * the transaction short, and put blobs in a consistent order if one transaction stores several.
   * A rolled-back transaction leaves an orphan file that gc() removes.
   */
  tx?: TxClient;
}

export interface PutResult {
  sha256: string;
  /** Plaintext size in bytes. */
  size: number;
  /** True when this call placed the file and inserted the row; false when it incremented. */
  created: boolean;
}

export interface BlobStat {
  sha256: string;
  size: number;
  refcount: number;
  kekId: string;
  aead: string;
  createdAt: Date;
}

export interface ReleaseResult {
  /** Refcount after the release; 0 means the row (and with it the DEK) is gone. */
  refcount: number;
  /**
   * True when the file was unlinked too. Always false when a `tx` was passed: the file must not go
   * before the row's deletion is committed, so the caller calls reap(sha256) after committing (or
   * leaves it to gc()).
   */
  removed: boolean;
}

export interface GcOptions {
  /** Only files older than this are candidates. Default one hour. */
  olderThanMs?: number;
  /** Clock, for tests. */
  now?: number;
}

export interface GcResult {
  /** Blob files with no row, removed. */
  orphans: number;
  /** Abandoned temp files, removed. */
  temps: number;
}

export interface BlobStore {
  readonly root: string;
  put: (source: BlobSource, opts?: PutOptions) => Promise<PutResult>;
  /** A stream of the verified plaintext. Errors (DecryptError, ENOENT) surface on the stream. */
  get: (sha256: string) => Promise<Readable>;
  /** get() collected into memory. For small blobs only. */
  getBuffer: (sha256: string) => Promise<Buffer>;
  stat: (sha256: string) => Promise<BlobStat | null>;
  release: (sha256: string, tx?: TxClient) => Promise<ReleaseResult>;
  /** Unlink the file of a blob that has no row. Returns true when the blob is now absent on disk. */
  reap: (sha256: string) => Promise<boolean>;
  /** Full decrypt and re-hash: true only when the plaintext hashes to its name. */
  verify: (sha256: string) => Promise<boolean>;
  gc: (opts?: GcOptions) => Promise<GcResult>;
}

const consoleLogger: BlobLogger = {
  warn: (message, fields) => {
    console.warn(`[blobstore] ${message}`, fields ?? {});
  },
};

function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function toReadable(source: BlobSource): Readable {
  if (source instanceof Readable) return source;
  if (source instanceof Uint8Array) return Readable.from([source]);
  return Readable.from(source);
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  throw new TypeError('blob sources must yield bytes (Buffer or Uint8Array), not strings');
}

/** A file's bytes, refusing to follow a symlink at the final component (ELOOP). */
async function* readNoFollow(path: string): AsyncGenerator<Buffer> {
  const fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    for await (const chunk of fh.createReadStream({ autoClose: false })) yield chunk as Buffer;
  } finally {
    await fh.close();
  }
}

async function fsyncPath(path: string, flags = 'r'): Promise<void> {
  const fh = await open(path, flags);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Serialise every mutation of one blob across processes. Held until the transaction ends. */
async function lockBlob(tx: TxClient, sha256: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'postroom-blob:' + sha256}, 0))`;
}

async function tryLockBlob(tx: TxClient, sha256: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${'postroom-blob:' + sha256}, 0)) AS ok`;
  return rows[0]?.ok === true;
}

export function createBlobStore(options: BlobStoreOptions): BlobStore {
  const { root, db, kek } = options;
  assertRoot(root);
  const log = options.logger ?? consoleLogger;
  const tmpRoot = tmpDir(root);
  let tmpReady: Promise<unknown> | undefined;

  const ensureTmp = (): Promise<unknown> => {
    tmpReady ??= mkdir(tmpRoot, { recursive: true, mode: 0o700 }).then(async (made) => {
      if (made !== undefined) {
        await fsyncPath(root);
      }
    });
    return tmpReady;
  };

  /** Rename a fully-written, fsynced temp file to its name and make the rename durable. */
  const placeFile = async (tmp: string, sha256: string): Promise<void> => {
    const dir = blobDir(root, sha256);
    const made = await mkdir(dir, { recursive: true, mode: 0o700 });
    await assertInsideRoot(dir);
    await rename(tmp, join(dir, sha256));
    await fsyncPath(dir);
    if (made !== undefined) {
      // New shard directories: their own entries must be durable in their parents too.
      await fsyncPath(dirname(dir));
      await fsyncPath(root);
    }
  };

  // Symlink escape (PST-T-4.1): a name is validated before it becomes a path, but a symlink planted
  // in the tree (a shard directory, or a blob file) could still point the store outside its root.
  // Every read, write and unlink first resolves the shard directory and checks it is under the real
  // root, and the blob file itself is opened without following a final symlink.
  let realRoot: Promise<string> | undefined;
  const insideRoot = async (dir: string): Promise<boolean> => {
    realRoot ??= realpath(root);
    let real: string;
    try {
      real = await realpath(dir);
    } catch (err) {
      // Nothing there, so nothing to escape through; the caller's own ENOENT handling applies.
      if (errnoCode(err) === 'ENOENT') return true;
      throw err;
    }
    const base = await realRoot;
    return real === base || real.startsWith(base + sep);
  };
  const assertInsideRoot = async (dir: string): Promise<void> => {
    if (!(await insideRoot(dir))) throw new BlobStoreError('blob path escapes the store root');
  };

  const put = async (source: BlobSource, opts: PutOptions = {}): Promise<PutResult> => {
    await ensureTmp();
    const tmp = join(tmpRoot, `${randomBytes(16).toString('hex')}.tmp`);
    const dek = generateDek();
    const hash = createHash('sha256');
    let size = 0;
    let header = Buffer.alloc(0);
    try {
      // One pass: plaintext is hashed as it streams into the encryptor; only ciphertext is written.
      await pipeline(
        toReadable(source),
        async function* hashPlaintext(chunks: AsyncIterable<unknown>) {
          for await (const chunk of chunks) {
            const buf = toBuffer(chunk);
            hash.update(buf);
            size += buf.length;
            yield buf;
          }
        },
        createEncryptStream(dek, BLOB_STREAM_AAD),
        async function* captureHeader(chunks: AsyncIterable<unknown>) {
          for await (const chunk of chunks) {
            const buf = toBuffer(chunk);
            if (header.length < STREAM_HEADER_BYTES) {
              header = Buffer.concat([header, buf.subarray(0, STREAM_HEADER_BYTES - header.length)]);
            }
            yield buf;
          }
        },
        createWriteStream(tmp, { flags: 'wx', mode: 0o600 }),
      );
      // Durable before it can be named: fsync the ciphertext, then rename, then fsync the dir.
      await fsyncPath(tmp, 'r+');
      const sha256 = hash.digest('hex');
      const wrappedDek = wrapDek(kek, dek, sha256);

      const commit = async (tx: TxClient): Promise<boolean> => {
        await lockBlob(tx, sha256);
        const existing = await tx.blob.findUnique({ where: { sha256 }, select: { sha256: true } });
        if (existing !== null) {
          await tx.blob.update({ where: { sha256 }, data: { refcount: { increment: 1 } } });
          return false;
        }
        // No row while we hold the lock: any file already at this name is an orphan (a crash
        // between rename and commit, or a rolled-back caller), so replacing it is safe.
        await placeFile(tmp, sha256);
        await tx.blob.create({
          data: {
            sha256,
            size,
            wrappedDek: new Uint8Array(wrappedDek),
            kekId: kek.id,
            aead: BLOB_AEAD,
            nonce: new Uint8Array(header),
            refcount: 1,
          },
        });
        return true;
      };

      const created = opts.tx === undefined ? await db.$transaction(commit, TX_OPTIONS) : await commit(opts.tx);
      return { sha256, size, created };
    } finally {
      dek.fill(0);
      // Gone already when the file was placed; otherwise it was a duplicate or a failed write.
      await rm(tmp, { force: true });
    }
  };

  const loadRow = async (sha256: string) => {
    assertBlobName(sha256);
    const row = await db.blob.findUnique({ where: { sha256 } });
    if (row === null) throw new BlobNotFoundError(sha256);
    return row;
  };

  const get = async (sha256: string): Promise<Readable> => {
    const row = await loadRow(sha256);
    if (row.kekId !== kek.id) throw new DecryptError('blob is wrapped under a different KEK');
    const dek = unwrapDek(kek, row.wrappedDek, sha256);
    await assertInsideRoot(blobDir(root, sha256));
    const decrypt = createDecryptStream(dek, BLOB_STREAM_AAD);
    dek.fill(0);
    // pipeline() destroys `decrypt` with the error of either side, so a missing file, a symlinked
    // file (O_NOFOLLOW: ELOOP) or a failed tag reaches whoever reads the returned stream.
    pipelineCb(Readable.from(readNoFollow(blobPath(root, sha256))), decrypt, (_err) => undefined);
    return decrypt;
  };

  const getBuffer = async (sha256: string): Promise<Buffer> => {
    const stream = await get(sha256);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(toBuffer(chunk));
    return Buffer.concat(chunks);
  };

  const stat = async (sha256: string): Promise<BlobStat | null> => {
    assertBlobName(sha256);
    const row = await db.blob.findUnique({
      where: { sha256 },
      select: { sha256: true, size: true, refcount: true, kekId: true, aead: true, createdAt: true },
    });
    return row;
  };

  const reap = async (sha256: string): Promise<boolean> => {
    assertBlobName(sha256);
    const dir = blobDir(root, sha256);
    await assertInsideRoot(dir);
    return db.$transaction(async (tx) => {
      await lockBlob(tx, sha256);
      const row = await tx.blob.findUnique({ where: { sha256 }, select: { sha256: true } });
      if (row !== null) return false;
      try {
        await unlink(join(dir, sha256));
      } catch (err) {
        if (errnoCode(err) !== 'ENOENT') throw err;
        log.warn('blob file already absent at unlink', { sha256 });
        return true;
      }
      await fsyncPath(dir);
      return true;
    }, TX_OPTIONS);
  };

  const release = async (sha256: string, tx?: TxClient): Promise<ReleaseResult> => {
    assertBlobName(sha256);
    const decrement = async (t: TxClient): Promise<number> => {
      await lockBlob(t, sha256);
      const row = await t.blob.findUnique({ where: { sha256 }, select: { refcount: true } });
      if (row === null) throw new BlobNotFoundError(sha256);
      if (row.refcount <= 1) {
        // Crypto-shred: the wrapped DEK goes with the row, before the file is touched.
        await t.blob.delete({ where: { sha256 } });
        return 0;
      }
      const updated = await t.blob.update({
        where: { sha256 },
        data: { refcount: { decrement: 1 } },
        select: { refcount: true },
      });
      return updated.refcount;
    };
    if (tx !== undefined) return { refcount: await decrement(tx), removed: false };
    const refcount = await db.$transaction(decrement, TX_OPTIONS);
    if (refcount > 0) return { refcount, removed: false };
    return { refcount, removed: await reap(sha256) };
  };

  const verify = async (sha256: string): Promise<boolean> => {
    assertBlobName(sha256);
    try {
      const row = await loadRow(sha256);
      const stream = await get(sha256);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of stream) {
        const buf = toBuffer(chunk);
        hash.update(buf);
        size += buf.length;
      }
      return size === row.size && hash.digest('hex') === sha256;
    } catch (err) {
      // A symlinked file (ELOOP) or a shard that escapes the root (BlobStoreError) is not this blob.
      if (err instanceof DecryptError || err instanceof BlobStoreError || errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ELOOP') {
        return false;
      }
      throw err;
    }
  };

  const olderThan = async (path: string, cutoff: number): Promise<boolean> => {
    try {
      const s = await lstat(path);
      return s.isFile() && s.mtimeMs < cutoff;
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return false;
      throw err;
    }
  };

  const listDir = async (path: string): Promise<string[]> => {
    try {
      return await readdir(path);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') return [];
      throw err;
    }
  };

  const gc = async (opts: GcOptions = {}): Promise<GcResult> => {
    const cutoff = (opts.now ?? Date.now()) - (opts.olderThanMs ?? DEFAULT_GC_AGE_MS);
    const result: GcResult = { orphans: 0, temps: 0 };
    const shard = /^[0-9a-f]{2}$/;

    for (const name of await listDir(tmpRoot)) {
      const path = join(tmpRoot, name);
      if (await olderThan(path, cutoff)) {
        await rm(path, { force: true });
        result.temps += 1;
      }
    }

    for (const a of await listDir(root)) {
      if (!shard.test(a)) continue;
      for (const b of await listDir(join(root, a))) {
        if (!shard.test(b)) continue;
        const dir = join(root, a, b);
        // Never follow a planted symlink out of the tree.
        if (!(await insideRoot(dir))) continue;
        let removedHere = false;
        for (const name of await listDir(dir)) {
          if (!isBlobName(name) || !name.startsWith(a + b)) continue;
          if (!(await olderThan(join(dir, name), cutoff))) continue;
          const removed = await db.$transaction(async (tx) => {
            // A put or release holding this name right now: skip, the next gc will see it settled.
            if (!(await tryLockBlob(tx, name))) return false;
            const row = await tx.blob.findUnique({ where: { sha256: name }, select: { sha256: true } });
            if (row !== null) return false;
            await rm(join(dir, name), { force: true });
            return true;
          }, TX_OPTIONS);
          if (removed) {
            result.orphans += 1;
            removedHere = true;
          }
        }
        if (removedHere) await fsyncPath(dir);
      }
    }
    return result;
  };

  return { root, put, get, getBuffer, stat, release, reap, verify, gc };
}
