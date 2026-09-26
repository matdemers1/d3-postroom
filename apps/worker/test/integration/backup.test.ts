// PST-T-0.16: the nightly backup against a fake S3 that checks SigV4, demands SSE-KMS and refuses
// every delete. Proves: tonight's objects land (dump + sha256 + manifest + blobs + sealed KEK
// bundle); blobs go up as the ciphertext on disk; a second run sends only new blobs; the KEK bundle
// is re-sealed only when it no longer opens to the KEK; the backup principal cannot delete;
// unconfigured is loud on /health; a bad credential is a failure on /health, not a success.
import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsealKekBundle } from '@postroom/crypto';
import { blobKey, dumpKey, isoDate, KEK_BUNDLE_KEY, manifestKey, runBackup, type BackupManifest } from '../../src/backup/job.js';
import type { PgTools } from '../../src/backup/pgtools.js';
import { buildRequest } from '../../src/backup/s3.js';
import { tick } from '../../src/backup/schedule.js';
import { maintenanceHealth } from '../../src/health.js';
import { startFakeS3, type FakeS3 } from './backup-fake-s3.js';
import { addMessage, backupConfig, backupDeps, createFixture, localEnv, s3Env, testPgTools, type Fixture } from './backup-fixtures.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('nightly backup (PST-T-0.16)', () => {
  let f: Fixture;
  let s3: FakeS3;
  let pg: PgTools;
  const today = isoDate(new Date());

  beforeAll(async () => {
    f = await createFixture(baseUrl ?? '');
    s3 = await startFakeS3({ pageSize: 2 });
    pg = testPgTools();
  }, 60_000);

  afterAll(async () => {
    await s3.close();
    await f.t.drop();
    rmSync(f.blobRoot, { recursive: true, force: true });
    rmSync(f.backupDir, { recursive: true, force: true });
  });

  it('unconfigured: takes the local dump and says loudly on /health that nothing left the machine', async () => {
    const result = await runBackup(backupDeps(f, backupConfig(localEnv(f)), pg));
    expect(result.ok).toBe(false);
    expect(result.skipped).toMatch(/backups not configured \(BACKUP_BUCKET not set\)/);
    const health = await maintenanceHealth(f.db);
    expect(health.lastBackup?.ok).toBe(false);
    expect(health.lastBackup?.skipped).toMatch(/not configured/);
    expect(s3.log).toHaveLength(0);
  });

  it("puts tonight's dump, manifest, blobs and sealed KEK bundle in the bucket, all SSE-KMS", async () => {
    const result = await runBackup(backupDeps(f, backupConfig(s3Env(f, s3)), pg));
    expect(result.ok).toBe(true);
    expect(result.blobsUploaded).toBe(3);
    expect(result.blobsTotal).toBe(3);
    expect(result.kekBundle).toBe('written');

    const dump = s3.current(dumpKey(today));
    expect(dump?.subarray(0, 5).toString('latin1')).toBe('PGDMP');
    const sha = createHash('sha256').update(dump ?? Buffer.alloc(0)).digest('hex');
    expect(s3.current(`${dumpKey(today)}.sha256`)?.toString()).toBe(`${sha}  postroom.dump\n`);
    const manifest = JSON.parse(s3.current(manifestKey(today))?.toString() ?? '{}') as BackupManifest;
    expect(manifest).toMatchObject({ date: today, dumpSha256: sha, dumpBytes: dump?.length, blobsUploaded: 3, blobsTotal: 3, revision: 'test-rev' });
    expect(manifest.schemaRevision).toMatch(/^\d+_/);

    // Blobs go up as the ciphertext on disk: byte-identical to the file, never the plaintext.
    for (const sha256 of f.shas) {
      const onDisk = readFileSync(join(f.blobRoot, sha256.slice(0, 2), sha256.slice(2, 4), sha256));
      expect(s3.current(blobKey(sha256))?.equals(onDisk)).toBe(true);
      expect(s3.current(blobKey(sha256))?.includes(Buffer.from('Subject: message'))).toBe(false);
    }

    // The KEK is only ever in the bucket inside the passphrase-sealed bundle.
    const bundle = s3.current(KEK_BUNDLE_KEY)?.toString() ?? '';
    expect((await unsealKekBundle(bundle, 'correct horse battery staple')).id).toBe(f.kek.id);
    for (const versions of s3.objects.values()) {
      for (const v of versions) {
        expect(v.sse).toBe('aws:kms');
        expect(v.kmsKeyId).toBe(s3.kmsKeyId);
      }
    }

    const health = await maintenanceHealth(f.db);
    expect(health.lastBackup).toMatchObject({ ok: true, objects: result.objects, bytes: result.bytes });
    expect(health.lastBackup?.bytes).toBeGreaterThan(dump?.length ?? 0);
    expect(Date.now() - Date.parse(health.lastBackup?.at ?? '')).toBeLessThan(60_000);
  });

  it('a second run uploads only the new blob and leaves the bundle alone', async () => {
    const fresh = await addMessage(f, 'arrived after the first backup');
    const before = s3.log.length;
    const result = await runBackup(backupDeps(f, backupConfig(s3Env(f, s3)), pg));
    expect(result).toMatchObject({ ok: true, blobsUploaded: 1, blobsTotal: 4, kekBundle: 'unchanged' });
    const blobPuts = s3.log.slice(before).filter((r) => r.method === 'PUT' && r.key.startsWith('blobs/'));
    expect(blobPuts.map((r) => r.key)).toEqual([blobKey(fresh)]);
    expect(s3.objects.get(KEK_BUNDLE_KEY)).toHaveLength(1);
    // Same date, second dump: a new version, the first kept (versioned bucket).
    expect(s3.objects.get(dumpKey(today))).toHaveLength(2);
  });

  it('re-seals the bundle when the passphrase changes; the old version stays', async () => {
    const result = await runBackup(backupDeps(f, backupConfig(s3Env(f, s3, { BACKUP_KEK_PASSPHRASE: 'a new passphrase' })), pg));
    expect(result.kekBundle).toBe('written');
    expect(s3.objects.get(KEK_BUNDLE_KEY)).toHaveLength(2);
    expect((await unsealKekBundle(s3.current(KEK_BUNDLE_KEY)?.toString() ?? '', 'a new passphrase')).id).toBe(f.kek.id);
  });

  it('the backup principal cannot delete (403 AccessDenied, object still there)', async () => {
    const config = backupConfig(s3Env(f, s3)).s3;
    if (config === null) throw new Error('configured');
    const req = buildRequest(config, 'DELETE', dumpKey(today));
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(req.url, { method: 'DELETE', headers: req.headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      r.on('error', reject);
      r.end();
    });
    expect(status).toBe(403);
    expect(s3.current(dumpKey(today))).toBeDefined();
  });

  it('a wrong secret is a failed backup on /health, never a success', async () => {
    const env = s3Env(f, s3, { AWS_SECRET_ACCESS_KEY: 'not-the-secret' });
    await expect(runBackup(backupDeps(f, backupConfig(env), pg))).rejects.toThrow(/SignatureDoesNotMatch/);
    const health = await maintenanceHealth(f.db);
    expect(health.lastBackup?.ok).toBe(false);
    expect(health.lastBackup?.reason).toMatch(/403 SignatureDoesNotMatch/);
  });

  it('a pg_dump that fails is a failed backup and leaves no dump behind', async () => {
    const broken = { ...pg, dump: (url: string) => pg.dump(url.replace(/\/[^/]+$/, '/pst_t016_does_not_exist')) };
    await expect(runBackup(backupDeps(f, backupConfig(s3Env(f, s3)), broken), '2000-01-01')).rejects.toThrow(/pg_dump exited/);
    expect(s3.current(dumpKey('2000-01-01'))).toBeUndefined();
    expect((await maintenanceHealth(f.db)).lastBackup?.ok).toBe(false);
  });

  it('the nightly tick enqueues backup:<date> and drill:<date> once, however often it runs', async () => {
    const at = new Date('2031-01-02T05:00:00Z');
    const times = { backupAt: '03:00', drillAt: '04:30' };
    expect(await tick(f.db, at, times)).toEqual(['backup:2031-01-02', 'drill:2031-01-02']);
    expect(await tick(f.db, at, times)).toEqual([]);
    const jobs = await f.db.job.findMany({ where: { idempotencyKey: { in: ['backup:2031-01-02', 'drill:2031-01-02'] } } });
    expect(jobs.map((j) => [j.queue, j.payload])).toEqual(expect.arrayContaining([['backup', { date: '2031-01-02' }], ['drill', { date: '2031-01-02' }]]));
  });
});
