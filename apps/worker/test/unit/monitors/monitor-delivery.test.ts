// PST-T-4.13, PST-REQ-183: the delivery monitor's pure logic against a faked
// `db.deliveryAttempt.findMany`, and `classifySesRefusal`'s reply-text matching in isolation.
import { describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { classifySesRefusal, createDeliveryMonitor } from '../../../src/monitors/delivery.js';

interface Attempt {
  outcome: string;
  transport: string;
  remoteCode: number | null;
  remoteText: string | null;
  startedAt: Date;
}

function fakeDb(attempts: Attempt[]): Db {
  return {
    deliveryAttempt: {
      findMany: () => Promise.resolve(attempts),
    },
  } as unknown as Db;
}

const NOW = new Date('2026-09-27T12:00:00.000Z');
const minutesAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);

function attempt(partial: Partial<Attempt>): Attempt {
  return { outcome: 'delivered', transport: 'direct', remoteCode: 250, remoteText: 'OK', startedAt: minutesAgo(1), ...partial };
}

describe('classifySesRefusal (PST-REQ-183)', () => {
  it('classifies 454 throttling', () => {
    expect(classifySesRefusal({ remoteCode: 454, remoteText: '4.7.0 Throttling failure: Maximum sending rate exceeded.' })).toBe('throttling');
  });

  it('classifies a paused/suspended account and a quota-exceeded reply', () => {
    expect(classifySesRefusal({ remoteCode: 554, remoteText: 'Account has been paused' })).toBe('account');
    expect(classifySesRefusal({ remoteCode: 554, remoteText: 'Sending suspended for this account' })).toBe('account');
    expect(classifySesRefusal({ remoteCode: 554, remoteText: '5.7.1 Daily quota-exceeded' })).toBe('account');
  });

  it('does not classify an ordinary per-recipient rejection', () => {
    expect(classifySesRefusal({ remoteCode: 550, remoteText: 'No such user' })).toBeNull();
    expect(classifySesRefusal({ remoteCode: 454, remoteText: 'Temporary local problem' })).toBeNull();
  });
});

describe('delivery monitor (PST-REQ-183)', () => {
  it('is clean below 20% permanent failures', async () => {
    const attempts = [...Array(8).keys()].map(() => attempt({ outcome: 'delivered' })).concat([attempt({ outcome: 'bounced' }), attempt({ outcome: 'deferred' })]);
    const monitor = createDeliveryMonitor({ db: fakeDb(attempts), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(true);
  });

  it('is clean with fewer than 10 attempts even at 100% permanent failure', async () => {
    const attempts = [attempt({ outcome: 'bounced' }), attempt({ outcome: 'bounced' })];
    const monitor = createDeliveryMonitor({ db: fakeDb(attempts), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(true);
  });

  it('fires when permanent failures exceed 20% of at least 10 attempts', async () => {
    const attempts = [...Array(7).keys()].map(() => attempt({ outcome: 'delivered' })).concat([attempt({ outcome: 'bounced' }), attempt({ outcome: 'bounced' }), attempt({ outcome: 'bounced' })]);
    const monitor = createDeliveryMonitor({ db: fakeDb(attempts), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/3\/10 permanent/);
  });

  it('fires immediately on an SES account-level refusal, even with plenty of healthy attempts', async () => {
    const attempts = [...Array(20).keys()].map(() => attempt({ outcome: 'delivered' })).concat([
      attempt({ transport: 'ses', outcome: 'error', remoteCode: 554, remoteText: 'Account has been paused' }),
    ]);
    const monitor = createDeliveryMonitor({ db: fakeDb(attempts), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/SES account-level refusal/);
  });

  it('a single throttled SES attempt does not fire — it takes a sustained 15-minute spread', async () => {
    const attempts = [attempt({ transport: 'ses', outcome: 'deferred', remoteCode: 454, remoteText: '4.7.0 Throttling failure' })];
    const monitor = createDeliveryMonitor({ db: fakeDb(attempts), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(true);
  });

  it('fires when throttling spans at least 15 minutes', async () => {
    const attempts = [
      attempt({ transport: 'ses', outcome: 'deferred', remoteCode: 454, remoteText: 'Throttling failure', startedAt: minutesAgo(20) }),
      attempt({ transport: 'ses', outcome: 'deferred', remoteCode: 454, remoteText: 'Throttling failure', startedAt: minutesAgo(10) }),
      attempt({ transport: 'ses', outcome: 'deferred', remoteCode: 454, remoteText: 'Throttling failure', startedAt: minutesAgo(1) }),
    ];
    const monitor = createDeliveryMonitor({ db: fakeDb(attempts), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/sustained/);
  });

  it('two throttled attempts less than 15 minutes apart do not fire', async () => {
    const attempts = [
      attempt({ transport: 'ses', outcome: 'deferred', remoteCode: 454, remoteText: 'Throttling failure', startedAt: minutesAgo(10) }),
      attempt({ transport: 'ses', outcome: 'deferred', remoteCode: 454, remoteText: 'Throttling failure', startedAt: minutesAgo(1) }),
    ];
    const monitor = createDeliveryMonitor({ db: fakeDb(attempts), now: () => NOW });
    const result = await monitor.check();
    expect(result.ok).toBe(true);
  });
});
