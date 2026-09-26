// The nightly restore drill (PST-T-0.17, PST-REQ-023): a backup is only a backup once it has been
// restored. Each night:
//
//   1. take the newest complete backup — the newest db/<date>/manifest.json in the bucket, or,
//      with no bucket configured, the newest local copy under BACKUP_DIR — and check the dump's
//      SHA-256 against its manifest;
//   2. pg_restore it into a scratch database `postroom_drill_<random>`;
//   3. pick a random Message in the RESTORED database, fetch its blob (from the bucket when
//      configured, else the local store), unwrap its DEK from the restored `blob` row with the KEK
//      — recovered from the sealed bundle in the bucket when a passphrase is configured, which
//      proves that path too — decrypt, and check the plaintext's SHA-256 equals the blob's name;
//   4. drop the scratch database, whatever happened.
//
// The outcome (ok, and the reason when red) is recorded for /health. A red drill is a result, not
// a job failure: the handler records it and completes, rather than retrying until it turns green.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { blobPath, createBlobStore } from '@postroom/blobstore';
import { unsealKekBundle, type Kek } from '@postroom/crypto';
import { createDb, type Db, type Job } from '@postroom/db';
import type { BackupConfig } from '../backup/config.js';
import { blobKey, DUMP_NAME, KEK_BUNDLE_KEY, MANIFEST_NAME, type BackupManifest, type Log } from '../backup/job.js';
import type { PgTools } from '../backup/pgtools.js';
import { createS3Client, type S3Client } from '../backup/s3.js';
import { recordDrill, type LastDrill } from '../backup/state.js';

export interface DrillDeps {
  /** Where the result is recorded (the live database). */
  db: Db;
  /** A URL whose role may CREATE DATABASE; the scratch database is made beside it. */
  adminUrl: string;
  config: BackupConfig;
  pg: PgTools;
  /** The live KEK, used when no sealed bundle is available. */
  kek: () => Kek;
  s3?: S3Client;
  now?: () => Date;
  log?: Log;
  /** For choosing the scratch name (tests). */
  scratchName?: () => string;
}

class DrillFailure extends Error {}

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function readText(stream: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseManifest(text: string, where: string): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DrillFailure(`${where} is not valid JSON`);
  }
  const m = value as Partial<BackupManifest> | null;
  if (typeof m?.dumpSha256 !== 'string' || typeof m.date !== 'string') throw new DrillFailure(`${where} has no dumpSha256`);
  return m as BackupManifest;
}

/** Copy a stream to a file, returning its SHA-256. */
async function spool(source: Readable, path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    source,
    new Transform({ transform(chunk: Buffer, _e, cb) { hash.update(chunk); cb(null, chunk); } }),
    createWriteStream(path, { mode: 0o600 }),
  );
  return hash.digest('hex');
}

interface FoundDump {
  source: 's3' | 'local';
  manifest: BackupManifest;
  dumpKey: string;
  /** Local path of the dump bytes, and their actual SHA-256. */
  path: string;
  sha256: string;
}

async function newestFromS3(s3: S3Client, work: string): Promise<FoundDump> {
  let newest: string | null = null;
  for await (const o of s3.listObjects('db/')) {
    if (o.key.endsWith(`/${MANIFEST_NAME}`) && (newest === null || o.key > newest)) newest = o.key;
  }
  if (newest === null) throw new DrillFailure('no backup in the bucket to drill (no db/<date>/manifest.json)');
  const manifestBody = await s3.getObject(newest);
  if (manifestBody === null) throw new DrillFailure(`${newest} vanished while the drill read it`);
  const manifest = parseManifest(await readText(manifestBody), newest);
  const dumpKey = newest.slice(0, -MANIFEST_NAME.length) + DUMP_NAME;
  const body = await s3.getObject(dumpKey);
  if (body === null) throw new DrillFailure(`${dumpKey} is missing beside its manifest`);
  const path = join(work, DUMP_NAME);
  return { source: 's3', manifest, dumpKey, path, sha256: await spool(body, path) };
}

