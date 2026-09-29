// PST-T-14.5 (PST-REQ-190, PST-ADR-011): the triage loop's pure half — what a row says about its
// sender, which messages a move takes, which message opens next, how Undo is planned, the
// x-selection and the "N new" pill — plus MessageRow rendered to a string. The browser behaviour
// (archive → next → undo by keyboard and by mouse, axe) is e2e/tests/triage.spec.ts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../src/api';
import { resolveKey, SHORTCUTS, type KeyInput } from '../../src/mail/keys';
import { initialList, listReducer } from '../../src/mail/list';
import { MessageRow, ROW_HEIGHT } from '../../src/mail/list/MessageRow';
import {
  holdBackArrivals,
  initials,
  mergeMembers,
  nextAfterRemoval,
  pruneSelected,
  selectedMessages,
  senderLine,
  snippetLine,
  threadMembersInMailbox,
  toggleSelected,
  triageMessage,
  undoPatches,
  type RowSummary,
} from '../../src/mail/list/triage';

const INBOX = 'inbox-1';
const ARCHIVE = 'archive-1';

function msg(id: string, over: Partial<RowSummary> = {}): RowSummary {
  return {
    id,
    mailboxId: INBOX,
    uid: Number(id.replace(/\D/g, '')) || 1,
    modseq: '10',
    threadId: null,
    subject: `Subject ${id}`,
    from: `${id}@example.org`,
    fromName: null,
    snippet: null,
    date: '2026-09-20T10:00:00.000Z',
    internalDate: '2026-09-20T10:00:00.000Z',
    size: 100,
    flags: ['\\Seen'],
    bucket: null,
    ...over,
  };
}

const ids = (list: readonly Pick<MessageSummary, 'id'>[]): string[] => list.map((m) => m.id);

describe('the sender line', () => {
  it('leads with the display name and hides the address for a known sender', () => {
    expect(senderLine({ from: 'priya@example.org', fromName: 'Priya Shah', newSender: false })).toEqual({ name: 'Priya Shah', address: null, firstTime: false, warned: false });
  });

  it('shows the address beside the name for a first-time sender', () => {
    expect(senderLine({ from: 'sam@fastmail.example', fromName: 'Sam Whitaker', newSender: true })).toMatchObject({ name: 'Sam Whitaker', address: 'sam@fastmail.example', firstTime: true });
  });

  it('shows the address beside the name when there is a phishing warning', () => {
    expect(senderLine({ from: 'billing@paypa1.example', fromName: 'PayPal', newSender: false }, true)).toMatchObject({ name: 'PayPal', address: 'billing@paypa1.example', warned: true });
  });

  it('falls back to the address, once, when there is no display name', () => {
    expect(senderLine({ from: 'noreply@example.org', fromName: null, newSender: true })).toEqual({ name: 'noreply@example.org', address: null, firstTime: true, warned: false });
    expect(senderLine({ from: 'noreply@example.org', fromName: '   ' })).toMatchObject({ name: 'noreply@example.org', address: null });
    expect(senderLine({ from: null, fromName: null })).toMatchObject({ name: '(unknown sender)', address: null });
  });

  it('does not repeat an address that IS the display name', () => {
    expect(senderLine({ from: 'a@example.org', fromName: 'A@example.org', newSender: true }).address).toBeNull();
  });
});

describe('initials', () => {
  it('takes the first and last words of the display name', () => {
    expect(initials('Priya Shah', 'priya@example.org')).toBe('PS');
    expect(initials('Mail Delivery System', null)).toBe('MS');
    expect(initials('Élodie', null)).toBe('ÉL');
  });

  it('falls back to the address local part', () => {
    expect(initials(null, 'sam.whitaker@example.org')).toBe('SW');
    expect(initials('', 'jonah@example.org')).toBe('JO');
    expect(initials(null, null)).toBe('?');
  });
});

describe('the snippet line', () => {
  it('renders null (not summarised) and empty (no text) as nothing, and collapses whitespace', () => {
    expect(snippetLine(null)).toBe('');
    expect(snippetLine('')).toBe('');
    expect(snippetLine('  Hi   Matt,\n Jonah said ')).toBe('Hi Matt, Jonah said');
  });
});

