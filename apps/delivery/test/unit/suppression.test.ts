// PST-T-11.10 / PST-REQ-176: which attempt results put an address on the suppression list. Only a
// permanent 5xx whose enhanced code is in class 5.1 (the address is bad), and only when the machine
// bounced because of it — never an expiry, a 4xx, a 5.7.x policy refusal or a bare 5xx.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_QUEUE_AGE_MS, nextState, type AttemptOutcome, type RecipientSnapshot } from '../../src/state.js';
import { shouldSuppress, suppressionKey } from '../../src/suppression.js';

const T0 = new Date('2026-09-25T00:00:00Z');

function recipient(over: Partial<RecipientSnapshot> = {}): RecipientSnapshot {
  return { id: 'r1', outboundMessageId: 'm1', address: 'a@example.com', attempts: 1, createdAt: T0, dsnNotify: null, delayDsnSentAt: null, failureDsnSentAt: null, ...over };
}

/** The policy as the worker applies it: through nextState, at `now`. */
function suppresses(outcome: AttemptOutcome, now: Date = new Date(T0.getTime() + 60_000)): boolean {
  return shouldSuppress(outcome, nextState(recipient(), outcome, now, () => 0.5));
}

const permanent = (code: number, enhanced: string | undefined, text = 'no'): AttemptOutcome =>
  enhanced === undefined ? { kind: 'permanent', code, text } : { kind: 'permanent', code, enhanced, text };

describe('shouldSuppress (PST-REQ-176)', () => {
  it('suppresses a permanent 5.1.x: bad mailbox, bad domain, null MX', () => {
    expect(suppresses(permanent(550, '5.1.1', 'No such user'))).toBe(true);
    expect(suppresses(permanent(550, '5.1.2', 'no MX for example.invalid'))).toBe(true);
    expect(suppresses(permanent(556, '5.1.10', 'domain publishes a null MX'))).toBe(true);
    expect(suppresses(permanent(553, '5.1.3', 'bad address syntax'))).toBe(true);
    expect(suppresses(permanent(551, '5.1.6', 'mailbox has moved'))).toBe(true);
  });

  it('never suppresses policy (5.7.x), mailbox-full (5.2.x), system (5.3.x) or content (5.6.x) failures', () => {
    for (const enhanced of ['5.7.1', '5.7.26', '5.2.2', '5.3.4', '5.4.4', '5.6.0', '5.0.0']) {
      expect(suppresses(permanent(550, enhanced)), enhanced).toBe(false);
    }
  });

  it('never suppresses a permanent failure without an enhanced code', () => {
    expect(suppresses(permanent(550, undefined, 'User unknown'))).toBe(false);
  });

  it('never suppresses a 4xx, a connection error or a delivery, even with a 5.1-looking code', () => {
    expect(suppresses({ kind: 'temporary', code: 450, enhanced: '4.1.1', text: 'try later' })).toBe(false);
    expect(suppresses({ kind: 'temporary', code: 451, enhanced: '5.1.1', text: 'misdeclared' })).toBe(false);
    expect(suppresses({ kind: 'error', error: 'ECONNREFUSED' })).toBe(false);
    expect(suppresses({ kind: 'delivered', code: 250, enhanced: '2.1.5', text: 'ok' })).toBe(false);
  });

  it('never suppresses an expiry bounce: the queue giving up says nothing about the address', () => {
    const late = new Date(T0.getTime() + MAX_QUEUE_AGE_MS + 1);
    const outcome: AttemptOutcome = { kind: 'temporary', code: 451, enhanced: '4.1.1', text: 'still greylisted' };
    const t = nextState(recipient(), outcome, late, () => 0.5);
    expect(t.state).toBe('bounced');
    expect(t.bounceReason).toBe('expired');
    expect(shouldSuppress(outcome, t)).toBe(false);
  });

  it('only acts on a transition that bounced because the remote said so', () => {
    const outcome = permanent(550, '5.1.1');
    expect(shouldSuppress(outcome, { state: 'bounced', bounceReason: 'permanent' })).toBe(true);
    expect(shouldSuppress(outcome, { state: 'bounced', bounceReason: 'expired' })).toBe(false);
    expect(shouldSuppress(outcome, { state: 'deferred', bounceReason: null })).toBe(false);
    expect(shouldSuppress(permanent(450, '5.1.1'), { state: 'bounced', bounceReason: 'permanent' })).toBe(false);
  });

  it('property: suppresses exactly the permanent 5xx replies whose enhanced code is 5.1.<n>', () => {
    fc.assert(
      fc.property(fc.integer({ min: 500, max: 599 }), fc.integer({ min: 0, max: 9 }), fc.integer({ min: 0, max: 999 }), (code, subject, detail) => {
        const enhanced = `5.${String(subject)}.${String(detail)}`;
        expect(suppresses(permanent(code, enhanced))).toBe(subject === 1);
      }),
    );
  });
});

describe('suppressionKey', () => {
  it('is the whole address, trimmed and lowercased', () => {
    expect(suppressionKey(' Bob.Smith@Example.COM ')).toBe('bob.smith@example.com');
    expect(suppressionKey('bob@example.com')).toBe(suppressionKey('BOB@EXAMPLE.COM'));
  });
});
