// PST-T-10.1, PST-REQ-151: the export job end to end — several folders (one nested with '/', one
// with a non-ASCII name), a message whose body contains "From " and ">From " lines, and the
// resulting archive: valid ZIP, mboxrd quoting round-trips, manifest counts and per-folder sha256
// match, and the sweep deletes the archive's blob once it is past its expiresAt.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { seed, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExportSweeper } from '../../../src/export/sweep.js';
import { readExportResult } from '../../../src/export/settings.js';
import { runExport } from '../../../src/export/job.js';
import { parseMbox } from '../../../src/export/mbox.js';

const baseUrl = process.env['DATABASE_URL'];

function unzipAvailable(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function message(opts: { from: string; subject: string; extraLine: string }): Buffer {
  return Buffer.from(
    `From: ${opts.from}\r\n` + `Subject: ${opts.subject}\r\n` + 'Date: Fri, 25 Sep 2026 12:00:00 +0000\r\n' + '\r\n' + `${opts.extraLine}\r\n` + 'plain body line\r\n',
    'utf8',
  );
}

describe.skipIf(baseUrl === undefined)('export job (PST-T-10.1, PST-REQ-151)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot = '';
  let accountId = '';
  const shas: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t101_export');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-export-blobs-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    accountId = (await db.account.create({ data: { displayName: 'Exporter' } })).id;

    const inboxA = await blobs.put(message({ from: 'alice@example.org', subject: 'hello', extraLine: 'From the road, hi' }));
    await db.$transaction((tx) => fileLocalMessage(tx, { accountId, mailbox: 'INBOX', blobSha256: inboxA.sha256, size: inboxA.size, internalDate: new Date('2026-01-01T00:00:00Z') }));
    await db.message.updateMany({ where: { blobSha256: inboxA.sha256 }, data: { fromAddress: 'alice@example.org' } });
    shas.push(inboxA.sha256);

    const inboxB = await blobs.put(message({ from: 'bob@example.org', subject: 'quoted', extraLine: '>From nested quote line' }));
    await db.$transaction((tx) => fileLocalMessage(tx, { accountId, mailbox: 'INBOX', blobSha256: inboxB.sha256, size: inboxB.size, internalDate: new Date('2026-01-02T00:00:00Z') }));
    await db.message.updateMany({ where: { blobSha256: inboxB.sha256 }, data: { fromAddress: 'bob@example.org' } });
    shas.push(inboxB.sha256);

    const nested = await blobs.put(message({ from: 'carol@example.org', subject: 'archived', extraLine: 'ordinary line' }));
    await db.$transaction((tx) => fileLocalMessage(tx, { accountId, mailbox: 'Archive/2024', blobSha256: nested.sha256, size: nested.size, internalDate: new Date('2026-01-03T00:00:00Z') }));
    await db.message.updateMany({ where: { blobSha256: nested.sha256 }, data: { fromAddress: 'carol@example.org' } });
    shas.push(nested.sha256);

    const unicode = await blobs.put(message({ from: 'dora@example.org', subject: 'unicode folder', extraLine: 'ünïcödé body ✓' }));
    await db.$transaction((tx) => fileLocalMessage(tx, { accountId, mailbox: 'Ärchiv', blobSha256: unicode.sha256, size: unicode.size, internalDate: new Date('2026-01-04T00:00:00Z') }));
    await db.message.updateMany({ where: { blobSha256: unicode.sha256 }, data: { fromAddress: 'dora@example.org' } });
    shas.push(unicode.sha256);
  }, 60_000);

  afterAll(async () => {
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  it('produces a valid ZIP with correct mboxrd quoting, manifest counts and per-folder sha256', async () => {
    const exportId = 'test-export-1';
    const now = new Date('2026-09-26T00:00:00Z');
    await runExport({ db, blobs, revision: 'test-rev', now: () => now }, exportId, accountId);

    const result = await readExportResult(db, exportId);
    expect(result).not.toBeNull();
    expect(result?.accountId).toBe(accountId);
    expect(result?.manifest.messageCount).toBe(4);
    expect(result?.manifest.calendars).toEqual([]);
    expect(result?.manifest.addressBooks).toEqual([]);
    expect(result?.manifest.folders).toHaveLength(3);
    expect(result?.expiresAt).toBe(new Date(now.getTime() + 24 * 3_600_000).toISOString());

    const inbox = result?.manifest.folders.find((f) => f.name === 'INBOX');
    expect(inbox?.messageCount).toBe(2);
    expect(inbox?.path).toBe('mail/INBOX.mbox');
    const nested = result?.manifest.folders.find((f) => f.name === 'Archive/2024');
    expect(nested?.path).toBe('mail/Archive/2024.mbox');
    const unicode = result?.manifest.folders.find((f) => f.name === 'Ärchiv');
    expect(unicode?.path).toBe('mail/Ärchiv.mbox');

    const archive = await blobs.getBuffer(result?.archiveSha256 ?? '');
    expect(result?.archiveSize).toBe(archive.length);
    expect(archive.subarray(0, 4).toString('hex')).toBe('504b0304');

    const dir = mkdtempSync(join(tmpdir(), 'pst-export-zip-'));
    const path = join(dir, 'export.zip');
    writeFileSync(path, archive);
    try {
      if (unzipAvailable()) {
        expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' })).toMatch(/No errors detected/);
        const inboxMbox = execFileSync('unzip', ['-p', path, 'mail/INBOX.mbox'], { encoding: 'utf8' });
        expect(inboxMbox).toContain('>From the road, hi');
        expect(inboxMbox).toContain('>>From nested quote line');
        const manifestText = execFileSync('unzip', ['-p', path, 'manifest.json'], { encoding: 'utf8' });
        const manifest = JSON.parse(manifestText) as { messageCount: number };
        expect(manifest.messageCount).toBe(4);

        // The per-folder sha256 in the manifest matches the mbox bytes actually zipped.
        const hash = createHash('sha256').update(Buffer.from(inboxMbox, 'latin1')).digest('hex');
        expect(hash).toBe(inbox?.sha256);

        // The mboxrd quoting round-trips: parsing the extracted mbox recovers the original lines.
        const parsed = parseMbox(inboxMbox);
        expect(parsed).toHaveLength(2);
        expect(parsed[0]?.body).toContain('From the road, hi');
        expect(parsed[1]?.body).toContain('>From nested quote line');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('gives mailboxes whose names reduce to the same path distinct zip entries', async () => {
    const other = (await db.account.create({ data: { displayName: 'Colliding names' } })).id;
    for (const name of ['.', '..', 'folder']) {
      const b = await blobs.put(message({ from: 'eve@example.org', subject: `in ${name}`, extraLine: 'x' }));
      await db.$transaction((tx) => fileLocalMessage(tx, { accountId: other, mailbox: name, blobSha256: b.sha256, size: b.size, internalDate: new Date('2026-01-05T00:00:00Z') }));
    }
    await runExport({ db, blobs, revision: 'test-rev', now: () => new Date('2026-09-26T00:00:00Z') }, 'test-export-collide', other);
    const result = await readExportResult(db, 'test-export-collide');
    const paths = (result?.manifest.folders ?? []).map((f) => f.path);
    expect(paths).toHaveLength(3);
    expect(new Set(paths.map((p) => p.toLowerCase())).size).toBe(3);
    for (const p of paths) expect(p.startsWith('mail/') && !p.includes('..')).toBe(true);
  }, 30_000);

  it('sweeps the archive once past its expiresAt, releasing the blob', async () => {
    const exportId = 'test-export-2';
    const start = new Date('2026-09-01T00:00:00Z');
    await runExport({ db, blobs, revision: 'test-rev', now: () => start }, exportId, accountId);
    const before = await readExportResult(db, exportId);
    expect(before).not.toBeNull();
    const archiveSha256 = before?.archiveSha256 ?? '';
    expect(await blobs.stat(archiveSha256)).not.toBeNull();

    const stillFresh = createExportSweeper({ db, blobs, now: () => new Date(start.getTime() + 60_000) });
    expect(await stillFresh()).toBe(0);
    expect(await readExportResult(db, exportId)).not.toBeNull();

    const pastExpiry = createExportSweeper({ db, blobs, now: () => new Date(start.getTime() + 25 * 3_600_000) });
    expect(await pastExpiry()).toBeGreaterThanOrEqual(1);
    expect(await readExportResult(db, exportId)).toBeNull();
    expect(await blobs.stat(archiveSha256)).toBeNull();
  });
});
