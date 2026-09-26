// Where the last backup and the last drill are recorded (PST-REQ-022, PST-REQ-023): one `setting`
// row each, so /health reports them across restarts and a one-shot `postroom backup` run from the
// CLI shows up on the daemon's /health just the same.
import type { Db, Prisma } from '@postroom/db';

export const BACKUP_SETTING = 'backup.last';
export const DRILL_SETTING = 'drill.last';

export interface LastBackup {
  /** When the run finished (ISO 8601). */
  at: string;
  ok: boolean;
  /** Bytes sent to the bucket this run (dump + manifests + new blobs + bundle). */
  bytes: number;
  /** Objects written to the bucket this run. */
  objects: number;
  /** Set when nothing left the machine because backups are not configured. */
  skipped?: string;
  /** Why ok is false. */
  reason?: string;
  dumpBytes?: number;
  dumpSha256?: string;
  blobsUploaded?: number;
  blobsTotal?: number;
  kekBundle?: 'written' | 'unchanged' | 'no passphrase';
  key?: string;
}

export interface LastDrill {
  at: string;
  ok: boolean;
  reason: string;
  /** Where the dump came from. */
  source?: 's3' | 'local';
  dumpKey?: string;
  /** The blob opened end to end, when there was a message to open. */
  blobSha256?: string;
  kekFrom?: 'bundle' | 'env';
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function write(db: Db, key: string, value: unknown): Promise<void> {
  await db.setting.upsert({ where: { key }, create: { key, value: json(value) }, update: { value: json(value) } });
}

async function read<T>(db: Db, key: string): Promise<T | null> {
  const row = await db.setting.findUnique({ where: { key } });
  return row === null ? null : (row.value as T);
}

export const recordBackup = (db: Db, value: LastBackup): Promise<void> => write(db, BACKUP_SETTING, value);
export const recordDrill = (db: Db, value: LastDrill): Promise<void> => write(db, DRILL_SETTING, value);
export const readLastBackup = (db: Db): Promise<LastBackup | null> => read<LastBackup>(db, BACKUP_SETTING);
export const readLastDrill = (db: Db): Promise<LastDrill | null> => read<LastDrill>(db, DRILL_SETTING);
