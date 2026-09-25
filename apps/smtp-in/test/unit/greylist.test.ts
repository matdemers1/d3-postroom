// PST-REQ-062: greylist a first-contact triplet with no SPF pass and no FCrDNS (or soft-listed),
// deferring with 451 for 5 minutes; pass immediately on SPF pass or good FCrDNS.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@postroom/db';
import { checkGreylist, checkGreylistDetailed, greylistKey, isSoftListed, pruneGreylist } from '../../src/greylist.js';

interface Row {
  key: string;
  firstSeen: Date;
  passedAt: Date | null;
  expiresAt: Date;
}

function fakeDb(): { db: Db; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const greylistEntry = {
    findUnique: ({ where }: { where: { key: string } }): Promise<Row | null> => Promise.resolve(rows.get(where.key) ?? null),
    create: ({ data }: { data: { key: string; firstSeen: Date; expiresAt: Date } }): Promise<Row> => {
      const row: Row = { key: data.key, firstSeen: data.firstSeen, passedAt: null, expiresAt: data.expiresAt };
      rows.set(data.key, row);
      return Promise.resolve(row);
    },
    update: ({ where, data }: { where: { key: string }; data: Partial<Row> }): Promise<Row> => {
      const row = rows.get(where.key);
      if (row === undefined) throw new Error(`no row for ${where.key}`);
      Object.assign(row, data);
      return Promise.resolve(row);
    },
    deleteMany: ({ where }: { where: { expiresAt: { lt: Date } } }): Promise<{ count: number }> => {
      let count = 0;
      for (const [k, row] of rows) {
        if (row.expiresAt < where.expiresAt.lt) {
          rows.delete(k);
          count++;
        }
      }
      return Promise.resolve({ count });
    },
  };
  return { db: { greylistEntry } as unknown as Db, rows };
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('checkGreylist', () => {
  let db: Db;
  let rows: Map<string, Row>;
  let now: Date;
  const clock = (): Date => now;

  beforeEach(() => {
    ({ db, rows } = fakeDb());
    now = new Date('2026-01-01T00:00:00Z');
  });

  it('passes an authenticated (SPF pass) first contact immediately, and stores nothing', async () => {
    const verdict = await checkGreylist(
      db,
      { clientIp: '198.51.100.9', mailFrom: 'a@sender.example', recipient: 'matt@d3cloud.io', spfResult: 'pass', fcrdns: false },
      { now: clock },
    );
    expect(verdict).toBe('pass');
    expect(rows.size).toBe(0);
  });

  it('passes on good FCrDNS with no SPF, and stores nothing', async () => {
    const verdict = await checkGreylist(
      db,
      { clientIp: '198.51.100.9', mailFrom: 'a@sender.example', recipient: 'matt@d3cloud.io', fcrdns: true },
      { now: clock },
    );
    expect(verdict).toBe('pass');
    expect(rows.size).toBe(0);
  });

  it('defers a soft-listed sender even with good FCrDNS', async () => {
    const verdict = await checkGreylist(
      db,
      { clientIp: '198.51.100.9', mailFrom: 'a@sender.example', recipient: 'matt@d3cloud.io', fcrdns: true, softListed: true },
      { now: clock },
    );
    expect(verdict).toBe('defer');
  });

  it('passes when neither SPF nor FCrDNS was determined by the caller (the un-wired smtp-in call site), and stores nothing', async () => {
    const outcome = await checkGreylistDetailed(
      db,
      { clientIp: '198.51.100.9', mailFrom: 'a@sender.example', recipient: 'matt@d3cloud.io' },
      { now: clock },
    );
    expect(outcome).toEqual({ verdict: 'pass', reason: 'unwired' });
    expect(rows.size).toBe(0);
  });

  it('defers an unauthenticated, no-FCrDNS first contact, then again inside the delay, then passes at 5 minutes and on later retries', async () => {
    const input = { clientIp: '198.51.100.9', mailFrom: 'bad@sender.example', recipient: 'matt@d3cloud.io', fcrdns: false };
    const start = now;

    const first = await checkGreylistDetailed(db, input, { now: clock });
    expect(first).toEqual({ verdict: 'defer', reason: 'first-contact' });

    now = new Date(start.getTime() + 4 * MIN);
    const early = await checkGreylistDetailed(db, input, { now: clock });
    expect(early).toEqual({ verdict: 'defer', reason: 'too-soon' });

    now = new Date(start.getTime() + 5 * MIN);
    const onTime = await checkGreylistDetailed(db, input, { now: clock });
    expect(onTime).toEqual({ verdict: 'pass', reason: 'retry-ok' });

    now = new Date(now.getTime() + HOUR);
    const later = await checkGreylistDetailed(db, input, { now: clock });
    expect(later).toEqual({ verdict: 'pass', reason: 'known-pass' });
  });

  it('defers again once the retry window has expired without a retry', async () => {
    const input = { clientIp: '198.51.100.9', mailFrom: 'ghost@sender.example', recipient: 'matt@d3cloud.io', fcrdns: false };
    const first = await checkGreylistDetailed(db, input, { now: clock });
    expect(first.verdict).toBe('defer');

    now = new Date(now.getTime() + 25 * HOUR); // past the 24h retry window, never retried
    const stale = await checkGreylistDetailed(db, input, { now: clock });
    expect(stale).toEqual({ verdict: 'defer', reason: 'retry-expired' });
  });

  it('defers again once a known-pass has expired past its TTL', async () => {
    const input = { clientIp: '198.51.100.9', mailFrom: 'once@sender.example', recipient: 'matt@d3cloud.io', fcrdns: false };
    await checkGreylistDetailed(db, input, { now: clock });
    now = new Date(now.getTime() + 5 * MIN);
    const passed = await checkGreylistDetailed(db, input, { now: clock });
    expect(passed).toEqual({ verdict: 'pass', reason: 'retry-ok' });

    now = new Date(now.getTime() + 37 * DAY); // past the 36-day pass TTL
    const expired = await checkGreylistDetailed(db, input, { now: clock });
    expect(expired).toEqual({ verdict: 'defer', reason: 'pass-expired' });
  });

  it('aggregates an IPv4 /24: two addresses in the same network share the triplet', async () => {
    const a = { clientIp: '198.51.100.1', mailFrom: 'x@sender.example', recipient: 'matt@d3cloud.io', fcrdns: false };
    const b = { clientIp: '198.51.100.200', mailFrom: 'x@sender.example', recipient: 'matt@d3cloud.io', fcrdns: false };
    expect(greylistKey(a.clientIp, a.mailFrom, a.recipient)).toBe(greylistKey(b.clientIp, b.mailFrom, b.recipient));

    await checkGreylistDetailed(db, a, { now: clock });
    expect(rows.size).toBe(1);
    now = new Date(now.getTime() + 5 * MIN);
    const fromB = await checkGreylistDetailed(db, b, { now: clock });
    expect(fromB).toEqual({ verdict: 'pass', reason: 'retry-ok' });
  });

  it('aggregates an IPv6 /64: two addresses in the same network share the triplet', async () => {
    const a = { clientIp: '2001:db8:abcd:1::1', mailFrom: 'x@sender.example', recipient: 'matt@d3cloud.io', fcrdns: false };
    const b = { clientIp: '2001:db8:abcd:1::ffff', mailFrom: 'x@sender.example', recipient: 'matt@d3cloud.io', fcrdns: false };
    const c = { clientIp: '2001:db8:abcd:2::1', mailFrom: 'x@sender.example', recipient: 'matt@d3cloud.io', fcrdns: false };
    expect(greylistKey(a.clientIp, a.mailFrom, a.recipient)).toBe(greylistKey(b.clientIp, b.mailFrom, b.recipient));
    expect(greylistKey(a.clientIp, a.mailFrom, a.recipient)).not.toBe(greylistKey(c.clientIp, c.mailFrom, c.recipient));

    await checkGreylistDetailed(db, a, { now: clock });
    expect(rows.size).toBe(1);
    now = new Date(now.getTime() + 5 * MIN);
    const fromB = await checkGreylistDetailed(db, b, { now: clock });
    expect(fromB).toEqual({ verdict: 'pass', reason: 'retry-ok' });
  });

  it('is case-insensitive on sender and recipient, and treats `<>` as the null sender', () => {
    const withCase = { clientIp: '198.51.100.9', mailFrom: 'X@Sender.example', recipient: 'Matt@D3Cloud.io' };
    const lower = { clientIp: '198.51.100.9', mailFrom: 'x@sender.example', recipient: 'matt@d3cloud.io' };
    expect(greylistKey(withCase.clientIp, withCase.mailFrom, withCase.recipient)).toBe(
      greylistKey(lower.clientIp, lower.mailFrom, lower.recipient),
    );
    expect(greylistKey('198.51.100.9', null, 'matt@d3cloud.io')).toBe(greylistKey('198.51.100.9', '<>', 'matt@d3cloud.io'));
  });
});

describe('isSoftListed', () => {
  it('matches an IPv4 CIDR and an exact IPv6 address from GREYLIST_SOFT_LIST', () => {
    const env = { GREYLIST_SOFT_LIST: '203.0.113.0/24, 2001:db8::1/128' } as unknown as NodeJS.ProcessEnv;
    expect(isSoftListed('203.0.113.42', env)).toBe(true);
    expect(isSoftListed('203.0.114.42', env)).toBe(false);
    expect(isSoftListed('2001:db8::1', env)).toBe(true);
    expect(isSoftListed('2001:db8::2', env)).toBe(false);
  });

  it('is false with no list configured', () => {
    expect(isSoftListed('203.0.113.42', {})).toBe(false);
  });
});

describe('pruneGreylist', () => {
  it('deletes only expired rows', async () => {
    const { db: pruneDb, rows } = fakeDb();
    rows.set('a', { key: 'a', firstSeen: new Date(0), passedAt: null, expiresAt: new Date('2026-01-01') });
    rows.set('b', { key: 'b', firstSeen: new Date(0), passedAt: null, expiresAt: new Date('2027-01-01') });
    const deleted = await pruneGreylist(pruneDb, new Date('2026-06-01'));
    expect(deleted).toBe(1);
    expect(rows.has('a')).toBe(false);
    expect(rows.has('b')).toBe(true);
  });
});
