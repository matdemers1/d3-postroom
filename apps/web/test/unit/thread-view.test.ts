// PST-T-14.6 (PST-ADR-011; design audit VIS-06, VIS-07, CPY-01, CPY-02, MOD-I4, INT-I7): the calm
// thread view. The pure rules — which toolbar a mailbox gets, what a one-line header says, which
// states earn a chip and in what words — are tested directly; the toolbar, the phishing chip and a
// delivery row are rendered to a string with react-dom/server and plain @d3cloud/ui stand-ins. The
// browser behaviour (tooltips on hover and focus, the ⋯ menu, the drawer, axe) is
// e2e/tests/thread-and-delivery.spec.ts, inspect.spec.ts and phish-banner.spec.ts.
//
// PST-T-15.3 (PST-REQ-194) drew the pane to the redesign canvas: the toolbar is ghost icon buttons
// (Archive, Delete, Move, Snooze), "n of m" with up/down, and ⋯; the subject block, the header's Star
// and Reply, the attachment card and the quick-reply bar are rendered here the same way.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryRecipient, Mailbox, MessageDetail, PhishWarning, SpecialUse } from '../../src/api';

vi.mock('@d3cloud/ui', () => {
  type P = {
    children?: ReactNode;
    label?: string;
    content?: string;
    className?: string;
    variant?: string;
    disabled?: boolean;
    pressed?: boolean;
    name?: string;
    tint?: string;
    tone?: string;
    'aria-label'?: string;
    'aria-keyshortcuts'?: string;
    'data-tone'?: string;
  };
  const box = (tag: string) => (p: P) =>
    createElement(tag, { className: p.className, 'data-variant': p.variant, 'aria-label': p['aria-label'], 'aria-keyshortcuts': p['aria-keyshortcuts'], disabled: p.disabled, 'data-tone': p['data-tone'] ?? p.tone }, p.children);
  return {
    Avatar: (p: P) => createElement('span', { className: p.className, 'data-avatar': p.name, 'data-tint': p.tint }),
    Badge: box('span'),
    Button: box('button'),
    IconButton: (p: P) => createElement('button', { 'aria-label': p.label, 'aria-keyshortcuts': p['aria-keyshortcuts'], 'aria-pressed': p.pressed, 'data-icon': 'true', disabled: p.disabled }),
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

const {
  toolbarModel,
  readingToolbar,
  positionLabel,
  positionMoves,
  quickReplyLabel,
  recipientSummary,
  relativeDate,
  senderName,
  phishChip,
  phishLead,
  phishAdvice,
  deliveryChipTone,
  deliverySentence,
  tooltipText,
} = await import('../../src/mail/thread/view');
const { ThreadToolbar } = await import('../../src/mail/thread/ThreadToolbar');
const { SubjectBlock, QuickReply, HeaderActions } = await import('../../src/mail/thread/ReadingParts');
const { AttachmentCard, AttachmentList, fileTypeLabel } = await import('../../src/mail/AttachmentCard');
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

const toolbar = (use: SpecialUse, extra: { onMoveTo?: boolean; onEditDraft?: boolean; position?: { index: number; total: number; more: boolean } | null } = {}) =>
  renderToStaticMarkup(
    createElement(ThreadToolbar, {
      detail: detail(use),
      canArchive: true,
      canTrash: true,
      onAction: () => undefined,
      onMoveTo: extra.onMoveTo === false ? undefined : () => undefined,
      onEditDraft: extra.onEditDraft === true ? () => undefined : undefined,
      snooze: createElement('button', { 'aria-label': 'Snooze' }),
      position: extra.position,
    }),
  );

/** The visible order of labelled buttons and icon buttons' names in the markup. */
function controls(html: string): string[] {
  const out: string[] = [];
  const re = /<button([^>]*)>([^<]*)<\/button>/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const label = /aria-label="([^"]*)"/.exec(m[1] ?? '')?.[1];
    out.push(m[2] !== '' ? (m[2] ?? '') : `[${label ?? '?'}]`);
  }
  return out;
}