describe('MessageRow', () => {
  const now = new Date('2026-09-28T12:00:00.000Z');
  const render = (m: RowSummary, extra: Partial<Parameters<typeof MessageRow>[0]> = {}) =>
    renderToStaticMarkup(createElement(MessageRow, { message: m, index: 0, count: 3, cursor: false, open: false, checked: undefined, leaving: false, warned: false, now, ...extra }));

  it('is an option holding no focusable control (axe nested-interactive)', () => {
    const html = render(msg('m1', { fromName: 'Priya Shah', snippet: 'Okay hear me out' }));
    expect(html).toMatch(/^<div id="pr-msg-m1" role="option"/);
    expect(html).not.toMatch(/<button|<a |tabindex/i);
  });

  it('shows name, subject, snippet and date, and no address for a known sender', () => {
    const html = render(msg('m1', { fromName: 'Priya Shah', snippet: 'Okay hear me out', from: 'priya@example.org' }));
    expect(html).toContain('Priya Shah');
    expect(html).toContain('Subject m1');
    expect(html).toContain('Okay hear me out');
    expect(html).toContain('>PS<');
    expect(html).not.toContain('priya@example.org');
    expect(html).toContain('<time dateTime="2026-09-20T10:00:00.000Z">');
  });

  it('adds the address and a "First message" tag for a first-time sender', () => {
    const html = render(msg('m1', { fromName: 'Sam Whitaker', from: 'sam@fastmail.example', newSender: true }));
    expect(html).toContain('sam@fastmail.example');
    expect(html).toContain('First message');
  });

  it('adds the address and "Check sender" when the message carries a phishing warning', () => {
    const html = render(msg('m1', { fromName: 'PayPal', from: 'billing@paypa1.example' }), { warned: true });
    expect(html).toContain('billing@paypa1.example');
    expect(html).toContain('Check sender');
  });

  it('marks unread with weight AND a dot, and says so to a screen reader', () => {
    const html = render(msg('m1', { flags: [] }));
    expect(html).toContain('pr-mrow--unread');
    expect(html).toContain('pr-mrow__dot');
    expect(html).toContain('Unread, ');
    expect(render(msg('m2'))).not.toContain('pr-mrow--unread');
  });

  it('draws the star and attachment glyphs', () => {
    const html = render(msg('m1', { flags: ['\\Seen', '\\Flagged'], hasAttachments: true }));
    expect(html).toContain(', starred');
    expect(html).toContain(', has attachments');
  });

  it('carries cursor, open, selection and leaving state as ARIA and classes', () => {
    const html = render(msg('m1'), { cursor: true, open: true, checked: true, leaving: true });
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('pr-mrow--checked');
    expect(html).toContain('pr-mrow--leaving');
    // Outside selection mode there is no aria-checked at all.
    expect(render(msg('m2'))).not.toContain('aria-checked');
  });

  it('has the fixed height the virtual list is computed with', () => {
    expect(ROW_HEIGHT).toBe(80);
  });
});

describe('the scope of a move on an open thread', () => {
  const listed = [
    msg('m6', { threadId: 't1' }),
    msg('m5', { threadId: 't2' }),
    msg('m4', { threadId: 't1' }),
    msg('m3', { threadId: 't1', mailboxId: ARCHIVE }),
    msg('m2'),
  ];

  it('takes every member of the thread in the same mailbox, the open one first', () => {
    const open = listed[2];
    if (open === undefined) throw new Error('fixture');
    expect(ids(threadMembersInMailbox(listed, open))).toEqual(['m4', 'm6']);
  });

  it('takes only the message itself when it has no thread', () => {
    const open = listed[4];
    if (open === undefined) throw new Error('fixture');
    expect(ids(threadMembersInMailbox(listed, open))).toEqual(['m2']);
  });

  it('adds the members the server knows of that the list had not loaded — same mailbox, no repeats', () => {
    const known = [msg('m6', { threadId: 't1' })];
    const server = [msg('m1', { threadId: 't1' }), msg('m6', { threadId: 't1' }), msg('m0', { threadId: 't1', mailboxId: ARCHIVE })];
    expect(ids(mergeMembers(known, server, INBOX))).toEqual(['m6', 'm1']);
  });
});

describe('which message opens next', () => {
  const list = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));

  it('is the message below (older) the one that left', () => {
    expect(nextAfterRemoval(list, new Set(['b']), 'b')).toBe('c');
  });

  it('skips every member that left with it', () => {
    expect(nextAfterRemoval(list, new Set(['b', 'c', 'e']), 'b')).toBe('d');
  });

  it('is the one above when nothing below is left', () => {
    expect(nextAfterRemoval(list, new Set(['d', 'e']), 'e')).toBe('c');
  });

  it('is null when the list is emptied', () => {
    expect(nextAfterRemoval(list, new Set(['a', 'b', 'c', 'd', 'e']), 'c')).toBeNull();
  });

  it('falls back to the first survivor when the anchor is not listed', () => {
    expect(nextAfterRemoval(list, new Set(['a']), 'zz')).toBe('b');
    expect(nextAfterRemoval(list, new Set(), null)).toBe('a');
  });
});

