// PST-T-16.28 (PST-REQ-139), without a database: a replayed one-time profile URL with a good MAC.
// - A spent or superseded link is answered 410 from a non-locking read: no transaction, so no
//   advisory lock is taken and no pooled connection is held for it.
// - Past OPENS_PER_LINK opens of one link id in the window, the same 410 comes with no query at all.
// - A link the read cannot refuse still goes through the locked check-and-spend.
// The integration twin is in test/integration/mobileconfig-link.test.ts.
import { auditContext } from '@postroom/audit';
import type { Db } from '@postroom/db';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { linkKey, mintLinkToken } from '../../src/mobileconfig/link.js';
import { mobileconfigOnceRoutes, onceLinkStats, OPENS_PER_LINK } from '../../src/mobileconfig/index.js';
import { request } from '../loopback.js';

const SECRET = 's'.repeat(32);
const ACCOUNT = '0b6f1e9a-3c1d-4f6e-9a2b-7c8d9e0f1a2b';
const NOW = new Date('2026-09-30T12:00:00.000Z');

type State = 'spent' | 'superseded' | 'good';

interface Where {
  action?: string;
  entityId?: string;
  OR?: unknown[];
}

/** A Db that answers the link's audit reads as `state`, and counts every call it gets. */
function fakeDb(state: State, linkId: string) {
  const calls = { queries: 0, transactions: 0, locks: 0 };
  const findFirst = ({ where }: { where: Where }) => {
    calls.queries += 1;
    if (where.action === 'mobileconfig.link.redeem') return Promise.resolve(state === 'spent' ? { id: 'redeem-row' } : null);
    if (where.OR !== undefined) {
      return Promise.resolve(
        state === 'superseded' ? { action: 'mobileconfig.link.create', entityId: 'f'.repeat(64) } : { action: 'mobileconfig.link.create', entityId: linkId },
      );
    }
    return Promise.resolve(null);
  };
  const db = {
    auditEvent: { findFirst },
    account: {
      findUnique: () => {
        calls.queries += 1;
        return Promise.resolve({ disabledAt: null });
      },
    },
    address: {
      findFirst: () => {
        calls.queries += 1;
        return Promise.resolve({ localPart: 'matt', domain: { name: 'd3cloud.io' } });
      },
    },
    // The locked path: a racing redeem got there first, so it answers spent — enough to show the
    // lock was taken without minting anything.
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => {
      calls.transactions += 1;
      return fn({
        $executeRaw: () => {
          calls.locks += 1;
          return Promise.resolve(1);
        },
        auditEvent: {
          findFirst: () => {
            calls.queries += 1;
            return Promise.resolve({ id: 'redeem-row' });
          },
        },
      });
    },
  };
  return { db: db as unknown as Db, calls };
}

function appFor(db: Db) {
  const app = express();
  app.use(
    '/once',
    auditContext(),
    mobileconfigOnceRoutes({
      db,
      env: {},
      config: { webDist: undefined, webOrigin: 'https://mail.d3cloud.io', revision: 'test', passwordPepper: 'p'.repeat(32), sessionSecret: SECRET, now: () => NOW },
    }),
  );
  return app;
}

describe('a replayed one-time link never takes the lock (PST-T-16.28)', () => {
  const link = mintLinkToken(linkKey(SECRET), ACCOUNT, NOW);

  for (const state of ['spent', 'superseded'] as const) {
    it(`50 replays of a ${state} link: all 410, no transaction, at most ${String(OPENS_PER_LINK)} opens reach the database`, async () => {
      const { db, calls } = fakeDb(state, link.linkId);
      const app = appFor(db);
      const locksBefore = onceLinkStats.locks;
      const perOpen: number[] = [];
      for (let i = 0; i < 50; i += 1) {
        const before = calls.queries;
        const res = await request(app).get(`/once/${link.token}`);
        expect(res.status).toBe(410);
        expect(res.headers['content-type']).toContain('text/plain');
        perOpen.push(calls.queries - before);
      }
      expect(calls.transactions).toBe(0);
      expect(calls.locks).toBe(0);
      expect(onceLinkStats.locks).toBe(locksBefore);
      // Each open costs at most the two reads of the non-locking check; past the per-link limit, none.
      expect(Math.max(...perOpen)).toBeLessThanOrEqual(2);
      expect(perOpen.slice(0, OPENS_PER_LINK).every((n) => n > 0)).toBe(true);
      expect(perOpen.slice(OPENS_PER_LINK).every((n) => n === 0)).toBe(true);
    });
  }

  it('answers the limited replays with the same body as a spent link', async () => {
    const { db } = fakeDb('spent', link.linkId);
    const app = appFor(db);
    const bodies = new Set<string>();
    for (let i = 0; i < OPENS_PER_LINK + 3; i += 1) bodies.add((await request(app).get(`/once/${link.token}`)).text);
    expect(bodies.size).toBe(1);
  });

  it('limits per link id: another link of the same account is not refused by one link being replayed', async () => {
    const { db, calls } = fakeDb('spent', link.linkId);
    const app = appFor(db);
    for (let i = 0; i < OPENS_PER_LINK + 5; i += 1) await request(app).get(`/once/${link.token}`);
    const other = mintLinkToken(linkKey(SECRET), ACCOUNT, NOW);
    const before = calls.queries;
    expect((await request(app).get(`/once/${other.token}`)).status).toBe(410);
    expect(calls.queries).toBeGreaterThan(before);
  });

  it('a link the read cannot refuse still goes through the locked check-and-spend', async () => {
    const { db, calls } = fakeDb('good', link.linkId);
    const app = appFor(db);
    const locksBefore = onceLinkStats.locks;
    const res = await request(app).get(`/once/${link.token}`);
    // The fake's locked read finds a racing redeem, so 410 — but only after the lock was taken.
    expect(res.status).toBe(410);
    expect(calls.transactions).toBe(1);
    expect(calls.locks).toBe(1);
    expect(onceLinkStats.locks).toBe(locksBefore + 1);
  });
});
