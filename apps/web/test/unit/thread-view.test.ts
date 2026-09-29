// PST-T-14.6 (PST-ADR-011; design audit VIS-06, VIS-07, CPY-01, CPY-02, MOD-I4, INT-I7): the calm
// thread view. The pure rules — which toolbar a mailbox gets, what a one-line header says, which
// states earn a chip and in what words — are tested directly; the toolbar, the phishing chip and a
// delivery row are rendered to a string with react-dom/server and plain @d3cloud/ui stand-ins. The
// browser behaviour (tooltips on hover and focus, the ⋯ menu, the drawer, axe) is
// e2e/tests/thread-and-delivery.spec.ts, inspect.spec.ts and phish-banner.spec.ts.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryRecipient, Mailbox, MessageDetail, PhishWarning, SpecialUse } from '../../src/api';

vi.mock('@d3cloud/ui', () => {
  type P = { children?: ReactNode; label?: string; content?: string; className?: string; variant?: string; disabled?: boolean; 'aria-label'?: string; 'data-tone'?: string };
  const box = (tag: string) => (p: P) => createElement(tag, { className: p.className, 'data-variant': p.variant, 'aria-label': p['aria-label'], disabled: p.disabled, 'data-tone': p['data-tone'] }, p.children);
  return {
    Badge: box('span'),
    Button: box('button'),
    IconButton: (p: P) => createElement('button', { 'aria-label': p.label, 'data-icon': 'true' }),
    Tooltip: (p: P) => createElement('span', { 'data-tooltip': p.content }, p.children),
    Menu: box('div'),
    MenuTrigger: box('span'),
    MenuContent: box('div'),
    MenuItem: (p: P) => createElement('div', { role: 'menuitem' }, p.children),
    MenuSeparator: () => null,
    Modal: () => null,
    ModalClose: box('span'),
  };
});

const MAILBOXES: Mailbox[] = (['inbox', 'sent', 'drafts', 'junk', 'rejects', 'archive', 'trash'] as SpecialUse[]).map((use) => ({
  id: `mb-${use}`,
  name: use === 'inbox' ? 'INBOX' : use,
  specialUse: use,
  total: 0,
  unseen: 0,
})) as unknown as Mailbox[];

vi.mock('../../src/mail/MailContext', () => ({
  useMail: () => ({ mailboxes: MAILBOXES, me: 'operator@d3cloud.io', refreshMailboxes: () => Promise.resolve(), subscribe: () => () => undefined, live: true, mailboxesFailed: false }),
}));

const { toolbarModel, recipientSummary, relativeDate, senderName, phishChip, phishLead, phishAdvice, deliveryChipTone, deliverySentence, tooltipText } = await import('../../src/mail/thread/view');
const { ThreadToolbar } = await import('../../src/mail/thread/ThreadToolbar');
const { PhishChip } = await import('../../src/mail/thread/ExceptionChip');
const { DeliveryRecipientRow } = await import('../../src/mail/DeliveryRows');

function detail(use: SpecialUse, over: Partial<MessageDetail> = {}): MessageDetail {
  return {
    id: 'm-1',
    mailboxId: `mb-${use}`,
    uid: 1,
    modseq: '1',
    threadId: null,
    subject: 'Hello',
    from: 'priya.shah@gmail.com',
    date: '2026-09-26T12:30:00Z',
    internalDate: '2026-09-26T12:30:00Z',
    size: 10,
    flags: [],
    bucket: null,
    messageIdHeader: null,
    inReplyTo: null,
    references: [],
    verdict: null,
    phish: null,
    ...over,
  };
}

const toolbar = (use: SpecialUse, extra: { onMoveTo?: boolean; onEditDraft?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(ThreadToolbar, {
      detail: detail(use),
      canArchive: true,
      canTrash: true,
      onAction: () => undefined,
      onMoveTo: extra.onMoveTo === false ? undefined : () => undefined,
      onEditDraft: extra.onEditDraft === true ? () => undefined : undefined,
      snooze: createElement('button', { 'aria-label': 'Snooze' }),
    }),
  );

/** The visible order of labelled buttons and icon buttons' names in the toolbar markup. */
function controls(html: string): string[] {
  const out: string[] = [];
  const re = /<button([^>]*)>([^<]*)<\/button>/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const label = /aria-label="([^"]*)"/.exec(m[1] ?? '')?.[1];
    out.push(m[2] !== '' ? (m[2] ?? '') : `[${label ?? '?'}]`);
  }
  return out;
}

