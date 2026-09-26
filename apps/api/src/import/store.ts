// The import's `setting` rows, from the API's side (PST-T-10.2, PST-REQ-152). The worker's job
// (apps/worker/src/import/state.ts) owns the same keys and shapes — apps never import each other's
// src, so this is its own small copy of that contract: change one, change the other.
//
//   import-state.<id>   parameters (never the password), status, per-folder progress
//   import-secret.<id>  the source password sealed under the KEK, AAD bound to the import id
//   import-cancel.<id>  exists once the owner asked to cancel
import { sealWithKek, type Kek } from '@postroom/crypto';
import type { Db, Prisma } from '@postroom/db';

export const IMPORT_QUEUE = 'import';
export const importStateKey = (id: string): string => `import-state.${id}`;
export const importSecretKey = (id: string): string => `import-secret.${id}`;
export const importCancelKey = (id: string): string => `import-cancel.${id}`;

export type ImportStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ImportFolderProgress {
  source: string;
  display: string;
  target: string;
  specialUse: string | null;
  uidvalidity: number | null;
  lastUid: number;
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

/** Seals the password for `import-secret.<id>`: the same AAD the worker opens it with. */
export async function writeImportSecret(db: Tx, kek: Kek, id: string, password: string): Promise<void> {
  const plain = Buffer.from(password, 'utf8');
  const sealed = sealWithKek(kek, plain, `postroom-import-secret:${id}`).toString('base64');
  plain.fill(0);
  await db.setting.create({ data: { key: importSecretKey(id), value: { sealed } } });
}

export async function cancelRequested(db: Tx, id: string): Promise<boolean> {
  return (await db.setting.findUnique({ where: { key: importCancelKey(id) }, select: { key: true } })) !== null;
}