describe('Undo', () => {
  it('moves each moved COPY (its new id and MODSEQ in the destination) back where it came from', () => {
    const patches = undoPatches([
      { originalId: 'old-1', movedId: 'new-1', movedModseq: '41', fromMailboxId: INBOX },
      { originalId: 'old-2', movedId: 'new-2', movedModseq: '42', fromMailboxId: INBOX },
    ]);
    expect(patches).toEqual([
      { id: 'new-1', modseq: '41', mailboxId: INBOX },
      { id: 'new-2', modseq: '42', mailboxId: INBOX },
    ]);
    // Never the old id: a move is a new UID in the destination.
    expect(patches.map((p) => p.id)).not.toContain('old-1');
  });

  it('has nothing to undo when no move landed', () => {
    expect(undoPatches([])).toEqual([]);
  });

  it('says what happened in the toast', () => {
    expect(triageMessage('Moved to Archive', 1, 'Re: Acadia')).toBe('Moved to Archive · Re: Acadia');
    expect(triageMessage('Moved to Archive', 1, null)).toBe('Moved to Archive · (no subject)');
    expect(triageMessage('Moved to Archive', 3, 'Re: Acadia')).toBe('Moved 3 messages to Archive');
    expect(triageMessage('Snoozed until Mon 8:00 AM', 2, 'x')).toBe('Snoozed until Mon 8:00 AM · 2 messages');
  });
});

describe('selection (x)', () => {
  it('toggles, never mutating the set it was given', () => {
    const empty = new Set<string>();
    const one = toggleSelected(empty, 'a');
    expect([...one]).toEqual(['a']);
    expect(empty.size).toBe(0);
    expect(toggleSelected(one, 'a').size).toBe(0);
  });

  it('drops ids that are no longer listed, and keeps the same set when nothing changed', () => {
    const sel = new Set(['a', 'b']);
    expect([...pruneSelected(sel, [{ id: 'a' }])]).toEqual(['a']);
    expect(pruneSelected(sel, [{ id: 'a' }, { id: 'b' }])).toBe(sel);
  });

  it('lists the selected messages in list order', () => {
    expect(ids(selectedMessages([msg('m3'), msg('m2'), msg('m1')], new Set(['m1', 'm3'])))).toEqual(['m3', 'm1']);
  });
});

describe('live arrivals behind the "N new" pill', () => {
  const listed = [msg('m5'), msg('m4')];

  it('go straight in while the reader is at rest at the top', () => {
    const { keep, held } = holdBackArrivals([msg('m7'), msg('m5'), msg('m4')], listed, true);
    expect(ids(keep)).toEqual(['m7', 'm5', 'm4']);
    expect(held).toEqual([]);
  });

  it('wait behind the pill otherwise — only what is newer than the top row', () => {
    const { keep, held } = holdBackArrivals([msg('m7'), msg('m6'), msg('m5'), msg('m4'), msg('m3')], listed, false);
    expect(ids(held)).toEqual(['m7', 'm6']);
    expect(ids(keep)).toEqual(['m5', 'm4', 'm3']);
  });

  it('never hold back a message moved in with an older date: it goes to its date position (PST-T-14.10)', () => {
    const restored = msg('m9', { internalDate: '2026-09-19T10:00:00.000Z' });
    const { keep, held } = holdBackArrivals([msg('m7', { internalDate: '2026-09-21T10:00:00.000Z' }), restored, ...listed], listed, false);
    expect(ids(held)).toEqual(['m7']);
    expect(ids(keep)).toEqual(['m9', 'm5', 'm4']);
  });

  it('never hold anything back from an empty list', () => {
    expect(holdBackArrivals([msg('m1')], [], false).held).toEqual([]);
  });
});

describe('the triage keys', () => {
  const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, editable: false, activatable: false, ...extra });

  it('maps z v x b', () => {
    expect(resolveKey(key('z'), null).action).toBe('undo');
    expect(resolveKey(key('v'), null).action).toBe('moveTo');
    expect(resolveKey(key('x'), null).action).toBe('select');
    expect(resolveKey(key('b'), null).action).toBe('snooze');
  });

  it('are typing, not shortcuts, in a text field', () => {
    for (const k of ['z', 'v', 'x', 'b']) expect(resolveKey(key(k, { editable: true }), null).action).toBeNull();
  });

  it('are listed in the ? overlay', () => {
    const listed = new Set(SHORTCUTS.map((s) => s.keys));
    for (const k of ['z', 'v', 'x', 'b']) expect(listed.has(k)).toBe(true);
  });
});

describe('removal keeps the cursor on the next message (the list reducer)', () => {
  it('leaves the cursor on the row that took the removed one\'s place', () => {
    let s = listReducer({ ...initialList, mailboxId: INBOX }, { type: 'loaded', mailboxId: INBOX, messages: [msg('m3'), msg('m2'), msg('m1')], nextCursor: null, append: false });
    s = listReducer(s, { type: 'cursorTo', id: 'm2' });
    s = listReducer(s, { type: 'remove', id: 'm3' });
    expect(s.messages[s.cursor]?.id).toBe('m2');
  });
});
