// Reads what the worker's export job wrote (apps/worker/src/export/settings.ts): one `setting` row
// per finished export, keyed `export-result.<jobId>`. Kept as its own small reader here rather than
// an app-to-app import — apps never import each other's src, only shared packages — but the key and
// shape are a contract between the two: change one, change the other.
import type { Db } from '@postroom/db';

export const EXPORT_RESULT_PREFIX = 'export-result.';
export const exportResultKey = (exportId: string): string => `${EXPORT_RESULT_PREFIX}${exportId}`;

export interface ExportResult {
  accountId: string;
  archiveSha256: string;
  archiveSize: number;
  finishedAt: string;
  expiresAt: string;
  manifest: ExportManifestJson;
}

/** The manifest as the worker writes it — matches export/schemas.ts's ExportManifest shape. */
export interface ExportManifestJson {
  account: string;
  exportedAt: string;
  revision: string;
  schemaRevision: string | null;
  formatVersions: Record<string, string | number>;
  folders: { name: string; path: string; messageCount: number; sha256: string }[];
  messageCount: number;
  calendars: unknown[];
  addressBooks: unknown[];
}

export async function readExportResult(db: Db, exportId: string): Promise<ExportResult | null> {
  const row = await db.setting.findUnique({ where: { key: exportResultKey(exportId) } });
  return row === null ? null : (row.value as unknown as ExportResult);
}