describe('the reading toolbar (VIS-06, INT-I7)', () => {
  it('in Inbox: Reply is the one primary, Archive and Delete labelled, the rest icons, then ⋯', () => {
    const html = toolbar('inbox');
    expect(controls(html)).toEqual(['Reply', 'Archive', 'Delete', '[Reply all]', '[Forward]', '[Snooze]', '[More actions]']);
    expect(html).toMatch(/data-variant="primary"[^>]*>Reply</);
    expect(html.match(/data-variant="primary"/g)).toHaveLength(1);
  });

  it('gives every icon button a tooltip that names it and its key', () => {
    const html = toolbar('inbox');
    expect(html).toContain('data-tooltip="Reply all (a)"');
    expect(html).toContain('data-tooltip="Forward (f)"');
    expect(html).toContain('More actions');
    expect(tooltipText('Forward', undefined)).toBe('Forward');
  });

  it('puts the rare actions in ⋯: Move to…, Mark unread, Star, Inspect message (i), Show original, Print', () => {
    const html = toolbar('inbox');
    const items = [...html.matchAll(/role="menuitem">(.*?)<\/div>/g)].map((m) => (m[1] ?? '').replace(/<kbd[^>]*>[^<]*<\/kbd>/g, '').replace(/<[^>]+>/g, ''));
    expect(items).toEqual(['Move to…', 'Mark unread', 'Star', 'Inspect message', 'Show original', 'Print']);
    expect(html).toMatch(/Inspect message<\/span><kbd[^>]*aria-hidden="true"[^>]*>i<\/kbd>/);
    expect(html).toContain('href="/api/messages/m-1/raw"');
  });

  it('in Sent: nothing is filled and Reply joins the icons', () => {
    expect(controls(toolbar('sent'))).toEqual(['Archive', 'Delete', '[Reply]', '[Reply all]', '[Forward]', '[More actions]']);
    expect(toolbar('sent')).not.toContain('data-variant="primary"');
  });

  it('in Junk leads with Not junk, in Rejected with Rescue, in Drafts with Edit draft', () => {
    expect(controls(toolbar('junk'))[0]).toBe('Not junk');
    expect(controls(toolbar('rejects'))[0]).toBe('Rescue');
    expect(controls(toolbar('drafts', { onEditDraft: true }))[0]).toBe('Edit draft');
    expect(toolbarModel('junk').lead).toBe('notJunk');
    expect(toolbarModel('rejects').lead).toBe('rescue');
    expect(toolbarModel('drafts').lead).toBe('editDraft');
    expect(toolbarModel(null).lead).toBe('reply');
  });

  it('never shows Not junk or Rescue it cannot carry out', () => {
    expect(controls(toolbar('junk', { onMoveTo: false }))).not.toContain('Not junk');
    expect(controls(toolbar('drafts'))).not.toContain('Edit draft');
  });
});

describe('the one-line header (VIS-07, MOD-I4)', () => {
  it('says "to me, …" with me first and the others by name', () => {
    expect(recipientSummary('Matt Demers <operator@d3cloud.io>', 'Jonah Reyes <jonah.reyes@fastmail.com>', 'operator@d3cloud.io')).toBe('to me, Jonah Reyes');
    expect(recipientSummary('Ben Carter <ben.carter@example.org>', null, 'operator@d3cloud.io')).toBe('to Ben Carter');
    expect(recipientSummary('a@x.test, OPERATOR@d3cloud.io', null, 'operator@d3cloud.io')).toBe('to me, a@x.test');
    expect(recipientSummary('a@x.test, b@x.test, c@x.test, d@x.test', null, null)).toBe('to a@x.test, b@x.test, c@x.test +1');
    expect(recipientSummary(null, null, 'operator@d3cloud.io')).toBeNull();
  });

  it('names the sender, or says there is none', () => {
    expect(senderName('"Shah, Priya" <priya.shah@gmail.com>')).toBe('Shah, Priya');
    expect(senderName('priya.shah@gmail.com')).toBe('priya.shah@gmail.com');
    expect(senderName('')).toBe('(unknown sender)');
  });

  it('dates relatively, with the absolute date a hover away', () => {
    const now = new Date(2026, 8, 29, 12, 0);
    expect(relativeDate(new Date(2026, 8, 29, 11, 59, 40).toISOString(), now)).toBe('just now');
    expect(relativeDate(new Date(2026, 8, 29, 11, 15).toISOString(), now)).toBe('45 min ago');
    expect(relativeDate(new Date(2026, 8, 29, 7, 0).toISOString(), now)).toBe('5 hr ago');
    expect(relativeDate(new Date(2026, 8, 28, 9, 0).toISOString(), now)).toBe('yesterday');
    expect(relativeDate(new Date(2026, 8, 26, 8, 30).toISOString(), now)).toBe('3 days ago');
    expect(relativeDate(new Date(2026, 7, 1).toISOString(), now, 'en-US')).toBe('Aug 1');
    expect(relativeDate('not a date', now)).toBe('');
  });
});

