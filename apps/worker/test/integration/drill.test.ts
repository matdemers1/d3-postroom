// PST-T-0.17: the nightly restore drill. Restores the newest backup into a scratch database, opens
// a random message's blob end to end with the DEK from the RESTORED database (and the KEK from the
// sealed bundle), and drops the scratch database. Green on /health when it works; a corrupted dump
// turns it red with the reason.
import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@postroom/db';
import { dumpKey, isoDate, manifestKey, runBackup, blobKey } from '../../src/backup/job.js';
import type { PgTools } from '../../src/backup/pgtools.js';
import { runDrill, type DrillDeps } from '../../src/drill/drill.js';
import { maintenanceHealth } from '../../src/health.js';
import { startFakeS3, type FakeS3 } from './backup-fake-s3.js';
import { backupConfig, backupDeps, createFixture, localEnv, s3Env, testPgTools, type Fixture } from './backup-fixtures.js';

const baseUrl = process.env['DATABASE_URL'];
const PREFIX = `pst_t016_drill_${randomBytes(3).toString('hex')}`;

async function scratchDatabases(): Promise<string[]> {
  const admin = createDb(baseUrl ?? '');
  try {
    const rows = await admin.$queryRaw<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE ${`${PREFIX}%`}`;
    return rows.map((r) => r.datname);
  } finally {
    await admin.$disconnect();
  }
}

describe.skipIf(baseUrl === undefined)('nightly restore drill (PST-T-0.17)', () => {
  let f: Fixture;
  let s3: FakeS3;
  let tools: PgTools;
  const today = isoDate(new Date());
  let n = 0;

  const drillDeps = (env: NodeJS.ProcessEnv): DrillDeps => ({
    db: f.db,
    adminUrl: baseUrl ?? '',
    config: backupConfig(env),
    pg: tools,
    kek: () => f.kek,
    scratchName: () => `${PREFIX}_${n++}`,
  });

  beforeAll(async () => {
    f = await createFixture(baseUrl ?? '');
    s3 = await startFakeS3();
    tools = testPgTools();
    const backed = await runBackup(backupDeps(f, backupConfig(s3Env(f, s3)), tools));
    expect(backed.ok).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await s3.close();
    await f.t.drop();
    rmSync(f.blobRoot, { recursive: true, force: true });
    rmSync(f.backupDir, { recursive: true, force: true });
  });

  it('restores the bucket backup and opens a random message end to end → green on /health', async () => {
    const result = await runDrill(drillDeps(s3Env(f, s3)));
    expect(result.reason).toMatch(/opened message blob [0-9a-f]{64} end to end/);
    expect(result).toMatchObject({ ok: true, source: 's3', kekFrom: 'bundle', dumpKey: dumpKey(today) });
    expect(f.shas).toContain(result.blobSha256);
    const health = await maintenanceHealth(f.db);
    expect(health.lastDrill).toMatchObject({ ok: true, blobSha256: result.blobSha256 });
    expect(await scratchDatabases()).toEqual([]);
  });

  it('a corrupted dump turns the drill red with the reason', async () => {
    const good = s3.current(dumpKey(today)) ?? Buffer.alloc(0);
    const bad = Buffer.from(good);
    for (let i = 64; i < bad.length; i += 97) bad[i] = (bad[i] ?? 0) ^ 0xff;
    s3.tamper(dumpKey(today), bad);
    try {
      const result = await runDrill(drillDeps(s3Env(f, s3)));
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/dump db\/.*postroom\.dump is corrupt: its sha256 is [0-9a-f]{64}, the manifest says/);
      const health = await maintenanceHealth(f.db);
      expect(health.lastDrill?.ok).toBe(false);
      expect(health.lastDrill?.reason).toMatch(/corrupt/);
    } finally {
      s3.tamper(dumpKey(today), good);
    }
  });

  it('a damaged dump whose manifest agrees with it is still red: pg_restore refuses it', async () => {
    const good = s3.current(dumpKey(today)) ?? Buffer.alloc(0);
    const goodManifest = s3.current(manifestKey(today)) ?? Buffer.alloc(0);
    const truncated = good.subarray(0, Math.floor(good.length / 2));
    s3.tamper(dumpKey(today), truncated);
    const manifest = JSON.parse(goodManifest.toString()) as Record<string, unknown>;
    manifest['dumpSha256'] = createHash('sha256').update(truncated).digest('hex');
    s3.tamper(manifestKey(today), Buffer.from(JSON.stringify(manifest)));
    try {
      const result = await runDrill(drillDeps(s3Env(f, s3)));
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/restore of db\/.*postroom\.dump failed: pg_restore exited/);
      expect(await scratchDatabases()).toEqual([]);
    } finally {
      s3.tamper(dumpKey(today), good);
      s3.tamper(manifestKey(today), goodManifest);
    }
  });

  it('a message whose blob never reached the bucket is red', async () => {
    const saved = new Map(f.shas.map((sha) => [sha, s3.objects.get(blobKey(sha))] as const));
    for (const sha of f.shas) s3.objects.delete(blobKey(sha));
    try {
      const result = await runDrill(drillDeps(s3Env(f, s3)));
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/referenced by the dump but missing from the bucket/);
    } finally {
      for (const [sha, versions] of saved) if (versions !== undefined) s3.objects.set(blobKey(sha), versions);
    }
  });

  it('a wrong KEK passphrase is red: the bundle does not open', async () => {
    const result = await runDrill(drillDeps(s3Env(f, s3, { BACKUP_KEK_PASSPHRASE: 'wrong' })));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/the KEK bundle does not open/);
  });

  it('without a bucket, drills the local copy the backup kept → green', async () => {
    const result = await runDrill(drillDeps(localEnv(f)));
    expect(result).toMatchObject({ ok: true, source: 'local', kekFrom: 'env' });
    expect(await scratchDatabases()).toEqual([]);
    expect((await maintenanceHealth(f.db)).lastDrill?.ok).toBe(true);
  });
});
