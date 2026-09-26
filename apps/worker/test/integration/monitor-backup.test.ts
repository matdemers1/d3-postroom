// PST-REQ-097: the backup/drill monitor against real `setting` rows written the way the backup and
// drill jobs write them (recordBackup/recordDrill).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { createTestDatabase, type TestDatabase } from '@postroom/db/testing';
import { recordBackup, recordDrill } from '../../src/backup/state.js';
import { createBackupMonitor } from '../../src/monitors/backup.js';

const baseUrl = process.env['DATABASE_URL'];

describe.skipIf(baseUrl === undefined)('backup/drill monitor (PST-REQ-097)', () => {
  let t: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase(baseUrl ?? '', 'pst_t47_backup');
    db = t.db;
  }, 30_000);

  afterAll(async () => {
    await t.drop();
  });

  it('never fires while unconfigured, even with no backup on record', async () => {
    const monitor = createBackupMonitor({ db, configured: false });
    expect((await monitor.check()).ok).toBe(true);
  });

  it('fires once configured with no backup, clears once a good backup and drill land, fires again when one goes stale', async () => {
    const monitor = createBackupMonitor({ db, configured: true, maxAgeS: 3_600 });
    const firing = await monitor.check();
    expect(firing.ok).toBe(false);
    expect(firing.detail).toMatch(/no backup recorded/);

    const now = new Date();
    await recordBackup(db, { at: now.toISOString(), ok: true, bytes: 100, objects: 3 });
    await recordDrill(db, { at: now.toISOString(), ok: true, reason: 'opened cleanly' });
    const clear = await monitor.check();
    expect(clear.ok).toBe(true);

    const stale = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    await recordBackup(db, { at: stale, ok: true, bytes: 100, objects: 3 });
    const staleResult = await monitor.check();
    expect(staleResult.ok).toBe(false);
    expect(staleResult.detail).toMatch(/stale/);
  });

  it('fires when the recorded backup itself failed', async () => {
    const monitor = createBackupMonitor({ db, configured: true, maxAgeS: 3_600 });
    await recordBackup(db, { at: new Date().toISOString(), ok: false, bytes: 0, objects: 0, reason: 'credential rejected' });
    const result = await monitor.check();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/credential rejected/);
  });
});
