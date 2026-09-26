// Where an import keeps itself (PST-T-10.2, PST-REQ-152): `setting` rows keyed by the import's job
// id — no schema change, the same pattern as the export's result row (../export/settings.ts).
//
//   import-state.<id>   the import's parameters (never the password), status, and per-folder
//                       progress { uidvalidity, lastUid, total, imported, duplicates, done } —
//                       rewritten inside the same transaction that files each message, so progress
//                       and mail never disagree after a crash.
//   import-secret.<id>  the source password sealed under the KEK (AAD binds it to this import),
//                       written by the API when the import starts and deleted when it ends —
//                       done, failed or cancelled. Nothing else ever holds it at rest.
//   import-cancel.<id>  exists once the owner asked to cancel; a separate row so the API never
//                       read-modify-writes the state row the worker is writing.
//
// apps/api/src/import/store.ts reads and writes the same keys and shapes: change one, change both.
import { openWithKek, sealWithKek, type Kek } from '@postroom/crypto';
import type { Db, Prisma } from '@postroom/db';
import type { ImportSpecialUse } from './names.js';

export const IMPORT_QUEUE = 'import';
export const IMPORT_STATE_PREFIX = 'import-state.';
export const IMPORT_SECRET_PREFIX = 'import-secret.';
export const IMPORT_CANCEL_PREFIX = 'import-cancel.';
export const importStateKey = (id: string): string => `${IMPORT_STATE_PREFIX}${id}`;
export const importSecretKey = (id: string): string => `${IMPORT_SECRET_PREFIX}${id}`;
export const importCancelKey = (id: string): string => `${IMPORT_CANCEL_PREFIX}${id}`;

export type ImportStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ImportFolderProgress {
  /** The source's name, exactly as it sent it. */
  source: string;
  /** Human form of the source name. */
  display: string;
  /** Our mailbox it files into. */
  target: string;
  specialUse: ImportSpecialUse | null;
  /** The source folder's UIDVALIDITY when lastUid was recorded; null before the first SELECT. */
  uidvalidity: number | null;
  /** Every source UID up to this one is filed (or was a duplicate). */
  lastUid: number;
  /** Messages in the source folder at the last SELECT. */
  total: number;
  imported: number;
  duplicates: number;
  done: boolean;
}

export interface ImportState {
  accountId: string;
  host: string;
  port: number;
  username: string;
  trustFingerprint: string | null;
  /** Source folder names asked for, or null for every folder. */
  folders: string[] | null;
  status: ImportStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  progress: ImportFolderProgress[];
}

type Tx = Prisma.TransactionClient | Db;

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function readImportState(db: Tx, id: string): Promise<ImportState | null> {
  const row = await db.setting.findUnique({ where: { key: importStateKey(id) } });
  return row === null ? null : (row.value as unknown as ImportState);
}

export async function writeImportState(db: Tx, id: string, state: ImportState): Promise<void> {
  const key = importStateKey(id);
  await db.setting.upsert({ where: { key }, create: { key, value: toJson(state) }, update: { value: toJson(state) } });
}

export async function cancelRequested(db: Tx, id: string): Promise<boolean> {
  return (await db.setting.findUnique({ where: { key: importCancelKey(id) }, select: { key: true } })) !== null;
}

const secretAad = (id: string): string => `postroom-import-secret:${id}`;

/** The password sealed for storage in `import-secret.<id>` (base64). */
export function sealImportSecret(kek: Kek, id: string, password: string): string {
  return sealWithKek(kek, Buffer.from(password, 'utf8'), secretAad(id)).toString('base64');
}

/** The sealed password, or null when it is gone (the import ended or was cancelled). Zero it after use. */
export async function openImportSecret(db: Tx, kek: Kek, id: string): Promise<Buffer | null> {
  const row = await db.setting.findUnique({ where: { key: importSecretKey(id) } });
  if (row === null) return null;
  const sealed = (row.value as { sealed?: unknown } | null)?.sealed;
  if (typeof sealed !== 'string') return null;
  return openWithKek(kek, Buffer.from(sealed, 'base64'), secretAad(id));
}

export async function wipeImportSecret(db: Tx, id: string): Promise<void> {
  await db.setting.deleteMany({ where: { key: { in: [importSecretKey(id), importCancelKey(id)] } } });
}

/** Totals over every folder, for the status API and the audit record. */
export function importTotals(state: Pick<ImportState, 'progress'>): { total: number; imported: number; duplicates: number; foldersDone: number; folders: number } {
  let total = 0;
  let imported = 0;
  let duplicates = 0;
  let foldersDone = 0;
  for (const f of state.progress) {
    total += f.total;
    imported += f.imported;
    duplicates += f.duplicates;
    if (f.done) foldersDone++;
  }
  return { total, imported, duplicates, foldersDone, folders: state.progress.length };
}
