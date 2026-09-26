// Where a finished export's archive is recorded (PST-T-10.1): one `setting` row per export, keyed
// by the job id, mirroring how the nightly backup records its last run (apps/worker/src/backup/state.ts).
// No schema change needed — `setting` is already a generic key/value table.
import type { Db, Prisma } from '@postroom/db';

export const EXPORT_RESULT_PREFIX = 'export-result.';
export const exportResultKey = (exportId: string): string => `${EXPORT_RESULT_PREFIX}${exportId}`;

export interface ExportFolderManifest {
  name: string;
  path: string;
  messageCount: number;
  sha256: string;
}

/** `calendars` and `addressBooks` are the extension point for CalDAV/CardDAV export (a later
 * phase): always present, always empty today, ready for `packages/ical` and `packages/vcard` to
 * fill once calendar and address-book tables exist. */
export interface ExportManifest {
  account: string;
  exportedAt: string;
  revision: string;
  schemaRevision: string | null;
  formatVersions: Record<string, string | number>;
  folders: ExportFolderManifest[];
  messageCount: number;
  calendars: unknown[];
  addressBooks: unknown[];
}

export interface ExportResult {
  accountId: string;
  archiveSha256: string;
  archiveSize: number;
  finishedAt: string;
  expiresAt: string;
  manifest: ExportManifest;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function writeExportResult(db: Db, exportId: string, result: ExportResult): Promise<void> {
  const key = exportResultKey(exportId);
  await db.setting.upsert({ where: { key }, create: { key, value: toJson(result) }, update: { value: toJson(result) } });
}

export async function readExportResult(db: Db, exportId: string): Promise<ExportResult | null> {
  const row = await db.setting.findUnique({ where: { key: exportResultKey(exportId) } });
  return row === null ? null : (row.value as unknown as ExportResult);
}

export async function deleteExportResult(db: Db, exportId: string): Promise<void> {
  await db.setting.deleteMany({ where: { key: exportResultKey(exportId) } });
}

/** Every export result past `now`, for the sweep that deletes archives after 24 h. */
export async function listExpiredExportResults(db: Db, now: Date): Promise<{ exportId: string; result: ExportResult }[]> {
  const rows = await db.setting.findMany({ where: { key: { startsWith: EXPORT_RESULT_PREFIX } } });
  const expired: { exportId: string; result: ExportResult }[] = [];
  for (const row of rows) {
    const result = row.value as unknown as ExportResult;
    if (new Date(result.expiresAt).getTime() <= now.getTime()) expired.push({ exportId: row.key.slice(EXPORT_RESULT_PREFIX.length), result });
  }
  return expired;
}
