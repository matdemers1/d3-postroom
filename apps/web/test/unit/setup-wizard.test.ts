// PST-T-4.8's pure web helpers: the wizard's progress, the DNS summary line, and a delivery turned
// into the timeline the wizard's last step shows.
import { describe, expect, it } from 'vitest';
import { dnsSummary, settled, timelineOf, wizardReachable, wizardStepsLeft, type DeliveryView, type WizardView } from '../../src/api';

const wizard = (over: Partial<WizardView>): WizardView => ({
  step: 'domain',
  completed: false,
  completedAt: null,
  domain: null,
  suggestedDomain: 'd3cloud.io',
  dkim: [],
  dnsAcknowledgedAt: null,
  mailbox: null,
  addresses: [],
  test: null,
  ...over,
});

describe('wizard progress', () => {
  it('counts the steps left, and none once completed', () => {
    expect(wizardStepsLeft(wizard({ step: 'domain' }))).toBe(5);
    expect(wizardStepsLeft(wizard({ step: 'dns' }))).toBe(3);
    expect(wizardStepsLeft(wizard({ step: 'test' }))).toBe(1);
    expect(wizardStepsLeft(wizard({ step: 'done', completed: true }))).toBe(0);
  });

  it('opens a step only once it is reached', () => {
    const v = wizard({ step: 'dns' });
    expect(wizardReachable(v, 'domain')).toBe(true);
    expect(wizardReachable(v, 'dns')).toBe(true);
    expect(wizardReachable(v, 'mailbox')).toBe(false);
  });
});

describe('DNS summary', () => {
  it('leaves out zero counts and names failures before pending', () => {
    expect(dnsSummary({ pass: 8, fail: 1, missing: 0, pending: 5, unknown: 0 })).toBe('8 pass · 1 fail · 5 pending');
    expect(dnsSummary({ pass: 0, fail: 0, missing: 0, pending: 0, unknown: 0 })).toBe('No records');
  });
});

describe('delivery timeline', () => {
  const view: DeliveryView = {
    message: { id: 'm', subject: 'Postroom test message', headerFrom: 'postmaster@d3cloud.io', messageId: '<x@d3cloud.io>', createdAt: '2026-09-26T10:00:00.000Z', size: 1234 },
    recipients: [
      {
        id: 'r',
        address: 'someone@example.net',
        state: 'delivered',
        lastEnhanced: null,
        dsn: { delaySentAt: null, failureSentAt: null },
        attempts: 2,
        nextAttemptAt: '2026-09-26T10:01:00.000Z',
        lastCode: 250,
        lastText: '2.0.0 OK queued',
        deliveredAt: '2026-09-26T10:01:02.000Z',
        transport: 'direct',
        attemptsLog: [
          {
            startedAt: '2026-09-26T10:00:01.000Z',
            finishedAt: '2026-09-26T10:00:02.000Z',
            durationMs: 1000,
            transport: 'direct',
            mxHost: 'mx.example.net',
            mxIp: '192.0.2.25',
            localIp: null,
            tls: { version: null, cipher: null, peer: null },
            remote: { code: 451, enhanced: '4.7.1', text: 'greylisted' },
            outcome: 'deferred',
            error: null,
          },
          {
            startedAt: '2026-09-26T10:01:00.000Z',
            finishedAt: '2026-09-26T10:01:02.000Z',
            durationMs: 2000,
            transport: 'direct',
            mxHost: 'mx.example.net',
            mxIp: '192.0.2.25',
            localIp: null,
            tls: { version: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', peer: 'mx.example.net' },
            remote: { code: 250, enhanced: '2.0.0', text: 'OK queued' },
            outcome: 'delivered',
            error: null,
          },
        ],
      },
    ],
  };

  it('is queued, each attempt with MX, TLS and the remote reply, then the outcome', () => {
    const recipient = view.recipients[0];
    if (recipient === undefined) throw new Error('no recipient');
    const events = timelineOf(view, recipient);
    expect(events.map((e) => e.title)).toEqual([
      'Accepted and queued',
      'Attempt via direct to mx.example.net (192.0.2.25): deferred',
      'Attempt via direct to mx.example.net (192.0.2.25): delivered',
      'Delivered to someone@example.net',
    ]);
    expect(events[1]?.detail).toBe('no TLS · 451 4.7.1 greylisted');
    expect(events[1]?.tone).toBe('attention');
    expect(events[2]?.detail).toBe('TLSv1.3 TLS_AES_256_GCM_SHA384 · 250 2.0.0 OK queued');
  });

  it('knows when polling can stop', () => {
    expect(settled('delivered')).toBe(true);
    expect(settled('bounced')).toBe(true);
    expect(settled('deferred')).toBe(false);
    expect(settled('queued')).toBe(false);
  });
});
