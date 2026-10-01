// PST-T-14.1 (design audit CPY-01): the reading view's Delivery block says what happened in plain
// words and never renders the remote server's raw reply; the evidence (reply codes, reply text, the
// attempt log) is rendered only by DeliveryEvidence, which lives in the Details/Inspect sheet.
// Rendered to a string with react-dom/server, like inspect.test.ts.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryRecipient, MessageBody } from '../../src/api';
import { cancelledSentence } from '../../src/mail/delivery';
import { DeliveryEvidence, DeliveryRecipientRow, DeliverySkeleton } from '../../src/mail/DeliveryRows';
import { canResend, queuePath, resendDraftInput, resendNotes, resendTargets } from '../../src/mail/resend';
import { deliverySentence } from '../../src/mail/thread/view';

vi.mock('@d3cloud/ui', () => {
  const box = (tag: string) => (props: { children?: ReactNode }) => createElement(tag, null, props.children);
  return {
    Badge: box('span'),
    Button: (props: { children?: ReactNode; 'aria-label'?: string }) => createElement('button', { 'aria-label': props['aria-label'] }, props.children),
    Skeleton: () => createElement('div', { 'data-skeleton': 'true' }),
  };
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

// --- PST-T-16.14 (PST-DA-024): delivery problems lead somewhere ------------------------------------------

const CANCELLED_AT = '2026-09-28T15:40:00';
const NOW = new Date('2026-09-28T18:00:00');
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function cancelled(over: Partial<DeliveryRecipient> & { updatedAt?: string | null } = {}) {
  return recipient({ state: 'cancelled', lastCode: null, lastEnhanced: null, lastText: null, attemptsLog: [], dsn: { delaySentAt: null, failureSentAt: null }, ...over });
}

const withRouter = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement('ul', null, el)));

