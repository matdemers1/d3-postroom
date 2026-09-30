// PST-T-15.10 (PST-REQ-195, PST-ADR-013): the worker's sweep of composer uploads, against a real
// database and blob store.
//   · an upload untouched for longer than the max age is deleted, its reference released and — when
//     that was the last one — its blob crypto-shredded and the file reaped; a fresh one stays;
//   · a blob another upload (or a message) still references survives with one reference fewer;
//   · an upload touched after it was listed (a send, a draft save) is not deleted;
//   · a message whose blob carries the file's bytes is untouched: the sweep never loses mail;
//   · every deletion is audited, as the system.
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobPath, createBlobStore, type BlobStore } from '@postroom/blobstore';
import { generateKek } from '@postroom/crypto';
import { randomUidValidity, seed, SpecialUse, type Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { fileLocalMessage } from '@postroom/dsn';
import { createUploadSweeper, DEFAULT_UPLOAD_MAX_AGE_MS } from '../../src/sweep/upload-sweep.js';

const baseUrl = process.env['DATABASE_URL'];
const HOUR = 3_600_000;

describe.skipIf(!baseUrl)('compose upload sweep (PST-T-15.10)', () => {
  let t: TestDatabase;
  let db: Db;
  let blobs: BlobStore;
  let blobRoot: string;
  let accountId: string;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t1510_sweep');
    db = t.db;
    await seed(db, { operatorName: 'Operator', domain: 'd3cloud.io' });
    blobRoot = mkdtempSync(join(tmpdir(), 'pst-t1510-sweep-'));
    blobs = createBlobStore({ root: blobRoot, db, kek: generateKek() });
    const account = await db.account.create({ data: { displayName: 'Sweep' } });
    accountId = account.id;
    await db.mailbox.create({ data: { accountId, name: 'Sent', specialUse: SpecialUse.sent, uidvalidity: randomUidValidity(randomInt) } });
  }, 120_000);

  afterAll(async () => {
    await t.drop();
    rmSync(blobRoot, { recursive: true, force: true });
  });

  const uploadAt = async (bytes: Buffer, lastUsedAt: Date, filename = 'f.bin') => {
    const put = await blobs.put(bytes);
    return db.composeUpload.create({ data: { accountId, blobSha256: put.sha256, filename, contentType: 'application/octet-stream', size: put.size, lastUsedAt } });
  };
  const refcount = async (sha: string): Promise<number> => (await db.blob.findUnique({ where: { sha256: sha } }))?.refcount ?? 0;

  it('releases uploads unused for 24 h (shredding a blob nothing else holds), keeps fresh ones, audits each', async () => {
    const now = new Date();
    const lines: { event: string; fields: Record<string, unknown> }[] = [];
    const sweep = createUploadSweeper({ db, blobs, now: () => now, log: (event, fields = {}) => lines.push({ event, fields }) });

    const stale = await uploadAt(randomBytes(64), new Date(now.getTime() - 25 * HOUR));
    const fresh = await uploadAt(randomBytes(64), new Date(now.getTime() - 23 * HOUR));
    // Two uploads of the same bytes: the stale one's reference goes, the blob stays for the other.
    const shared = randomBytes(64);
    const sharedStale = await uploadAt(shared, new Date(now.getTime() - 48 * HOUR), 'a.bin');
    const sharedFresh = await uploadAt(shared, now, 'b.bin');
    expect(await refcount(sharedStale.blobSha256)).toBe(2);

    const result = await sweep();
    expect(result).toEqual({ released: 2, shredded: 1 });
    expect(await db.composeUpload.findUnique({ where: { id: stale.id } })).toBeNull();
    expect(await db.composeUpload.findUnique({ where: { id: sharedStale.id } })).toBeNull();
    expect(await db.composeUpload.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await db.composeUpload.findUnique({ where: { id: sharedFresh.id } })).not.toBeNull();
    // Crypto-shred: the row with the wrapped DEK is gone, and so is the file.
    expect(await refcount(stale.blobSha256)).toBe(0);
    expect(existsSync(blobPath(blobRoot, stale.blobSha256))).toBe(false);
    expect(await refcount(sharedFresh.blobSha256)).toBe(1);
    expect(await blobs.verify(sharedFresh.blobSha256)).toBe(true);

    const audits = await db.auditEvent.findMany({ where: { action: 'compose.upload.expire' } });
    expect(audits.map((a) => a.entityId).sort()).toEqual([stale.id, sharedStale.id].sort());
    expect(audits.every((a) => a.actorKind === 'system' && a.actorAccountId === null)).toBe(true);
    expect(lines).toContainEqual({ event: 'upload-sweep', fields: expect.objectContaining({ released: 2, shredded: 1 }) as unknown });

    // Nothing left to do: a second run changes nothing.
    expect(await sweep()).toEqual({ released: 0, shredded: 0 });
    await db.composeUpload.deleteMany({});
  });

  it('never loses mail: a message whose blob carries the same bytes is untouched', async () => {
    const now = new Date();
    const file = randomBytes(2048);
    const upload = await uploadAt(file, new Date(now.getTime() - 30 * HOUR), 'kept.bin');
    // What a send files in Sent: its own blob, the whole message, the file base64 inside it.
    const b64 = file.toString('base64').replace(/.{76}/g, '$&\r\n');
    const message = Buffer.from(
      ['From: me@d3cloud.io', 'To: a@example.org', 'Subject: kept', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: text/plain', '', 'x', '--B', 'Content-Type: application/octet-stream; name="kept.bin"', 'Content-Disposition: attachment; filename="kept.bin"', 'Content-Transfer-Encoding: base64', '', b64, '--B--', ''].join('\r\n'),
    );
    const put = await blobs.put(message);
    const filed = await db.$transaction((tx) => fileLocalMessage(tx, { accountId, mailbox: 'Sent', blobSha256: put.sha256, size: put.size, internalDate: now }));

    const result = await createUploadSweeper({ db, blobs, now: () => now })();
    expect(result.released).toBe(1);
    expect(await refcount(upload.blobSha256)).toBe(0);
    const row = await db.message.findUniqueOrThrow({ where: { id: filed.id } });
    expect(await blobs.verify(row.blobSha256)).toBe(true);
    const text = (await blobs.getBuffer(row.blobSha256)).toString('latin1');
    const encoded = text.slice(text.indexOf('base64\r\n\r\n') + 10, text.indexOf('\r\n--B--'));
    expect(Buffer.from(encoded.replace(/\r\n/g, ''), 'base64').equals(file)).toBe(true);
  });

  it('an upload touched after it was listed stays (the delete is conditional on last_used_at)', async () => {
    const now = new Date();
    const upload = await uploadAt(randomBytes(32), new Date(now.getTime() - 30 * HOUR));
    // A db whose first findMany returns the stale row, then a send touches it before the delete.
    const bound = (obj: object, key: string | symbol): unknown => {
      const value = Reflect.get(obj, key) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
    };
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'composeUpload') return bound(target, prop);
        return new Proxy(target.composeUpload, {
          get(inner, key) {
            if (key !== 'findMany') return bound(inner, key);
            return async (args: Parameters<typeof inner.findMany>[0]) => {
              const rows = await inner.findMany(args);
              await inner.update({ where: { id: upload.id }, data: { lastUsedAt: now } });
              return rows;
            };
          },
        });
      },
    });
    const result = await createUploadSweeper({ db: racing, blobs, now: () => now })();
    expect(result.released).toBe(0);
    expect(await db.composeUpload.findUnique({ where: { id: upload.id } })).not.toBeNull();
    expect(await refcount(upload.blobSha256)).toBe(1);
    await db.composeUpload.deleteMany({});
  });

  it('a row whose blob is already gone is still removed; the age is configurable', async () => {
    const now = new Date();
    const upload = await uploadAt(randomBytes(32), new Date(now.getTime() - 2 * HOUR));
    // Someone released the blob out from under it.
    await blobs.release(upload.blobSha256);
    expect(await createUploadSweeper({ db, blobs, now: () => now })()).toEqual({ released: 0, shredded: 0 });
    expect(await createUploadSweeper({ db, blobs, now: () => now, maxAgeMs: HOUR })()).toEqual({ released: 1, shredded: 0 });
    expect(await db.composeUpload.count()).toBe(0);
    expect(DEFAULT_UPLOAD_MAX_AGE_MS).toBe(24 * HOUR);
  });
});
