// PST-T-14.1 (design audit CPY-01): the reading view's Delivery block says what happened in plain
// words and never renders the remote server's raw reply; the evidence (reply codes, reply text, the
// attempt log) is rendered only by DeliveryEvidence, which lives in the Details/Inspect sheet.
// Rendered to a string with react-dom/server, like inspect.test.ts.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryRecipient } from '../../src/api';
import { DeliveryEvidence, DeliveryRecipientRow } from '../../src/mail/DeliveryRows';

vi.mock('@d3cloud/ui', () => {
  const box = (tag: string) => (props: { children?: ReactNode }) => createElement(tag, null, props.children);
  return { Badge: box('span') };
});

const NULL_MX = 'Recipient address rejected: example.org publishes a null MX (RFC 7505)';
const STUB = 'OK (e2e stub: no real MX was contacted)';

function recipient(over: Partial<DeliveryRecipient> = {}): DeliveryRecipient {
  return {
    id: 'r-1',
    address: 'ben.carter@example.org',
    state: 'bounced',
    attempts: 2,
    nextAttemptAt: '2026-09-28T16:00:00Z',
    lastCode: 550,
    lastEnhanced: '5.1.10',
    lastText: NULL_MX,
    deliveredAt: null,
    dsn: { delaySentAt: null, failureSentAt: '2026-09-28T23:42:00Z' },
    transport: 'direct',
    attemptsLog: [
      {
        startedAt: '2026-09-28T21:37:00Z',
        finishedAt: '2026-09-28T21:37:01Z',
        durationMs: 1000,
        transport: 'direct',
        mxHost: '.',
        mxIp: null,
        localIp: null,
        tls: { version: null, cipher: null, peer: null },
        remote: { code: 550, enhanced: '5.1.10', text: NULL_MX },
        outcome: 'bounced',
        error: null,
      },
    ],
    ...over,
  };
}

const calm = (r: DeliveryRecipient) => renderToStaticMarkup(createElement('ul', null, createElement(DeliveryRecipientRow, { recipient: r, now: new Date('2026-09-28T12:00:00Z') })));

describe('the calm Delivery row', () => {
  it('says "Bounced — <plain reason>" and not the raw SMTP reply', () => {
    const html = calm(recipient());
    expect(html).toContain('Bounced — that domain doesn’t accept mail');
    expect(html).toContain('ben.carter@example.org');
    expect(html).not.toContain('550');
    expect(html).not.toContain('5.1.10');
    expect(html).not.toContain('null MX');
    expect(html).toContain('A delivery failure notice was filed to your Inbox');
  });

  it('says Delivered, and a stub transport’s text never reaches it', () => {
    const html = calm(
      recipient({
        state: 'delivered',
        lastCode: 250,
        lastEnhanced: '2.0.0',
        lastText: STUB,
        dsn: { delaySentAt: null, failureSentAt: null },
        attemptsLog: recipient().attemptsLog.map((a) => ({ ...a, remote: { code: 250, enhanced: '2.0.0', text: STUB }, outcome: 'delivered' })),
      }),
    );
    expect(html).toMatch(/data-testid="delivery-state"[^>]*>Delivered</);
    expect(html).not.toContain('e2e stub');
    expect(html).not.toContain('250');
  });

  it('says when a deferred recipient is retried, not why the server said so', () => {
    const html = calm(recipient({ state: 'deferred', lastCode: 451, lastEnhanced: '4.7.1', lastText: 'greylisted, try later', dsn: { delaySentAt: null, failureSentAt: null } }));
    expect(html).toContain('Retrying at ');
    expect(html).not.toContain('greylisted');
    expect(html).not.toContain('451');
  });
});

describe('the Delivery details (evidence)', () => {
  it('carries the raw replies and the attempt log', () => {
    const html = renderToStaticMarkup(createElement(DeliveryEvidence, { recipients: [recipient()] }));
    expect(html).toContain('550 5.1.10 ' + NULL_MX);
    expect(html).toContain('Attempts for ben.carter@example.org');
    expect(html).toContain('Delivery attempts');
  });
});
