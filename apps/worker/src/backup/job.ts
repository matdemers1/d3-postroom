// The nightly backup (PST-T-0.16; PST-REQ-022, PST-REQ-024, PST-REQ-011).
//
//   1. pg_dump -Fc (client 16) → a local file under BACKUP_DIR/<date>/, hashed as it streams; kept
//      BACKUP_KEEP_LOCAL_DAYS days so the drill has something even before a bucket exists.
//   2. The dump → s3://<bucket>/db/<date>/postroom.dump (signed with its own SHA-256, so S3 checks
//      it), plus postroom.dump.sha256 in sha256sum format.
//   3. Blob sync: every file under BLOB_ROOT not yet in the bucket → blobs/<aa>/<bb>/<sha256>. The
//      files are already ciphertext (PST-REQ-010) and go up as they are; nothing is decrypted.
//   4. The KEK recovery bundle (Argon2id + AES-GCM, @postroom/crypto) → kek/bundle.json, only when
//      the bucket's bundle does not open with today's passphrase to today's KEK. The KEK never
//      leaves the machine any other way.
//   5. db/<date>/manifest.json last: its presence is what marks a backup complete, and the drill
//      only ever picks a dump that has one.
//
// Every PUT is SSE-KMS. The IAM user can put but not delete, and the bucket is versioned, so an
// overwrite (a second run on the same date, a new bundle) keeps the old version for 90 days.
//
// Unconfigured (no bucket) is recorded as ok:false with `skipped` — never as a success.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isBlobName } from '@postroom/blobstore';
import { BundleUnsealError, sealKekBundle, serializeKekBundle, unsealKekBundle, type KdfParams, type Kek } from '@postroom/crypto';
import { schemaRevision, type Db, type Job } from '@postroom/db';
import type { BackupConfig } from './config.js';
import type { PgTools } from './pgtools.js';
import { createS3Client, type S3Client } from './s3.js';
import { recordBackup, type LastBackup } from './state.js';

export const BACKUP_QUEUE = 'backup';
export const DUMP_NAME = 'postroom.dump';
export const MANIFEST_NAME = 'manifest.json';
export const KEK_BUNDLE_KEY = 'kek/bundle.json';

export interface BackupManifest {
  date: string;
  startedAt: string;
  finishedAt: string;
  dumpKey: string;
  dumpBytes: number;
  dumpSha256: string;
  blobsUploaded: number;
  blobsTotal: number;
  schemaRevision: string | null;
  revision: string;
}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface BackupDeps {
  db: Db;
  databaseUrl: string;
  config: BackupConfig;
  pg: PgTools;
  /** Loaded only when a bundle is to be sealed. */
  kek: () => Kek;
  revision: string;
  /** Overrides the client built from config.s3 (tests). */
  s3?: S3Client;
  now?: () => Date;
  log?: Log;
  /** Argon2id cost for the bundle; tests lower it. */
  kdf?: Partial<KdfParams>;
  /** Parallel blob uploads. */
  concurrency?: number;
}

