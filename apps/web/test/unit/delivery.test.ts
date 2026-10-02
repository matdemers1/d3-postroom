// PST-T-6.4, PST-REQ-119: ReadingPane's delivery timeline. State labels/tones, the deferral
// sentence, the next-retry countdown and an attempt's summary are pure and tested here.
import { describe, expect, it } from 'vitest';
import type { DeliveryAttemptView, DeliveryRecipient } from '../../src/api';
import {
  attemptRemoteText,
  attemptSummary,
  bounceReason,
  deferralReason,
  deliveryLine,
  deliveryPhase,
  dsnFiledAt,
  isPending,
  NO_DELIVERY_RECORD_TEXT,
  relativeMinutes,
  retryTime,
  STATE_LABEL,
  STATE_TONE,
} from '../../src/mail/delivery';

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
      expect(['neutral', 'warning', 'danger']).toContain(STATE_TONE[state]);
    }
  });

  it('flags a deferral for attention, and a bounce as danger', () => {
    expect(STATE_TONE.deferred).toBe('warning');
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

describe('deliveryPhase (PST-T-6.7, PST-REQ-119)', () => {
  it('shows the explicit no-record note when the lookup found nothing', () => {
    expect(deliveryPhase(null)).toBe('no-record');
  });

  it('goes on to fetch the real timeline when the lookup found a linked row', () => {
    expect(deliveryPhase('outbound-1')).toBe('lookup');
  });

  it('has a stated, non-empty no-record note', () => {
    expect(NO_DELIVERY_RECORD_TEXT.length).toBeGreaterThan(0);
    expect(NO_DELIVERY_RECORD_TEXT).toContain('No delivery record');
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

// PST-T-14.1 (design audit CPY-01): the calm reading view's one line per recipient.
describe('deliveryLine (plain language, never the raw reply)', () => {
  const now = new Date(2026, 8, 26, 12, 0, 0);

  it('says Delivered, and nothing the remote server wrote', () => {
    const line = deliveryLine(recipient({ state: 'delivered', lastCode: 250, lastEnhanced: '2.0.0', lastText: 'OK (e2e stub: no real MX was contacted)' }), now);
    expect(line).toBe('Delivered');
  });

  it('says when a deferred recipient is retried, as a time', () => {
    const at = new Date(2026, 8, 26, 15, 40, 0).toISOString();
    expect(deliveryLine(recipient({ state: 'deferred', nextAttemptAt: at, lastCode: 451, lastText: 'greylisted' }), now, 'en-US')).toBe('Retrying at 3:40 PM');
  });

  it('names a bounce by its reason in words', () => {
    expect(deliveryLine(recipient({ state: 'bounced', lastCode: 550, lastEnhanced: '5.1.1', lastText: 'No such user' }), now)).toBe('Bounced — address doesn’t exist');
    expect(deliveryLine(recipient({ state: 'bounced', lastCode: 550, lastEnhanced: '5.1.10', lastText: 'Recipient address rejected: example.org publishes a null MX (RFC 7505)' }), now)).toBe(
      'Bounced — that domain doesn’t accept mail',
    );
  });

  it('never contains a reply code, an enhanced status or the remote text, in any state', () => {
    const raw = { lastCode: 550, lastEnhanced: '5.7.1', lastText: 'e2e stub: rejected by policy xyzzy' };
    for (const state of Object.keys(STATE_LABEL) as DeliveryRecipient['state'][]) {
      const line = deliveryLine(recipient({ state, ...raw }), now, 'en-US');
      expect(line).not.toMatch(/550|5\.7\.1|xyzzy|e2e stub/);
    }
  });

  it('has a line for every state', () => {
    expect(deliveryLine(recipient({ state: 'queued' }), now)).toBe('Waiting to send');
    expect(deliveryLine(recipient({ state: 'attempting' }), now)).toBe('Sending now');
    expect(deliveryLine(recipient({ state: 'cancelled' }), now)).toBe('Canceled — not sent');
  });
});

describe('bounceReason', () => {
  it('reads the enhanced status code first', () => {
    expect(bounceReason({ lastCode: 552, lastEnhanced: '5.2.2', lastText: 'over quota' })).toBe('the mailbox is full');
    expect(bounceReason({ lastCode: 550, lastEnhanced: '5.1.2', lastText: 'host not found' })).toBe('that domain doesn’t exist');
  });

  it('falls back to the reply text, then the code', () => {
    expect(bounceReason({ lastCode: 550, lastEnhanced: null, lastText: 'User unknown in virtual mailbox table' })).toBe('address doesn’t exist');
    expect(bounceReason({ lastCode: 554, lastEnhanced: null, lastText: 'go away' })).toBe('the receiving server refused it');
    expect(bounceReason({ lastCode: null, lastEnhanced: null, lastText: 'FCrDNS not yet valid: EDGE_PUBLIC_IP is not set' })).toBe('it couldn’t be delivered');
  });
});

describe('retryTime', () => {
  const now = new Date(2026, 8, 26, 12, 0, 0);
  it('is a bare time today, a weekday and time this week, a date later', () => {
    expect(retryTime(new Date(2026, 8, 26, 15, 40).toISOString(), now, 'en-US')).toBe('3:40 PM');
    expect(retryTime(new Date(2026, 8, 28, 9, 5).toISOString(), now, 'en-US')).toBe('Mon 9:05 AM');
    expect(retryTime(new Date(2026, 9, 20, 9, 5).toISOString(), now, 'en-US')).toMatch(/^Oct 20/);
  });
});
