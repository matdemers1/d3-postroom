// The full-data export (PST-T-10.1, PST-REQ-151): every folder as mboxrd, plus manifest.json, in
// one ZIP, streamed straight into the blob store so nothing (not even a 10 GB mailbox) is buffered
// in memory or written to disk as plaintext. Queue: 'export'; payload `{ accountId }`; the job's own
// id is the export id the API hands back. The job queue's own status (pending/running/done/dead)
// is the export's status — no separate state machine — and the finished archive's location lives
// in one `setting` row (settings.ts), read by the API's status and download routes.
//
// Calendars and address books are a later phase (no tables yet); the manifest's `calendars` and
// `addressBooks` arrays are the extension point and are always empty today.
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { BlobStore } from '@postroom/blobstore';
import { schemaRevision, type Db, type Job } from '@postroom/db';
import { mboxFolder, type MboxMessageInput } from './mbox.js';
import { writeExportResult, type ExportFolderManifest, type ExportManifest } from './settings.js';
import { ZipWriter } from './zip.js';

export const EXPORT_QUEUE = 'export';
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
export const FORMAT_VERSIONS = { mbox: 'mboxrd-1', manifest: 1 } as const;
const PAGE = 500;

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface ExportDeps {
  db: Db;
  blobs: BlobStore;
  revision: string;
  now?: () => Date;
  log?: Log;
}

/** A folder name (IMAP hierarchy, `/`-separated) as a safe zip path: no empty, `.` or `..` segments. */
export function safeFolderPath(name: string): string {
  const segments = name
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  return segments.length === 0 ? 'folder' : segments.join('/');
}

/** Every message of one mailbox, oldest UID first, paged so a 10 GB mailbox is never loaded at once. */
async function* messagesOf(db: Db, blobs: BlobStore, mailboxId: string, counter: { count: number }): AsyncGenerator<MboxMessageInput> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.message.findMany({
      where: { mailboxId },
      orderBy: { uid: 'asc' },
      take: PAGE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      select: { id: true, blobSha256: true, fromAddress: true, internalDate: true },
    });
    if (rows.length === 0) return;
    for (const row of rows) {
      counter.count++;
      yield { envelopeFrom: row.fromAddress ?? '', date: row.internalDate, raw: await blobs.get(row.blobSha256) };
    }
    const last = rows[rows.length - 1];
    if (rows.length < PAGE || last === undefined) return;
    cursor = last.id;
  }
}

/** Runs one account's export end to end and records the finished archive. Throws on failure — the
 * queue's retry/backoff (and eventual `dead`) is the export's failure path; nothing is recorded. */
export async function runExport(deps: ExportDeps, exportId: string, accountId: string): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  const mailboxes = await deps.db.mailbox.findMany({ where: { accountId }, orderBy: { name: 'asc' }, select: { id: true, name: true } });

  const sink = new PassThrough();
  const putPromise = deps.blobs.put(sink);
  const zip = new ZipWriter(sink);

  const folders: ExportFolderManifest[] = [];
  let totalMessages = 0;

  // Two mailboxes can reduce to the same safe path ('..' and '.', or names differing only in
  // trimmed whitespace); a zip with duplicate entry names loses one on extraction, so later ones get
  // a numbered suffix. The manifest keeps the real name beside each path.
  const usedPaths = new Set<string>();
  for (const mailbox of mailboxes) {
    const base = safeFolderPath(mailbox.name);
    let path = `mail/${base}.mbox`;
    for (let n = 2; usedPaths.has(path.toLowerCase()); n++) path = `mail/${base} (${String(n)}).mbox`;
    usedPaths.add(path.toLowerCase());
    const hash = createHash('sha256');
    const counter = { count: 0 };
    async function* hashed(): AsyncGenerator<Buffer> {
      for await (const chunk of mboxFolder(messagesOf(deps.db, deps.blobs, mailbox.id, counter))) {
        hash.update(chunk);
        yield chunk;
      }
    }
    await zip.addEntry(path, hashed());
    folders.push({ name: mailbox.name, path, messageCount: counter.count, sha256: hash.digest('hex') });
    totalMessages += counter.count;
    log('export-folder', { exportId, mailbox: mailbox.name, messageCount: counter.count });
  }

  const manifest: ExportManifest = {
    account: accountId,
    exportedAt: now().toISOString(),
    revision: deps.revision,
    schemaRevision: await schemaRevision(deps.db),
    formatVersions: FORMAT_VERSIONS,
    folders,
    messageCount: totalMessages,
    // Calendars and address books have no tables yet (a later phase): the extension point, empty
    // until packages/ical and packages/vcard land and CalDAV/CardDAV collections exist to export.
    calendars: [],
    addressBooks: [],
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await zip.addEntry('manifest.json', [manifestBuffer]);
  await zip.finish();

  const put = await putPromise;
  const finishedAt = now();
  await writeExportResult(deps.db, exportId, {
    accountId,
    archiveSha256: put.sha256,
    archiveSize: put.size,
    finishedAt: finishedAt.toISOString(),
    expiresAt: new Date(finishedAt.getTime() + EXPORT_TTL_MS).toISOString(),
    manifest,
  });
  log('export-done', { exportId, accountId, folders: folders.length, messages: totalMessages, sha256: put.sha256, size: put.size });
}

/** The 'export' queue handler: payload `{ accountId }`. The job's status is the export's status. */
export function exportHandler(deps: ExportDeps): (job: Job) => Promise<void> {
  return async (job) => {
    const payload = job.payload as { accountId?: unknown } | null;
    const accountId = typeof payload?.accountId === 'string' ? payload.accountId : undefined;
    if (accountId === undefined) throw new Error('export job payload missing accountId');
    await runExport(deps, job.id, accountId);
  };
}
