// Adversarial class 7 — blob path traversal (PST-REQ-087; PST-REQ-012 blobs are named by their
// SHA-256 and live under one root).
//
// Expected safe behaviour:
//   - Every blob-store entry point (get, getBuffer, stat, release, reap, verify, blobPath, blobDir)
//     refuses a name that is not exactly 64 lowercase hex characters — "../", absolute paths,
//     wrong length, uppercase, embedded NUL / slash / whitespace, look-alike digits, non-strings —
//     with InvalidBlobNameError, before the filesystem or the database is touched, and the error
//     never echoes the hostile name.
//   - The store's root must be absolute.
//   - A symlink planted inside the tree never lets the store read, write or delete outside the
//     root: a shard directory pointing elsewhere refuses put(); a blob file (or shard) pointing
//     elsewhere is never read by get() and never unlinked through by reap() or gc().
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobDir, blobPath, createBlobStore, InvalidBlobNameError, isBlobName, type BlobStore } from '@postroom/blobstore';
import { DATABASE_URL, World } from './support/world.js';

const HEX = 'a'.repeat(64);

const HOSTILE: readonly unknown[] = [
  '../etc/passwd',
  '../../../../../../etc/passwd',
  '/etc/passwd',
  `../${'a'.repeat(61)}`,
  `${'a'.repeat(62)}/.`,
  `${'a'.repeat(60)}/../`,
  `/${'a'.repeat(63)}`,
  `..\\${'a'.repeat(61)}`,
  `${'a'.repeat(62)}%2f`,
  'A'.repeat(64),
  `${'a'.repeat(63)}A`,
  'a'.repeat(63),
  'a'.repeat(65),
  `${'a'.repeat(63)}g`,
  `${HEX}\u0000`,
  `${'a'.repeat(63)}\u0000`,
  ` ${'a'.repeat(63)}`,
  `${'a'.repeat(63)}\n`,
  `${'a'.repeat(64)}\n`,
  '٠'.repeat(64), // Arabic-Indic digit zero
  'ａ'.repeat(64), // fullwidth a
  '',
  '.',
  '..',
  null,
  undefined,
  64,
  ['a'.repeat(64)],
  { toString: () => HEX },
  new String(HEX),
];

describe.skipIf(DATABASE_URL === undefined)('adversarial: blob path traversal (PST-REQ-087 / PST-REQ-012)', () => {
  let w: World;
  let blobs: BlobStore;
  let outside = '';
  let root = '';

  beforeAll(async () => {
    w = await World.create('pst_adv_blob');
    outside = await mkdtemp(join(tmpdir(), 'pst-adv-outside-'));
    root = await mkdtemp(join(tmpdir(), 'pst-adv-root-'));
    blobs = createBlobStore({ root, db: w.db, kek: w.kek, logger: { warn: () => undefined } });
  }, 120_000);

  afterAll(async () => {
    await rm(outside, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await w.close();
  });

  it('every entry point refuses a hostile name with InvalidBlobNameError, without echoing it', async () => {
    const queriesBefore = await w.db.blob.count();
    for (const name of HOSTILE) {
      const label = JSON.stringify(String(name));
      expect(isBlobName(name), label).toBe(false);
      expect(() => blobPath(root, name as string), label).toThrow(InvalidBlobNameError);
      expect(() => blobDir(root, name as string), label).toThrow(InvalidBlobNameError);
      const calls: (() => Promise<unknown>)[] = [
        () => blobs.get(name as string),
        () => blobs.getBuffer(name as string),
        () => blobs.stat(name as string),
        () => blobs.release(name as string),
        () => blobs.reap(name as string),
        () => blobs.verify(name as string),
      ];
      for (const call of calls) {
        const err = await Promise.resolve()
          .then(call)
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(err, label).toBeInstanceOf(InvalidBlobNameError);
        expect((err as Error).message).not.toContain('passwd');
        expect((err as Error).message).not.toContain('..');
      }
    }
    // Nothing was created, looked up into existence, or written.
    expect(await w.db.blob.count()).toBe(queriesBefore);
    expect(await readdir(outside)).toEqual([]);
  });

  it('a relative root is refused', () => {
    expect(() => createBlobStore({ root: 'blobs', db: w.db, kek: w.kek })).toThrow(TypeError);
    expect(() => createBlobStore({ root: '../blobs', db: w.db, kek: w.kek })).toThrow(TypeError);
  });

  it('a shard directory symlinked outside the root: put() refuses to place the file there', async () => {
    const content = Buffer.from('symlinked shard\r\n');
    const sha = createHash('sha256').update(content).digest('hex');
    // Plant <root>/<aa> → outside, so <root>/<aa>/<bb>/<sha> would land outside the tree.
    await symlink(outside, join(root, sha.slice(0, 2)), 'dir');
    await expect(blobs.put(content)).rejects.toThrow();
    expect(existsSync(join(outside, sha.slice(2, 4), sha))).toBe(false);
    expect(await w.db.blob.findUnique({ where: { sha256: sha } })).toBeNull();
    await unlink(join(root, sha.slice(0, 2)));
    await rm(join(outside, sha.slice(2, 4)), { recursive: true, force: true });
  });

  it('a blob file replaced by a symlink to a file outside the root is never read', async () => {
    const put = await blobs.put(Buffer.from('the real blob\r\n'));
    const path = blobPath(root, put.sha256);
    // The attacker keeps the real ciphertext (so decryption alone would not catch it) outside the
    // root, and points the blob's name at it.
    const moved = join(outside, 'moved-ciphertext');
    await writeFile(moved, await readFile(path));
    await unlink(path);
    await symlink(moved, path);
    await expect(blobs.getBuffer(put.sha256)).rejects.toThrow();
    expect(await blobs.verify(put.sha256)).toBe(false);
    await unlink(path);
    await unlink(moved);
  });

  it('a shard directory symlinked outside the root is never read, reaped or collected through', async () => {
    const content = Buffer.from('shard escape on read\r\n');
    const put = await blobs.put(content);
    const shard = join(root, put.sha256.slice(0, 2));
    // Move the whole shard outside and leave a symlink in its place.
    const away = join(outside, 'shard');
    await mkdir(away, { recursive: true });
    const file = blobPath(root, put.sha256);
    const target = join(away, put.sha256.slice(2, 4));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, put.sha256), await readFile(file));
    await rm(shard, { recursive: true, force: true });
    await symlink(away, shard, 'dir');

    await expect(blobs.getBuffer(put.sha256)).rejects.toThrow();

    // An orphan-looking file outside, reachable through the link: neither reap nor gc may delete it.
    const decoyName = `${put.sha256.slice(0, 2)}${put.sha256.slice(2, 4)}${'c'.repeat(60)}`;
    await writeFile(join(target, decoyName), 'outside file');
    await blobs.reap(decoyName).catch(() => false);
    await blobs.gc({ olderThanMs: -60_000 });
    expect(existsSync(join(target, decoyName))).toBe(true);
    await unlink(shard);
  });
});