async function newestLocal(backupDir: string, work: string): Promise<FoundDump> {
  let names: string[];
  try {
    names = await readdir(backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DrillFailure(`no local backups: ${backupDir} does not exist`);
    throw error;
  }
  for (const name of names.filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse()) {
    const manifestPath = join(backupDir, name, MANIFEST_NAME);
    let text: string;
    try {
      text = await readFile(manifestPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const manifest = parseManifest(text, manifestPath);
    const src = join(backupDir, name, DUMP_NAME);
    const path = join(work, DUMP_NAME);
    return { source: 'local', manifest, dumpKey: src, path, sha256: await spool(createReadStream(src), path) };
  }
  throw new DrillFailure(`no local backup to drill in ${backupDir}`);
}

async function loadKek(deps: DrillDeps, s3: S3Client | null): Promise<{ kek: Kek; from: 'bundle' | 'env' }> {
  if (s3 !== null && deps.config.kekPassphrase !== null) {
    const bundle = await s3.getObject(KEK_BUNDLE_KEY);
    if (bundle === null) throw new DrillFailure(`BACKUP_KEK_PASSPHRASE is set but ${KEK_BUNDLE_KEY} is not in the bucket`);
    try {
      return { kek: await unsealKekBundle(await readText(bundle), deps.config.kekPassphrase), from: 'bundle' };
    } catch (error) {
      throw new DrillFailure(`the KEK bundle does not open: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { kek: deps.kek(), from: 'env' };
}

/** Open one blob end to end against the restored database. */
async function openBlob(deps: DrillDeps, s3: S3Client | null, scratch: Db, kek: Kek, sha256: string, work: string): Promise<void> {
  let root = deps.config.blobRoot;
  if (s3 !== null) {
    root = join(work, 'blobs');
    const body = await s3.getObject(blobKey(sha256));
    if (body === null) throw new DrillFailure(`blob ${sha256} is referenced by the dump but missing from the bucket`);
    const path = blobPath(root, sha256);
    await mkdir(dirname(path), { recursive: true });
    await spool(body, path);
  } else {
    await stat(blobPath(root, sha256)).catch((error: unknown) => {
      throw new DrillFailure(`blob ${sha256} is missing from the local store: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  const row = await scratch.blob.findUnique({ where: { sha256 }, select: { size: true } });
  if (row === null) throw new DrillFailure(`the restored database has a message for blob ${sha256} but no blob row`);
  const store = createBlobStore({ root, db: scratch, kek });
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of await store.get(sha256)) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
  } catch (error) {
    throw new DrillFailure(`blob ${sha256} does not decrypt: ${error instanceof Error ? error.message : String(error)}`);
  }
  const actual = hash.digest('hex');
  if (actual !== sha256) throw new DrillFailure(`blob ${sha256} decrypts to plaintext hashing ${actual}`);
  if (size !== row.size) throw new DrillFailure(`blob ${sha256} decrypts to ${size} bytes, the row says ${row.size}`);
}

/** Run the drill and record its outcome. Never throws for a red drill; throws only if recording fails. */
export async function runDrill(deps: DrillDeps): Promise<LastDrill> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const s3 = deps.s3 ?? (deps.config.s3 === null ? null : createS3Client(deps.config.s3));
  const work = await mkdtemp(join(tmpdir(), 'postroom-drill-'));
  const scratchName = deps.scratchName?.() ?? `postroom_drill_${randomBytes(6).toString('hex')}`;
  if (!/^[a-z0-9_]+$/.test(scratchName)) throw new Error(`unsafe scratch database name: ${scratchName}`);
  const admin = createDb(deps.adminUrl);
  let scratch: Db | null = null;
  let created = false;
  const partial: Omit<LastDrill, 'at' | 'ok' | 'reason'> = {};
  let result: LastDrill;
  try {
    const found = s3 === null ? await newestLocal(deps.config.backupDir, work) : await newestFromS3(s3, work);
    partial.source = found.source;
    partial.dumpKey = found.dumpKey;
    if (found.sha256 !== found.manifest.dumpSha256) {
      throw new DrillFailure(`dump ${found.dumpKey} is corrupt: its sha256 is ${found.sha256}, the manifest says ${found.manifest.dumpSha256}`);
    }
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    created = true;
    const scratchUrl = withDatabase(deps.adminUrl, scratchName);
    try {
      await deps.pg.restore(scratchUrl, createReadStream(found.path));
    } catch (error) {
      throw new DrillFailure(`restore of ${found.dumpKey} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    scratch = createDb(scratchUrl);
    const picked = await scratch.$queryRaw<{ blob_sha256: string }[]>`SELECT blob_sha256 FROM message ORDER BY random() LIMIT 1`;
    const sha256 = picked[0]?.blob_sha256;
    if (sha256 === undefined) {
      result = { at: now().toISOString(), ok: true, reason: `restored ${found.dumpKey}; it holds no messages to open yet`, ...partial };
    } else {
      const { kek, from } = await loadKek(deps, s3);
      partial.kekFrom = from;
      partial.blobSha256 = sha256;
      await openBlob(deps, s3, scratch, kek, sha256, work);
      result = { at: now().toISOString(), ok: true, reason: `restored ${found.dumpKey}; opened message blob ${sha256} end to end`, ...partial };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    result = { at: now().toISOString(), ok: false, reason, ...partial };
  } finally {
    const cleanup: string[] = [];
    if (scratch !== null) await scratch.$disconnect();
    if (created) {
      try {
        await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
      } catch (error) {
        cleanup.push(`scratch database ${scratchName} was not dropped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await admin.$disconnect();
    await rm(work, { recursive: true, force: true });
    if (cleanup.length > 0) log('drill-cleanup-error', { errors: cleanup });
  }
  await recordDrill(deps.db, result);
  log(result.ok ? 'drill-green' : 'drill-red', { ...result });
  return result;
}

/** The 'drill' queue handler: payload `{ date }`, enqueued nightly with key `drill:<date>`. */
export function drillHandler(deps: DrillDeps): (job: Job) => Promise<void> {
  return async () => {
    await runDrill(deps);
  };
}
