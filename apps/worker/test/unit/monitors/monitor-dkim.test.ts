// PST-T-4.13: the dkim monitor's pure logic against a faked `db.dkimKey.findMany`.
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { createDkimMonitor } from '../../../src/monitors/dkim.js';

interface KeyRow {
  domainId: string;
  selector: string;
  createdAt: Date;
}

function fakeDb(rows: KeyRow[]): Db {
  return {
    dkimKey: {
      findMany: () => Promise.resolve(rows),
    },
  } as unknown as Db;
}

const NOW = new Date('2026-09-27T12:00:00.000Z');
const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);

describe('dkim monitor (PST-T-4.13)', () => {
  it('is clean with no key stuck awaiting DNS', async () => {
    const monitor = createDkimMonitor({ db: fakeDb([]), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(true);
  });

  it('fires when a pending key has been awaiting DNS for more than 7 days', async () => {
    const rows: KeyRow[] = [{ domainId: 'd1', selector: 's1', createdAt: daysAgo(10) }];
    const monitor = createDkimMonitor({ db: fakeDb(rows), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/awaiting DNS/);
    expect(result.detail).toMatch(/d1\/s1/);
  });

  it('a key pending for less than the threshold is not a firing condition (the query itself excludes it)', async () => {
    // The query filters createdAt < cutoff; a fresh key never reaches the monitor at all.
    const monitor = createDkimMonitor({ db: fakeDb([]), maxAwaitingDays: 7, now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(true);
  });

  it('honours a configured threshold', async () => {
    const rows: KeyRow[] = [{ domainId: 'd1', selector: 's1', createdAt: daysAgo(2) }];
    const monitor = createDkimMonitor({ db: fakeDb(rows), maxAwaitingDays: 1, now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(false);
  });

  it('names every stuck key and reports the oldest', async () => {
    const rows: KeyRow[] = [
      { domainId: 'd1', selector: 's1', createdAt: daysAgo(8) },
      { domainId: 'd2', selector: 's2', createdAt: daysAgo(20) },
    ];
    const monitor = createDkimMonitor({ db: fakeDb(rows), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/2 DKIM key/);
    expect(result.detail).toMatch(/oldest 20d/);
  });
});