describe('the cancelled sentence', () => {
  it('reads the reason and the time when you canceled it', () => {
    expect(cancelledSentence({ lastText: null, updatedAt: CANCELLED_AT }, NOW, 'en-US')).toBe(`You canceled it at ${timeOf(CANCELLED_AT)}, so it was never sent.`);
  });

  it('names an admin and their reason when the queue row was deleted', () => {
    expect(cancelledSentence({ lastText: 'deleted by admin: sent to the wrong list.', updatedAt: CANCELLED_AT }, NOW, 'en-US')).toBe(
      `An admin canceled it at ${timeOf(CANCELLED_AT)}: sent to the wrong list.`,
    );
    expect(cancelledSentence({ lastText: 'deleted by admin: ', updatedAt: CANCELLED_AT }, NOW, 'en-US')).toBe(`An admin canceled it at ${timeOf(CANCELLED_AT)}, so it was never sent.`);
  });

  it('says no time rather than inventing one', () => {
    expect(cancelledSentence({ lastText: null, updatedAt: null }, NOW)).toBe('You canceled it, so it was never sent.');
    expect(cancelledSentence({}, NOW)).toBe('You canceled it, so it was never sent.');
  });

  it('is the cancelled row’s sentence in the reading view, and only a cancelled one’s', () => {
    expect(deliverySentence({ state: 'cancelled', address: 'a@example.org', updatedAt: CANCELLED_AT }, NOW, 'en-US')).toContain('You canceled it at ');
    expect(deliverySentence({ state: 'delivered', address: 'a@example.org', updatedAt: CANCELLED_AT }, NOW)).toBeNull();
    const html = withRouter(createElement(DeliveryRecipientRow, { recipient: cancelled({ updatedAt: CANCELLED_AT }), now: NOW }));
    expect(html).toMatch(/pr-exception__sentence">You canceled it at [^<]+, so it was never sent\.</);
    expect(html).toContain('Canceled — not sent');
    // A cancelled recipient is neutral (D-016): no exception chip.
    expect(html).toContain('data-exception="false"');
  });
});

describe('Edit and resend', () => {
  const onResend = () => undefined;

  it('is offered to bounced and cancelled recipients, and to no one else', () => {
    for (const state of ['bounced', 'cancelled'] as const) {
      expect(canResend(state)).toBe(true);
      expect(withRouter(createElement(DeliveryRecipientRow, { recipient: recipient({ state }), now: NOW, onResend }))).toContain('Edit and resend');
    }
    for (const state of ['queued', 'attempting', 'deferred', 'delivered'] as const) {
      expect(canResend(state)).toBe(false);
      expect(withRouter(createElement(DeliveryRecipientRow, { recipient: recipient({ state }), now: NOW, onResend }))).not.toContain('Edit and resend');
    }
    // No handler, no button.
    expect(withRouter(createElement(DeliveryRecipientRow, { recipient: recipient(), now: NOW }))).not.toContain('Edit and resend');
  });

  it('prefills the same Subject and body, to just the failed address for a bounce', () => {
    const recipients = [recipient({ address: 'ben@example.org' }), recipient({ id: 'r-2', address: 'amy@example.org', state: 'delivered' })];
    const to = resendTargets(recipients, recipients[0] as DeliveryRecipient);
    expect(to).toEqual(['ben@example.org']);
    expect(resendDraftInput({ subject: 'Lease renewal', text: 'Hi Ben,\n\nThe lease is attached.\n' }, to)).toEqual({
      to: ['ben@example.org'],
      cc: [],
      bcc: [],
      subject: 'Lease renewal',
      text: 'Hi Ben,\n\nThe lease is attached.\n',
      inReplyTo: null,
      references: [],
      forwardOf: null,
      mode: null,
      sourceId: null,
    });
  });

  it('prefills every cancelled recipient for a cancelled one, and not the ones that were delivered', () => {
    const recipients = [
      cancelled({ id: 'r-1', address: 'ben@example.org' }),
      cancelled({ id: 'r-2', address: 'Amy@example.org' }),
      cancelled({ id: 'r-3', address: 'amy@example.org' }),
      recipient({ id: 'r-4', address: 'cy@example.org', state: 'delivered' }),
    ];
    expect(resendTargets(recipients, recipients[0] as DeliveryRecipient)).toEqual(['ben@example.org', 'Amy@example.org']);
    expect(resendDraftInput({ subject: null, text: null }, ['a@example.org'])).toMatchObject({ subject: '', text: '' });
  });

  it('says what it leaves behind instead of dropping it silently', () => {
    const body = (over: Partial<Pick<MessageBody, 'text' | 'textTruncated' | 'html' | 'attachments'>>) => ({ text: 'x', textTruncated: false, html: null, attachments: [], ...over });
    const att = { partId: '2', contentType: 'application/pdf', filename: 'a.pdf', disposition: 'attachment', contentId: null, size: 1, sha256: 'x', inMessage: null };
    expect(resendNotes(null)).toEqual([]);
    expect(resendNotes(body({}))).toEqual([]);
    expect(resendNotes(body({ attachments: [att] }))).toEqual(['The attachment isn’t copied. Add it again in the composer.']);
    expect(resendNotes(body({ attachments: [att, att] }))).toEqual(['Attachments aren’t copied. Add them again in the composer.']);
    expect(resendNotes(body({ text: null, html: '<p>hi</p>' }))).toEqual(['Only the plain text is copied, and this message has none.']);
    expect(resendNotes(body({ textTruncated: true }))).toEqual(['This message is long, so only the start of it is copied.']);
  });
});

describe('the link to the queue row', () => {
  it('filters the admin queue to the message', () => {
    expect(queuePath('3f1c')).toBe('/admin/queue?message=3f1c');
    const html = withRouter(createElement(DeliveryRecipientRow, { recipient: recipient({ state: 'delivered' }), now: NOW, queueTo: queuePath('3f1c') }));
    expect(html).toContain('href="/admin/queue?message=3f1c"');
    expect(html).toContain('View in queue');
  });

  it('is not rendered for anyone else', () => {
    expect(withRouter(createElement(DeliveryRecipientRow, { recipient: recipient(), now: NOW, queueTo: null }))).not.toContain('/admin/queue');
    expect(withRouter(createElement(DeliveryRecipientRow, { recipient: recipient(), now: NOW }))).not.toContain('View in queue');
  });
});

describe('the section while it loads', () => {
  it('is a one-line busy skeleton, not nothing', () => {
    const html = renderToStaticMarkup(createElement(DeliverySkeleton));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Delivery"');
    expect(html).toContain('data-skeleton="true"');
  });
});