describe('the reading toolbar (VIS-06, INT-I7; the canvas, PST-T-15.3)', () => {
  it('in Inbox: ghost icon buttons — Archive, Delete, Move, Snooze — then ⋯, and nothing filled', () => {
    const html = toolbar('inbox');
    expect(controls(html)).toEqual(['[Archive]', '[Delete]', '[Move]', '[Snooze]', '[More actions]']);
    expect(html).not.toContain('data-variant="primary"');
    expect(html).toContain('class="pr-toolbar"');
    expect(html).toContain('role="toolbar" aria-label="Message actions"');
  });

  it('gives every icon button a tooltip that names it and its key, and keeps the keys announced', () => {
    const html = toolbar('inbox');
    expect(html).toContain('data-tooltip="Archive (e)"');
    expect(html).toContain('data-tooltip="Delete (#)"');
    expect(html).toContain('data-tooltip="Move (v)"');
    expect(html).toMatch(/aria-label="Archive" aria-keyshortcuts="e"/);
    expect(html).toContain('More actions');
    expect(tooltipText('Forward', undefined)).toBe('Forward');
  });

  it('shows "n of m" with up/down wired to k/j, disabled at the ends, and hides it off the list', () => {
    const mid = toolbar('inbox', { position: { index: 2, total: 48, more: false } });
    expect(mid).toContain('data-testid="list-position">3 of 48<');
    expect(controls(mid)).toEqual(['[Archive]', '[Delete]', '[Move]', '[Snooze]', '[Previous message]', '[Next message]', '[More actions]']);
    expect(mid).toContain('data-tooltip="Previous message (k)"');
    expect(mid).toContain('data-tooltip="Next message (j)"');
    expect(mid).not.toMatch(/aria-label="(Previous|Next) message"[^>]*disabled/);
    const first = toolbar('inbox', { position: { index: 0, total: 3, more: false } });
    expect(first).toMatch(/aria-label="Previous message"[^>]*disabled/);
    expect(first).not.toMatch(/aria-label="Next message"[^>]*disabled/);
    expect(toolbar('inbox', { position: { index: -1, total: 3, more: false } })).not.toContain('list-position');
    expect(toolbar('inbox')).not.toContain('list-position');

    expect(positionLabel({ index: 0, total: 50, more: true })).toBe('1 of 50+');
    expect(positionLabel({ index: 4, total: 3, more: false })).toBeNull();
    expect(positionLabel(null)).toBeNull();
    expect(positionMoves({ index: 2, total: 3, more: false })).toEqual({ prev: true, next: false });
    expect(positionMoves({ index: -1, total: 3, more: false })).toEqual({ prev: false, next: false });
  });

  it('puts the rare actions in ⋯: Mark unread, Star, Inspect message (i), Show original, Print', () => {
    const html = toolbar('inbox');
    const items = [...html.matchAll(/role="menuitem">(.*?)<\/div>/g)].map((m) => (m[1] ?? '').replace(/<kbd[^>]*>[^<]*<\/kbd>/g, '').replace(/<[^>]+>/g, ''));
    expect(items).toEqual(['Mark unread', 'Star', 'Inspect message', 'Show original', 'Print']);
    expect(html).toMatch(/Inspect message<\/span><kbd[^>]*aria-hidden="true"[^>]*>i<\/kbd>/);
    expect(html).toContain('href="/api/messages/m-1/raw"');
  });

  it('in Sent: no Snooze; Reply, Reply all and Forward are not toolbar buttons any more', () => {
    expect(controls(toolbar('sent'))).toEqual(['[Archive]', '[Delete]', '[Move]', '[More actions]']);
    expect(toolbar('sent')).not.toContain('data-variant="primary"');
    for (const use of ['inbox', 'sent', 'junk'] as const) expect(controls(toolbar(use))).not.toContain('[Reply]');
  });

  it('in Junk leads with Not junk, in Rejected with Rescue, in Drafts with Edit draft', () => {
    expect(controls(toolbar('junk'))[0]).toBe('Not junk');
    expect(controls(toolbar('junk'))).toEqual(['Not junk', '[Delete]', '[Move]', '[More actions]']);
    expect(controls(toolbar('rejects'))[0]).toBe('Rescue');
    expect(controls(toolbar('drafts', { onEditDraft: true }))[0]).toBe('Edit draft');
    expect(readingToolbar('junk').lead).toBe('notJunk');
    expect(readingToolbar('rejects').lead).toBe('rescue');
    expect(readingToolbar('drafts').lead).toBe('editDraft');
    expect(readingToolbar(null).lead).toBeNull();
    expect(readingToolbar('drafts').reply).toBe(false);
    expect(readingToolbar('sent').reply).toBe(true);
    // The phone's bottom bar still reads the mailbox's actions as they were.
    expect(toolbarModel(null).lead).toBe('reply');
    expect(toolbarModel('sent').icons).toContain('reply');
  });

  it('never shows Not junk, Rescue or Move it cannot carry out', () => {
    expect(controls(toolbar('junk', { onMoveTo: false }))).not.toContain('Not junk');
    expect(controls(toolbar('inbox', { onMoveTo: false }))).not.toContain('[Move]');
    expect(controls(toolbar('drafts'))).not.toContain('Edit draft');
  });
});

