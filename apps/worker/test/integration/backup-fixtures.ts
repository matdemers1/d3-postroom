// Shared setup for the backup and drill integration tests: a migrated database with a few filed
// messages in an encrypted blob store, a fake S3, and pg tools that match the 16 server.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek, type Kek } from '@postroom/crypto';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { backupConfig, type BackupConfig } from '../../src/backup/config.js';
import type { BackupDeps } from '../../src/backup/job.js';
import { commandPgTools, type PgTools } from '../../src/backup/pgtools.js';
import type { FakeS3 } from './backup-fake-s3.js';
import { plainMessage } from './helpers.js';

function localPgDumpVersion(): string {
  try {
    return execFileSync('pg_dump', ['--version'], { encoding: 'utf8' });
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * The local pg_dump when it is 16; otherwise (or with PST_PG_TOOLS=docker) the one inside the
 * pst-pg container (postgres:16), reached with `docker exec`.
 */
export function testPgTools(): PgTools {
  if (process.env['PST_PG_TOOLS'] !== 'docker' && / 16\./.test(localPgDumpVersion())) return commandPgTools();
  const container = process.env['PST_PG_CONTAINER'] ?? 'pst-pg';
  return commandPgTools({
    pgDump: ['docker', 'exec', '-i', container, 'pg_dump'],
    pgRestore: ['docker', 'exec', '-i', container, 'pg_restore'],
    mapUrl: (url) => {
      const u = new URL(url);
      u.hostname = '127.0.0.1';
      u.port = '5432';
      return u.toString();
    },
  });
}

export const TEST_KDF = { memoryCost: 1024, timeCost: 1, parallelism: 1 };

export interface Fixture {
  t: TestDatabase;
  db: Db;
  kek: Kek;
  blobs: BlobStore;
  blobRoot: string;
  backupDir: string;
  accountId: string;
  shas: string[];
}

export async function createFixture(baseUrl: string): Promise<Fixture> {
  const t = await createTestDatabase(baseUrl, 'pst_t016');
  const db = t.db;
  await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
  const accountId = (await db.account.create({ data: { displayName: 'Backups' } })).id;
  const blobRoot = mkdtempSync(join(tmpdir(), 'pst-t016-blobs-'));
  const backupDir = mkdtempSync(join(tmpdir(), 'pst-t016-backups-'));
  const kek = generateKek();
  const blobs = createBlobStore({ root: blobRoot, db, kek });
  const fixture: Fixture = { t, db, kek, blobs, blobRoot, backupDir, accountId, shas: [] };
  for (let i = 0; i < 3; i++) await addMessage(fixture, `message ${i}`);
  return fixture;
}

/** Store a message's blob and file it into INBOX, as delivery does. */
export async function addMessage(f: Fixture, subject: string): Promise<string> {
  const put = await f.blobs.put(plainMessage({ subject }));
  await f.db.$transaction((tx) =>
    fileLocalMessage(tx, { accountId: f.accountId, mailbox: 'INBOX', blobSha256: put.sha256, size: put.size, internalDate: new Date() }),
  );
  f.shas.push(put.sha256);
  return put.sha256;
}

export function s3Env(f: Fixture, s3: FakeS3, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    BACKUP_BUCKET: s3.bucket,
    BACKUP_KMS_KEY_ID: s3.kmsKeyId,
    AWS_ACCESS_KEY_ID: s3.accessKeyId,
    AWS_SECRET_ACCESS_KEY: s3.secretAccessKey,
    AWS_REGION: 'us-east-1',
    BACKUP_S3_ENDPOINT: s3.url,
    BACKUP_DIR: f.backupDir,
    BLOB_ROOT: f.blobRoot,
    BACKUP_KEK_PASSPHRASE: 'correct horse battery staple',
    ...extra,
  };
}

export function localEnv(f: Fixture): NodeJS.ProcessEnv {
  return { BACKUP_DIR: f.backupDir, BLOB_ROOT: f.blobRoot };
}

export function backupDeps(f: Fixture, config: BackupConfig, pg: PgTools): BackupDeps {
  return { db: f.db, databaseUrl: f.t.url, config, pg, kek: () => f.kek, revision: 'test-rev', kdf: TEST_KDF };
}

export { backupConfig };
