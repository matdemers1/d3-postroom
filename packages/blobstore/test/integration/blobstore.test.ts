import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat as fsStat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DecryptError,
  generateKek,
  SEGMENT_BYTES,
  STREAM_HEADER_BYTES,
  WRAPPED_DEK_BYTES,
  type Kek,
} from '@postroom/crypto';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BLOB_AEAD,
  blobPath,
  createBlobStore,
  InvalidBlobNameError,
  type BlobStore,
} from '../../src/index.js';

// Proves PST-T-0.7's doneWhen against a real PostgreSQL 16 and a real directory: the same message
// stored twice is one file with refcount 2, and the file on disk is ciphertext.

const baseUrl = process.env['DATABASE_URL'];

function sha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
  }
  return out;
}

async function blobFiles(root: string): Promise<string[]> {
  return (await filesUnder(root)).filter((p) => !p.startsWith(join(root, 'tmp')));
}

const message = Buffer.from(
  'From: alice@d3cloud.io\r\nTo: bob@d3cloud.io\r\nSubject: the plaintext marker\r\n\r\n' +
    'THE-QUICK-PLAINTEXT-MARKER-THAT-MUST-NOT-APPEAR-ON-DISK\r\n'.repeat(50),
);

describe.skipIf(!baseUrl)('blob store', () => {
  let tdb: TestDatabase;
  let kek: Kek;
  let root = '';
  let store: BlobStore;
  const warnings: string[] = [];

  beforeAll(async () => {
    tdb = await createTestDatabase(baseUrl ?? '', 'pst_t07');
    kek = generateKek();
  }, 120_000);

  afterAll(async () => {
    await tdb.drop();
  });

  beforeEach(async () => {
    await tdb.db.blob.deleteMany({});
    if (root !== '') await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), 'pst-blobs-'));
    warnings.length = 0;
    store = createBlobStore({ root, db: tdb.db, kek, logger: { warn: (m) => warnings.push(m) } });
  });

  it('stores the same message twice as ONE file with refcount 2, and the file is ciphertext', async () => {
    const first = await store.put(message);
    const second = await store.put(Readable.from([message.subarray(0, 100), message.subarray(100)]));

    expect(first).toEqual({ sha256: sha(message), size: message.length, created: true });
    expect(second).toEqual({ sha256: sha(message), size: message.length, created: false });

    const files = await blobFiles(root);
    expect(files).toEqual([blobPath(root, first.sha256)]);
    expect(await readdir(join(root, 'tmp'))).toEqual([]);

    const row = await tdb.db.blob.findUniqueOrThrow({ where: { sha256: first.sha256 } });
    expect(row.refcount).toBe(2);
    expect(row.size).toBe(message.length);
    expect(row.kekId).toBe(kek.id);
    expect(row.aead).toBe(BLOB_AEAD);

    // PST-REQ-010: the DB holds only a wrapped DEK, never the KEK.
    expect(row.wrappedDek.length).toBe(WRAPPED_DEK_BYTES);

    const onDisk = await readFile(files[0] ?? '');
    expect(onDisk.equals(message)).toBe(false);
    expect(onDisk.includes(Buffer.from('PLAINTEXT-MARKER'))).toBe(false);
    expect(onDisk.includes(Buffer.from('alice@d3cloud.io'))).toBe(false);
    expect(onDisk.length).toBeGreaterThan(message.length);

    expect((await store.getBuffer(first.sha256)).equals(message)).toBe(true);
    expect(await store.verify(first.sha256)).toBe(true);
    expect(await store.stat(first.sha256)).toMatchObject({ refcount: 2, size: message.length });
  });

  it('release twice: the row goes first, then the file', async () => {
    const { sha256 } = await store.put(message);
    await store.put(message);

    expect(await store.release(sha256)).toEqual({ refcount: 1, removed: false });
    expect(await blobFiles(root)).toHaveLength(1);

    expect(await store.release(sha256)).toEqual({ refcount: 0, removed: true });
    expect(await tdb.db.blob.findUnique({ where: { sha256 } })).toBeNull();
    expect(await blobFiles(root)).toEqual([]);
    expect(await store.stat(sha256)).toBeNull();
    await expect(store.release(sha256)).rejects.toThrow(/not found/);
  });

  it('a missing file at unlink is logged, not fatal', async () => {
    const { sha256 } = await store.put(message);
    await rm(blobPath(root, sha256));
    expect(await store.release(sha256)).toEqual({ refcount: 0, removed: true });
    expect(warnings).toEqual(['blob file already absent at unlink']);
  });

  it('a flipped byte in the file makes get() fail with DecryptError', async () => {
    const { sha256 } = await store.put(message);
    const path = blobPath(root, sha256);
    const bytes = await readFile(path);
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    await writeFile(path, bytes);

    await expect(store.getBuffer(sha256)).rejects.toBeInstanceOf(DecryptError);
    expect(await store.verify(sha256)).toBe(false);
  });

  it('a truncated file makes get() fail with DecryptError', async () => {
    const { sha256 } = await store.put(message);
    const path = blobPath(root, sha256);
    const bytes = await readFile(path);
    await writeFile(path, bytes.subarray(0, bytes.length - 1));
    await expect(store.getBuffer(sha256)).rejects.toBeInstanceOf(DecryptError);
  });

  it('ten concurrent puts of identical content: one file, refcount 10', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => store.put(Buffer.from(message))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const files = await blobFiles(root);
    expect(files).toHaveLength(1);
    const row = await tdb.db.blob.findUniqueOrThrow({ where: { sha256: sha(message) } });
    expect(row.refcount).toBe(10);
    expect(await readdir(join(root, 'tmp'))).toEqual([]);
    // The surviving file decrypts under the surviving row's DEK.
    expect((await store.getBuffer(row.sha256)).equals(message)).toBe(true);
  });

  it('streams a ~30 MB message: the source never runs far ahead of what has reached disk', async () => {
    const total = 30 * 1024 * 1024;
    const chunk = 64 * 1024;
    const seed = randomBytes(chunk);
    const hash = createHash('sha256');
    const tmp = join(root, 'tmp');
    const sealedSegment = SEGMENT_BYTES + 16; // plaintext + GCM tag

    // Plaintext bytes that have reached the temp file: strip the stream header and one tag per
    // full sealed segment. OS-independent, unlike heap samples: a put that buffered the message
    // would let the source run the whole 30 MB ahead of the file.
    const plaintextOnDisk = async (): Promise<number> => {
      const names = await readdir(tmp);
      if (names.length === 0) return 0;
      expect(names).toHaveLength(1);
      let size: number;
      try {
        size = (await fsStat(join(tmp, names[0] ?? ''))).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
      }
      const body = Math.max(0, size - STREAM_HEADER_BYTES);
      return body - 16 * Math.floor(body / sealedSegment);
    };

    let produced = 0;
    let peakInFlight = 0;
    async function* source(): AsyncGenerator<Buffer> {
      for (let sent = 0; sent < total; sent += chunk) {
        const piece = Buffer.from(seed);
        piece.writeUInt32BE(sent, 0);
        hash.update(piece);
        peakInFlight = Math.max(peakInFlight, produced - (await plaintextOnDisk()));
        produced += piece.length;
        yield piece;
      }
    }

    // Diagnostic only: heap + arrayBuffers varies too much across OSes to assert on.
    const baseline = process.memoryUsage();
    const result = await store.put(source());
    const after = process.memoryUsage();
    const mb = (n: number): string => (n / 1048576).toFixed(1);
    console.info(
      `30 MB put: peak in flight ${mb(peakInFlight)} MB; heap+arrayBuffers delta ` +
        `${mb(after.heapUsed + after.arrayBuffers - baseline.heapUsed - baseline.arrayBuffers)} MB`,
    );

    expect(result.size).toBe(total);
    expect(result.sha256).toBe(hash.digest('hex'));
    expect(peakInFlight).toBeLessThan(4 * 1024 * 1024);

    // And reads back as a stream, verified end to end.
    expect(await store.verify(result.sha256)).toBe(true);
    const size = (await fsStat(blobPath(root, result.sha256))).size;
    expect(size).toBeGreaterThan(total);
  }, 120_000);

  it('a store with the wrong KEK cannot read the blob', async () => {
    const { sha256 } = await store.put(message);
    const other = createBlobStore({ root, db: tdb.db, kek: generateKek() });
    await expect(other.get(sha256)).rejects.toBeInstanceOf(DecryptError);
    expect(await other.verify(sha256)).toBe(false);
  });

  it('a traversal name is rejected before the filesystem or database is touched', async () => {
    for (const bad of ['../etc', '../../../../etc/passwd', 'A'.repeat(64)]) {
      await expect(store.get(bad)).rejects.toBeInstanceOf(InvalidBlobNameError);
      await expect(store.release(bad)).rejects.toBeInstanceOf(InvalidBlobNameError);
      await expect(store.verify(bad)).rejects.toBeInstanceOf(InvalidBlobNameError);
      await expect(store.stat(bad)).rejects.toBeInstanceOf(InvalidBlobNameError);
    }
    expect(() => createBlobStore({ root: 'relative/dir', db: tdb.db, kek })).toThrow(TypeError);
  });

  it('a put inside a rolled-back caller transaction leaves an orphan that gc removes', async () => {
    const marker = new Error('rollback');
    let placed = '';
    await expect(
      tdb.db.$transaction(async (tx) => {
        const r = await store.put(message, { tx });
        placed = r.sha256;
        // The file is already durable while the row is still the caller's to commit.
        expect(await blobFiles(root)).toEqual([blobPath(root, r.sha256)]);
        throw marker;
      }),
    ).rejects.toBe(marker);
    expect(await tdb.db.blob.findUnique({ where: { sha256: placed } })).toBeNull();

    // Too young: left alone, so gc never races a put.
    expect(await store.gc()).toEqual({ orphans: 0, temps: 0 });
    expect(await blobFiles(root)).toHaveLength(1);

    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(blobPath(root, placed), old, old);
    expect(await store.gc()).toEqual({ orphans: 1, temps: 0 });
    expect(await blobFiles(root)).toEqual([]);
  });

  it('a put committed with the caller transaction is visible after commit', async () => {
    const r = await tdb.db.$transaction(async (tx) => store.put(message, { tx }));
    expect(r.created).toBe(true);
    expect((await tdb.db.blob.findUniqueOrThrow({ where: { sha256: r.sha256 } })).refcount).toBe(1);
    const released = await tdb.db.$transaction(async (tx) => store.release(r.sha256, tx));
    expect(released).toEqual({ refcount: 0, removed: false });
    expect(await store.reap(r.sha256)).toBe(true);
    expect(await blobFiles(root)).toEqual([]);
  });

  it('crypto-shred (PST-REQ-130): the last release destroys the wrapped DEK in the caller transaction; a file left by a crash is unreadable and gc removes it', async () => {
    const { sha256 } = await store.put(message);
    const released = await tdb.db.$transaction(async (tx) => {
      const r = await store.release(sha256, tx);
      // Inside the transaction the row, and with it the only copy of the wrapped DEK, is gone.
      expect(await tx.blob.findUnique({ where: { sha256 } })).toBeNull();
      return r;
    });
    expect(released).toEqual({ refcount: 0, removed: false });
    // "Crash" here: the commit happened, reap() never ran. The ciphertext is still on disk...
    expect(await blobFiles(root)).toEqual([blobPath(root, sha256)]);
    // ...and nothing can read it: there is no DEK to unwrap, even with the right KEK.
    await expect(store.getBuffer(sha256)).rejects.toThrow(/not found/);
    expect(await store.verify(sha256)).toBe(false);
    expect(await store.gc({ olderThanMs: 0 })).toEqual({ orphans: 1, temps: 0 });
    expect(await blobFiles(root)).toEqual([]);
  });

  it('gc keeps old files that have rows, and removes stale temp files', async () => {
    const { sha256 } = await store.put(message);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(blobPath(root, sha256), old, old);

    const orphan = 'f'.repeat(64);
    await mkdir(dirname(blobPath(root, orphan)), { recursive: true });
    await writeFile(blobPath(root, orphan), randomBytes(100));
    await utimes(blobPath(root, orphan), old, old);

    const staleTmp = join(root, 'tmp', 'abandoned.tmp');
    await writeFile(staleTmp, randomBytes(10));
    await utimes(staleTmp, old, old);
    const freshTmp = join(root, 'tmp', 'in-flight.tmp');
    await writeFile(freshTmp, randomBytes(10));

    expect(await store.gc()).toEqual({ orphans: 1, temps: 1 });
    expect(await blobFiles(root)).toEqual([blobPath(root, sha256)]);
    expect(await readdir(join(root, 'tmp'))).toEqual(['in-flight.tmp']);
    expect(await store.verify(sha256)).toBe(true);
  });

  it('an empty message is a valid blob', async () => {
    const r = await store.put(Buffer.alloc(0));
    expect(r).toEqual({ sha256: sha(Buffer.alloc(0)), size: 0, created: true });
    expect((await store.getBuffer(r.sha256)).length).toBe(0);
  });

  it('a source that errors mid-stream stores nothing and leaves no temp file', async () => {
    async function* broken(): AsyncGenerator<Buffer> {
      yield Buffer.from('partial');
      await Promise.resolve();
      throw new Error('connection dropped');
    }
    await expect(store.put(broken())).rejects.toThrow('connection dropped');
    expect(await tdb.db.blob.count()).toBe(0);
    expect(await filesUnder(root)).toEqual([]);
  });
});