describe('the subject block, the header actions and the quick-reply bar (the canvas, PST-T-15.3)', () => {
  it('titles the pane, with a Priority badge only when the message is filed there', () => {
    const plain = renderToStaticMarkup(createElement(SubjectBlock, { subject: 'Acadia?', headingRef: null, priority: false, participants: null }));
    expect(plain).toMatch(/<h2 id="pr-reader-subject" class="pr-reader__subject" tabindex="-1">Acadia\?<\/h2>/);
    expect(plain).not.toContain('Priority');
    expect(plain).not.toContain('pr-subject__meta');
    const full = renderToStaticMarkup(createElement(SubjectBlock, { subject: 'Acadia?', headingRef: null, priority: true, participants: '3 messages · Priya Shah, you' }));
    expect(full).toContain('data-tone="neutral">Priority</span>');
    expect(full).toContain('3 messages · Priya Shah, you');
  });

  it('draws Star (pressed when starred) and Reply on the open message, with keys', () => {
    const html = renderToStaticMarkup(createElement(HeaderActions, { detail: detail('inbox', { flags: ['\\Flagged'] }), onAction: () => undefined }));
    expect(html).toMatch(/aria-label="Star" aria-keyshortcuts="s" aria-pressed="true"/);
    expect(html).toContain('data-tooltip="Unstar (s)"');
    expect(html).toContain('data-tooltip="Reply (r)"');
    const draft = renderToStaticMarkup(createElement(HeaderActions, { detail: detail('drafts'), onAction: () => undefined }));
    expect(draft).toMatch(/aria-label="Star" aria-keyshortcuts="s" aria-pressed="false"/);
    expect(draft).not.toContain('aria-label="Reply"');
  });

  it('offers "Reply to <name>…" with its R hint, then Reply all and Forward — never in Drafts', () => {
    const body = { id: 'm-1', headers: [{ name: 'From', value: 'Priya Shah <priya.shah@gmail.com>' }], text: 'x', textTruncated: false, html: null, htmlTruncated: false, attachments: [], warnings: [] };
    const html = renderToStaticMarkup(createElement(QuickReply, { detail: detail('inbox'), body, onAction: () => undefined }));
    expect(html).toMatch(/<button type="button" class="pr-quickreply__field" aria-keyshortcuts="r">/);
    expect(html).toContain('Reply to Priya Shah…');
    expect(html).toMatch(/<kbd class="d3-kbd pr-quickreply__key" aria-hidden="true">R<\/kbd>/);
    expect(controls(html)).toEqual(['Reply all', 'Forward']);
    expect(renderToStaticMarkup(createElement(QuickReply, { detail: detail('drafts'), body, onAction: () => undefined }))).toBe('');
    expect(quickReplyLabel('Operator <OPERATOR@d3cloud.io>', 'operator@d3cloud.io')).toBe('Reply…');
    expect(quickReplyLabel(null, null)).toBe('Reply…');
    expect(quickReplyLabel('jonah.reyes@fastmail.com', null)).toBe('Reply to jonah.reyes@fastmail.com…');
  });
});

describe('the attachment card (the canvas\'s .pr-file, PST-T-15.3)', () => {
  const pdf = { partId: '2', contentType: 'application/pdf', filename: 'Blackwoods-B22-confirmation.pdf', disposition: 'attachment', contentId: null, size: 98_304, sha256: 'x', inMessage: null };

  it('is one real download link to the attachment\'s own URL: type tile, name, size', () => {
    const html = renderToStaticMarkup(createElement(AttachmentCard, { messageId: 'm-1', attachment: pdf }));
    expect(html).toContain('href="/api/messages/m-1/attachments/2"');
    expect(html).toContain('download="Blackwoods-B22-confirmation.pdf"');
    expect(html).toContain('aria-label="Download Blackwoods-B22-confirmation.pdf, 96 KB"');
    expect(html).toMatch(/class="pr-file__tile" aria-hidden="true">PDF</);
    expect(html).toContain('>96 KB<');
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it('names the file type from the extension, else the content type, else FILE', () => {
    expect(fileTypeLabel('photo.jpeg', 'image/jpeg')).toBe('JPEG');
    expect(fileTypeLabel(null, 'image/png')).toBe('PNG');
    expect(fileTypeLabel('README', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('FILE');
    expect(fileTypeLabel('.hidden', 'text/calendar; method=REQUEST')).toBe('FILE');
  });

  it('lists only real attachments, and nothing at all when there are none', () => {
    const inline = { ...pdf, partId: '3', filename: null, disposition: 'inline' };
    const html = renderToStaticMarkup(createElement(AttachmentList, { messageId: 'm-1', attachments: [pdf, inline] }));
    expect(html).toContain('aria-label="Attachments"');
    expect(html.match(/class="pr-file"/g)).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(AttachmentList, { messageId: 'm-1', attachments: [inline] }))).toBe('');
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