export const dumpKey = (date: string): string => `db/${date}/${DUMP_NAME}`;
export const manifestKey = (date: string): string => `db/${date}/${MANIFEST_NAME}`;
export const blobKey = (sha256: string): string => `blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const SHARD = /^[0-9a-f]{2}$/;

async function dirEntries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Every blob file under the store's root: `<root>/<aa>/<bb>/<sha256>`. Temp files are skipped. */
export async function* walkBlobs(root: string): AsyncGenerator<string> {
  for (const a of (await dirEntries(root)).sort()) {
    if (!SHARD.test(a)) continue;
    for (const b of (await dirEntries(join(root, a))).sort()) {
      if (!SHARD.test(b)) continue;
      for (const name of (await dirEntries(join(root, a, b))).sort()) {
        if (isBlobName(name) && name.startsWith(a + b)) yield name;
      }
    }
  }
}

async function pruneLocal(backupDir: string, keepDays: number, today: Date): Promise<void> {
  const cutoff = isoDate(new Date(today.getTime() - keepDays * 86_400_000));
  for (const name of await dirEntries(backupDir)) {
    if (DATE_DIR.test(name) && name < cutoff) await rm(join(backupDir, name), { recursive: true, force: true });
  }
}

/** pg_dump into `<dir>/postroom.dump`, hashing on the way. Written to .partial and renamed on success. */
export async function dumpToFile(pg: PgTools, databaseUrl: string, dir: string): Promise<{ path: string; bytes: number; sha256: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, DUMP_NAME);
  const partial = `${path}.partial`;
  const hash = createHash('sha256');
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  const proc = pg.dump(databaseUrl);
  try {
    await Promise.all([pipeline(proc.stream, hasher, createWriteStream(partial, { mode: 0o600 })), proc.done]);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  await rename(partial, path);
  return { path, bytes, sha256: hash.digest('hex') };
}

async function pool<T>(items: AsyncIterable<T>, concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const running = new Set<Promise<void>>();
  // A holder, not a `let`: TypeScript cannot see the callback below assign a local.
  const state: { failure: Error | null } = { failure: null };
  for await (const item of items) {
    if (state.failure !== null) break;
    const p: Promise<void> = fn(item).then(
      () => { running.delete(p); },
      (error: unknown) => { running.delete(p); state.failure ??= error instanceof Error ? error : new Error(String(error)); },
    );
    running.add(p);
    if (running.size >= concurrency) await Promise.race(running);
  }
  await Promise.all(running);
  if (state.failure !== null) throw state.failure;
}

async function readText(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Upload the sealed KEK bundle unless the bucket's bundle already opens, with this passphrase, to this KEK. */
async function syncKekBundle(s3: S3Client, kek: Kek, passphrase: string, kdf: Partial<KdfParams> | undefined, now: Date): Promise<{ written: boolean; bytes: number }> {
  const existing = await s3.getObject(KEK_BUNDLE_KEY);
  if (existing !== null) {
    const text = await readText(existing);
    try {
      const opened = await unsealKekBundle(text, passphrase);
      if (opened.id === kek.id) return { written: false, bytes: 0 };
    } catch (error) {
      // A bundle sealed under an older passphrase (or corrupted) is exactly what gets replaced; the
      // bucket's versioning keeps the old one for 90 days. Anything else is a real failure.
      if (!(error instanceof BundleUnsealError)) throw error;
    }
  }
  const body = Buffer.from(serializeKekBundle(await sealKekBundle(kek, passphrase, { ...(kdf === undefined ? {} : { kdf }), now })), 'utf8');
  await s3.putObject(KEK_BUNDLE_KEY, { body, contentLength: body.length, sha256: createHash('sha256').update(body).digest('hex'), contentType: 'application/json', metadata: { 'kek-id': kek.id } });
  return { written: true, bytes: body.length };
}

function putBuffer(s3: S3Client, key: string, text: string, contentType: string): Promise<unknown> {
  const body = Buffer.from(text, 'utf8');
  return s3.putObject(key, { body, contentLength: body.length, sha256: createHash('sha256').update(body).digest('hex'), contentType });
}

/** Run one backup and record it. Throws (after recording ok:false) when anything fails. */
export async function runBackup(deps: BackupDeps, date?: string): Promise<LastBackup> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const started = now();
  const day = date ?? isoDate(started);
  const { config } = deps;
  const localDir = join(config.backupDir, day);
  let bytes = 0;
  let objects = 0;
  try {
    const dump = await dumpToFile(deps.pg, deps.databaseUrl, localDir);
    await writeFile(join(localDir, `${DUMP_NAME}.sha256`), `${dump.sha256}  ${DUMP_NAME}\n`);
    await pruneLocal(config.backupDir, config.keepLocalDays, started);
    const baseManifest = {
      date: day,
      startedAt: started.toISOString(),
      dumpKey: dumpKey(day),
      dumpBytes: dump.bytes,
      dumpSha256: dump.sha256,
      schemaRevision: await schemaRevision(deps.db),
      revision: deps.revision,
    };
    log('backup-dumped', { date: day, bytes: dump.bytes, sha256: dump.sha256 });

    const s3 = deps.s3 ?? (config.s3 === null ? null : createS3Client({ ...config.s3, ...(deps.now === undefined ? {} : { now: deps.now }) }));
    if (s3 === null) {
      const local: BackupManifest = { ...baseManifest, finishedAt: now().toISOString(), blobsUploaded: 0, blobsTotal: 0 };
      await writeFile(join(localDir, MANIFEST_NAME), `${JSON.stringify(local, null, 2)}\n`);
      const result: LastBackup = {
        at: local.finishedAt,
        ok: false,
        bytes: 0,
        objects: 0,
        skipped: `backups not configured (${config.missing.join(', ')} not set): local dump only, nothing left this machine`,
        dumpBytes: dump.bytes,
        dumpSha256: dump.sha256,
      };
      await recordBackup(deps.db, result);
      log('backup-skipped', { reason: result.skipped });
      return result;
    }

    await s3.putObject(dumpKey(day), { body: createReadStream(dump.path), contentLength: dump.bytes, sha256: dump.sha256 });
    await putBuffer(s3, `${dumpKey(day)}.sha256`, `${dump.sha256}  ${DUMP_NAME}\n`, 'text/plain');
    bytes += dump.bytes;
    objects += 2;

    const present = new Set<string>();
    for await (const o of s3.listObjects('blobs/')) present.add(o.key);
    let blobsTotal = 0;
    let blobsUploaded = 0;
    async function* missing(): AsyncGenerator<string> {
      for await (const sha of walkBlobs(config.blobRoot)) {
        blobsTotal++;
        if (!present.has(blobKey(sha))) yield sha;
      }
    }
    await pool(missing(), deps.concurrency ?? 4, async (sha) => {
      const path = join(config.blobRoot, sha.slice(0, 2), sha.slice(2, 4), sha);
      const size = (await stat(path)).size;
      await s3.putObject(blobKey(sha), { body: createReadStream(path), contentLength: size });
      blobsUploaded++;
      bytes += size;
      objects++;
    });

    let kekBundle: NonNullable<LastBackup['kekBundle']> = 'no passphrase';
    if (config.kekPassphrase !== null) {
      const sealed = await syncKekBundle(s3, deps.kek(), config.kekPassphrase, deps.kdf, started);
      kekBundle = sealed.written ? 'written' : 'unchanged';
      if (sealed.written) {
        bytes += sealed.bytes;
        objects++;
      }
    }

    const manifest: BackupManifest = { ...baseManifest, finishedAt: now().toISOString(), blobsUploaded, blobsTotal };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(localDir, MANIFEST_NAME), manifestText);
    await putBuffer(s3, manifestKey(day), manifestText, 'application/json');
    bytes += Buffer.byteLength(manifestText);
    objects++;

    const result: LastBackup = {
      at: manifest.finishedAt,
      ok: true,
      bytes,
      objects,
      dumpBytes: dump.bytes,
      dumpSha256: dump.sha256,
      blobsUploaded,
      blobsTotal,
      kekBundle,
      key: dumpKey(day),
    };
    await recordBackup(deps.db, result);
    log('backup-done', { ...result });
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordBackup(deps.db, { at: now().toISOString(), ok: false, bytes, objects, reason });
    log('backup-failed', { reason });
    throw error;
  }
}

/** The 'backup' queue handler: payload `{ date }`, enqueued nightly with key `backup:<date>`. */
export function backupHandler(deps: BackupDeps): (job: Job) => Promise<void> {
  return async (job) => {
    const payload = job.payload as { date?: unknown } | null;
    const date = typeof payload?.date === 'string' && DATE_DIR.test(payload.date) ? payload.date : undefined;
    await runBackup(deps, date);
  };
}
