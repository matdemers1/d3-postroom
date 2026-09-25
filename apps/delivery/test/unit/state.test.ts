import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  baseDelayMs,
  canCancel,
  DAY,
  DELAY_DSN_AFTER_MS,
  HOUR,
  JITTER,
  MAX_QUEUE_AGE_MS,
  MINUTE,
  nextState,
  parseNotify,
  retrySchedule,
  type AttemptOutcome,
  type RecipientSnapshot,
} from '../../src/state.js';

const T0 = new Date('2026-09-25T00:00:00Z');
const temp: AttemptOutcome = { kind: 'temporary', code: 451, enhanced: '4.3.0', text: 'try later' };

function recipient(over: Partial<RecipientSnapshot> = {}): RecipientSnapshot {
  return {
    id: 'r1',
    outboundMessageId: 'm1',
    address: 'a@example.com',
    attempts: 1,
    createdAt: T0,
    dsnNotify: null,
    delayDsnSentAt: null,
    failureDsnSentAt: null,
    ...over,
  };
}

/** Walk a recipient through temporary failures until it bounces; returns every attempt time. */
function walk(random: () => number, notify: string | null = null): { times: number[]; bouncedAt: number; dsn: string[] } {
  const times: number[] = [];
  const dsn: string[] = [];
  let r = recipient({ attempts: 0, dsnNotify: notify });
  let now = T0.getTime();
  for (let i = 0; i < 1000; i++) {
    times.push(now);
    r = { ...r, attempts: r.attempts + 1 };
    const t = nextState(r, temp, new Date(now), random);
    for (const d of t.dsn) {
      dsn.push(d.kind);
      if (d.kind === 'delay') r = { ...r, delayDsnSentAt: new Date(now) };
      else r = { ...r, failureDsnSentAt: new Date(now) };
    }
    if (t.state === 'bounced') return { times, bouncedAt: now, dsn };
    expect(t.state).toBe('deferred');
    now = t.nextAttemptAt.getTime();
  }
  throw new Error('never bounced');
}

describe('retry schedule', () => {
  it('is the documented table, then every 4 hours', () => {
    expect(retrySchedule).toEqual([5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 40 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]);
    expect(baseDelayMs(1)).toBe(5 * MINUTE);
    expect(baseDelayMs(8)).toBe(4 * HOUR);
    expect(baseDelayMs(9)).toBe(4 * HOUR);
    expect(baseDelayMs(40)).toBe(4 * HOUR);
  });

  it('nextAttemptAt is monotonic and within the jitter bounds of the schedule', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), { minLength: 1, maxLength: 64 }), (rs) => {
        let i = 0;
        const random = (): number => rs[i++ % rs.length] ?? 0.5;
        const { times } = walk(random);
        for (let k = 1; k < times.length; k++) {
          const prev = times[k - 1] ?? 0;
          const cur = times[k] ?? 0;
          expect(cur).toBeGreaterThan(prev);
          const gap = cur - prev;
          const base = baseDelayMs(k);
          const clamped = cur === T0.getTime() + MAX_QUEUE_AGE_MS;
          expect(gap).toBeLessThanOrEqual(Math.round(base * (1 + JITTER)));
          if (!clamped) expect(gap).toBeGreaterThanOrEqual(Math.round(base * (1 - JITTER)));
        }
      }),
    );
  });

  it('bounces exactly at 5 days, never before', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (r) => {
        const { times, bouncedAt } = walk(() => r);
        expect(bouncedAt).toBe(T0.getTime() + MAX_QUEUE_AGE_MS);
        for (const t of times.slice(0, -1)) expect(t).toBeLessThan(T0.getTime() + MAX_QUEUE_AGE_MS);
      }),
    );
  });

  it('a temporary failure at any age under 5 days defers, at or over bounces', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 * DAY }), fc.integer({ min: 1, max: 100 }), (age, attempts) => {
        const t = nextState(recipient({ attempts }), { kind: 'error', error: 'connect ECONNREFUSED' }, new Date(T0.getTime() + age), () => 0.5);
        if (age < MAX_QUEUE_AGE_MS) {
          expect(t.state).toBe('deferred');
          expect(t.attemptOutcome).toBe('error');
          expect(t.nextAttemptAt.getTime()).toBeGreaterThan(T0.getTime() + age);
          expect(t.nextAttemptAt.getTime()).toBeLessThanOrEqual(T0.getTime() + MAX_QUEUE_AGE_MS);
        } else {
          expect(t.state).toBe('bounced');
        }
      }),
    );
  });

  it('2xx delivers and 5xx bounces at once', () => {
    const ok = nextState(recipient(), { kind: 'delivered', code: 250, text: 'ok' }, T0);
    expect(ok.state).toBe('delivered');
    expect(ok.deliveredAt).toEqual(T0);
    expect(ok.dsn).toEqual([]);
    const no = nextState(recipient(), { kind: 'permanent', code: 550, enhanced: '5.1.1', text: 'no such user' }, T0);
    expect(no.state).toBe('bounced');
    expect(no.lastCode).toBe(550);
    expect(no.dsn.map((d) => [d.kind, d.reason])).toEqual([['failure', 'permanent']]);
  });
});

describe('DSN intents', () => {
  it('emits one delay DSN at ≥ 4 hours and one failure DSN at the bounce (default NOTIFY)', () => {
    const { dsn } = walk(() => 0.5);
    expect(dsn).toEqual(['delay', 'failure']);
  });

  it('no delay DSN before 4 hours', () => {
    const t = nextState(recipient(), temp, new Date(T0.getTime() + DELAY_DSN_AFTER_MS - 1));
    expect(t.dsn).toEqual([]);
    const u = nextState(recipient(), temp, new Date(T0.getTime() + DELAY_DSN_AFTER_MS));
    expect(u.dsn.map((d) => d.kind)).toEqual(['delay']);
  });

  it('never emits a DSN already marked sent', () => {
    const at = new Date(T0.getTime() + 5 * HOUR);
    expect(nextState(recipient({ delayDsnSentAt: at }), temp, at).dsn).toEqual([]);
    expect(nextState(recipient({ failureDsnSentAt: at }), { kind: 'permanent', code: 550, text: 'no' }, at).dsn).toEqual([]);
  });

  it.each([
    ['NEVER', []],
    ['SUCCESS', []],
    ['FAILURE', ['failure']],
    ['DELAY', ['delay']],
    ['FAILURE,DELAY', ['delay', 'failure']],
    ['success,failure', ['failure']],
    [null, ['delay', 'failure']],
  ] as const)('NOTIFY=%s → %j', (notify, expected) => {
    expect(walk(() => 0.5, notify).dsn).toEqual(expected);
  });

  it('parses NOTIFY', () => {
    expect(parseNotify(null)).toEqual({ success: false, failure: true, delay: true });
    expect(parseNotify('NEVER')).toEqual({ success: false, failure: false, delay: false });
    expect(parseNotify('SUCCESS,DELAY')).toEqual({ success: true, failure: false, delay: true });
  });
});

describe('cancel', () => {
  it('only queued and deferred can be cancelled', () => {
    expect(canCancel('queued')).toBe(true);
    expect(canCancel('deferred')).toBe(true);
    for (const s of ['attempting', 'delivered', 'bounced', 'cancelled'] as const) expect(canCancel(s)).toBe(false);
  });
});