describe('exception chips (CPY-01, CPY-02)', () => {
  const w = (kind: PhishWarning['kind'], severity: PhishWarning['severity'], reason = `${kind} reason`): PhishWarning => ({ kind, severity, reason });

  it('a spoof is a danger chip with a plain sentence; a medium one asks for attention', () => {
    expect(phishChip([w('auth-failure', 'high')])).toEqual({ tone: 'danger', label: 'Unverified sender — looks spoofed' });
    expect(phishChip([w('first-time-brand-sender', 'medium')])?.tone).toBe('attention');
    expect(phishChip([])).toBeNull();
    expect(phishLead([w('auth-failure', 'high')], 'account-update@amazon.com')).toBe('This claims to be from amazon.com, but amazon.com says it didn’t send it.');
    expect(phishAdvice([w('auth-failure', 'high')])).toMatch(/^Don’t open its links or reply/);
  });

  it('renders the chip, the sentence, every reason, and Details — as an alert when high', () => {
    const html = renderToStaticMarkup(
      createElement(PhishChip, {
        phish: { warnings: [w('link-mismatch', 'low', 'SPF failed for amazon.com'), w('auth-failure', 'high', 'DMARC failed for amazon.com')] },
        from: 'account-update@amazon.com',
        inJunk: true,
        onMoveToJunk: () => undefined,
        onDetails: () => undefined,
      }),
    );
    expect(html).toContain('Unverified sender — looks spoofed');
    expect(html).toContain('role="alert"');
    expect(html.indexOf('DMARC failed')).toBeLessThan(html.indexOf('SPF failed'));
    expect(html).toContain('aria-label="Details: inspect this message"');
    expect(html).not.toContain('Move to Junk'); // already in Junk
  });

  it('never has a positive chip: a clean message renders nothing', () => {
    const html = renderToStaticMarkup(createElement(PhishChip, { phish: { warnings: [] }, from: 'a@b.test', inJunk: false, onMoveToJunk: undefined, onDetails: undefined }));
    expect(html).toBe('');
    expect(html).not.toMatch(/verified/i);
  });

  it('only deferred and bounced deliveries are exceptions, each followed by one plain sentence', () => {
    expect(deliveryChipTone('bounced')).toBe('danger');
    expect(deliveryChipTone('deferred')).toBe('attention');
    for (const s of ['delivered', 'queued', 'attempting', 'cancelled'] as const) expect(deliveryChipTone(s)).toBeNull();
    expect(deliverySentence({ state: 'bounced', address: 'ben.carter@example.org' })).toBe('This never reached ben.carter@example.org. Check the address, then send it again.');
    expect(deliverySentence({ state: 'deferred', address: 'office@hollispm.test' })).toMatch(/^hollispm\.test isn’t accepting it yet\./);
    expect(deliverySentence({ state: 'delivered', address: 'x@y.test' })).toBeNull();
  });

  it('draws a bounced row as a chip and a delivered one as a quiet line', () => {
    const base: DeliveryRecipient = {
      id: 'r-1',
      address: 'ben.carter@example.org',
      state: 'bounced',
      attempts: 1,
      nextAttemptAt: '2026-09-28T16:00:00Z',
      lastCode: 550,
      lastEnhanced: '5.1.10',
      lastText: 'null MX',
      deliveredAt: null,
      dsn: { delaySentAt: null, failureSentAt: null },
      transport: 'direct',
      attemptsLog: [],
    };
    const row = (r: DeliveryRecipient) => renderToStaticMarkup(createElement('ul', null, createElement(DeliveryRecipientRow, { recipient: r, now: new Date('2026-09-28T12:00:00Z') })));
    const bounced = row(base);
    expect(bounced).toContain('class="pr-chip pr-chip--line" data-tone="danger"');
    expect(bounced).toContain('This never reached ben.carter@example.org.');
    const delivered = row({ ...base, state: 'delivered' });
    expect(delivered).not.toContain('pr-chip');
    expect(delivered).toMatch(/data-testid="delivery-state"[^>]*>Delivered</);
  });
});
