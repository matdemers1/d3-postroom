// PST-T-6.4, PST-REQ-119: ReadingPane's delivery timeline. State labels/tones, the deferral
// sentence, the next-retry countdown and an attempt's summary are pure and tested here.
import { describe, expect, it } from 'vitest';
import type { DeliveryAttemptView, DeliveryRecipient } from '../../src/api';
import { attemptRemoteText, attemptSummary, deferralReason, dsnFiledAt, isPending, relativeMinutes, STATE_LABEL, STATE_TONE } from '../../src/mail/delivery';

function recipient(over: Partial<DeliveryRecipient> = {}): DeliveryRecipient {
  return {
    id: 'r-1',
    address: 'bob@example.org',
    state: 'queued',
    attempts: 0,
    nextAttemptAt: '2026-09-26T12:00:00Z',
    lastCode: null,
    lastEnhanced: null,
    lastText: null,
    deliveredAt: null,
    dsn: { delaySentAt: null, failureSentAt: null },
    transport: 'direct',
    attemptsLog: [],
    ...over,
  };
}

function attempt(over: Partial<DeliveryAttemptView> = {}): DeliveryAttemptView {
  return {
    startedAt: '2026-09-26T11:00:00Z',
    finishedAt: '2026-09-26T11:00:01Z',
    durationMs: 1000,
    transport: 'direct',
    mxHost: null,
    mxIp: null,
    localIp: null,
    tls: { version: null, cipher: null, peer: null },
    remote: { code: null, enhanced: null, text: null },
    outcome: 'deferred',
    error: null,
    ...over,
  };
}

describe('STATE_LABEL / STATE_TONE', () => {
  it('has a label and a tone for every state', () => {
    const states: DeliveryRecipient['state'][] = ['queued', 'attempting', 'deferred', 'delivered', 'bounced', 'cancelled'];
    for (const state of states) {
      expect(STATE_LABEL[state].length).toBeGreaterThan(0);
      expect(['neutral', 'attention', 'danger']).toContain(STATE_TONE[state]);
    }
  });

  it('flags a deferral for attention, and a bounce as danger', () => {
    expect(STATE_TONE.deferred).toBe('attention');
    expect(STATE_TONE.bounced).toBe('danger');
  });
});

describe('isPending', () => {
  it('is true for anything that can still change on its own', () => {
    expect(isPending('queued')).toBe(true);
    expect(isPending('attempting')).toBe(true);
    expect(isPending('deferred')).toBe(true);
  });

  it('is false for a terminal state', () => {
    expect(isPending('delivered')).toBe(false);
    expect(isPending('bounced')).toBe(false);
    expect(isPending('cancelled')).toBe(false);
  });
});

describe('relativeMinutes', () => {
  const now = new Date('2026-09-26T12:00:00Z');

  it('counts minutes into the future', () => {
    expect(relativeMinutes('2026-09-26T12:42:00Z', now)).toBe('in 42 min');
  });

  it('counts hours into the future once past 60 minutes', () => {
    expect(relativeMinutes('2026-09-26T15:00:00Z', now)).toBe('in 3 hr');
  });

  it('says "any moment" for something due right now', () => {
    expect(relativeMinutes('2026-09-26T12:00:10Z', now)).toBe('any moment');
  });

  it('counts minutes into the past', () => {
    expect(relativeMinutes('2026-09-26T11:30:00Z', now)).toBe('30 min ago');
  });
});

describe('deferralReason', () => {
  it('is null for anything that is not deferred', () => {
    expect(deferralReason(recipient({ state: 'delivered' }))).toBeNull();
  });

  it('quotes the remote server\'s own response when there is one', () => {
    const reason = deferralReason(recipient({ state: 'deferred', lastCode: 451, lastEnhanced: '4.7.1', lastText: 'greylisted, try later' }));
    expect(reason).toBe('451 4.7.1 greylisted, try later');
  });

  it('falls back to a plain sentence with no response text', () => {
    expect(deferralReason(recipient({ state: 'deferred' }))).toBe('The remote server asked to try again later.');
  });
});

describe('attemptSummary', () => {
  it('names the transport and MX host', () => {
    expect(attemptSummary(attempt({ transport: 'direct', mxHost: 'mx.example.org' }))).toBe('Direct · mx.example.org');
  });

  it('names SES distinctly from a direct attempt', () => {
    expect(attemptSummary(attempt({ transport: 'ses' }))).toBe('SES');
  });

  it('includes the TLS version, and the peer when there is one', () => {
    expect(attemptSummary(attempt({ tls: { version: 'TLSv1.3', cipher: null, peer: null } }))).toBe('Direct · TLS TLSv1.3');
    expect(attemptSummary(attempt({ tls: { version: 'TLSv1.3', cipher: null, peer: 'mx.example.org' } }))).toBe('Direct · TLS TLSv1.3 (mx.example.org)');
  });
});

describe('attemptRemoteText', () => {
  it('is null when the remote never responded', () => {
    expect(attemptRemoteText(attempt())).toBeNull();
  });

  it('joins the code, enhanced code and text that were given', () => {
    expect(attemptRemoteText(attempt({ remote: { code: 451, enhanced: '4.7.1', text: 'greylisted' } }))).toBe('451 4.7.1 greylisted');
  });

  it('omits parts that are missing', () => {
    expect(attemptRemoteText(attempt({ remote: { code: null, enhanced: null, text: 'connection refused' } }))).toBe('connection refused');
  });
});

describe('dsnFiledAt', () => {
  it('is null when no DSN was ever filed', () => {
    expect(dsnFiledAt(recipient())).toBeNull();
  });

  it('prefers the failure DSN over a delay DSN', () => {
    const at = dsnFiledAt(recipient({ dsn: { delaySentAt: '2026-09-26T10:00:00Z', failureSentAt: '2026-09-26T11:00:00Z' } }));
    expect(at).toBe('2026-09-26T11:00:00Z');
  });

  it('falls back to the delay DSN when there is no failure', () => {
    const at = dsnFiledAt(recipient({ dsn: { delaySentAt: '2026-09-26T10:00:00Z', failureSentAt: null } }));
    expect(at).toBe('2026-09-26T10:00:00Z');
  });
});
