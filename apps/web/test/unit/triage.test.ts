// PST-T-14.5 (PST-REQ-190, PST-ADR-011): the triage loop's pure half — what a row says about its
// sender, which messages a move takes, which message opens next, how Undo is planned, the
// x-selection and the "N new" pill — plus MessageRow rendered to a string. The browser behaviour
// (archive → next → undo by keyboard and by mouse, axe) is e2e/tests/triage.spec.ts.
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MessageSummary } from '../../src/api';
import { resolveKey, SHORTCUTS, type KeyInput } from '../../src/mail/keys';
import { initialList, listReducer } from '../../src/mail/list';
import { blockTop, dayGroupKey, dayGroupLabel, dayGroups, layoutRows, rangeFor, revealRow, rowAt, weekStartDay } from '../../src/mail/list/groups';
import { MessageRow, ROW_HEIGHT } from '../../src/mail/list/MessageRow';
import { GROUP_HEAD_HEIGHT, TriageList } from '../../src/mail/list/TriageList';
import {
  avatarName,
  holdBackArrivals,
  initials,
  mergeMembers,
  nextAfterRemoval,
  pruneSelected,
  recipientLine,
  rowAvatarName,
  selectedMessages,
  senderLine,
  snippetLine,
  threadMembersInMailbox,
  toggleSelected,
  triageMessage,
  undoPatches,
  type RowSummary,
} from '../../src/mail/list/triage';

// @d3cloud/ui ships a CSS import Node cannot load: plain stand-ins that show the props the row passes.
vi.mock('@d3cloud/ui', () => ({
  Avatar: (p: { name: string; size?: string; tint?: string }) => createElement('span', { className: 'd3-avt', 'data-name': p.name, 'data-size': p.size, 'data-tint': p.tint, 'aria-hidden': true }),
  Badge: (p: { tone?: string; size?: string; className?: string; children?: ReactNode }) => createElement('span', { className: `d3-bdg ${p.className ?? ''}`, 'data-tone': p.tone, 'data-size': p.size }, p.children),
  IconButton: (p: { label: string }) => createElement('button', { 'aria-label': p.label }),
}));

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

describe('the sender line in Sent and Drafts names the recipients (PST-T-16.12, PST-REQ-199)', () => {
  const me = { from: 'matt@d3cloud.io', fromName: 'Matt Demers', newSender: false };

  it('reads "To: <first recipient>" with (+N) for the others, in sent and in drafts', () => {
    expect(senderLine({ ...me, to: { name: 'Alice', count: 1 } }, false, 'sent')).toEqual({ name: 'To: Alice', address: null, firstTime: false, warned: false });
    expect(senderLine({ ...me, to: { name: 'Alice', count: 2 } }, false, 'sent').name).toBe('To: Alice (+1)');
    expect(senderLine({ ...me, to: { name: 'bob@example.org', count: 4 } }, false, 'drafts').name).toBe('To: bob@example.org (+3)');
  });

  it('never shows the operator\'s own name or address there', () => {
    const line = senderLine({ ...me, to: { name: 'Alice', count: 2 } }, false, 'sent');
    expect(line.name).not.toContain('Matt');
    expect(line.address).toBeNull();
  });

  it('says so for a draft with no recipients yet', () => {
    expect(senderLine({ ...me, to: { name: null, count: 0 } }, false, 'drafts').name).toBe('To: (no recipients)');
  });

  it('keeps the sender line outside Sent and Drafts, and for a row not summarised yet', () => {
    expect(senderLine({ ...me, to: { name: 'Alice', count: 2 } }, false, 'inbox').name).toBe('Matt Demers');
    expect(senderLine({ ...me, to: { name: 'Alice', count: 2 } }).name).toBe('Matt Demers');
    expect(senderLine({ ...me, to: null }, false, 'sent').name).toBe('Matt Demers');
    expect(senderLine(me, false, 'sent').name).toBe('Matt Demers');
    expect(recipientLine({ name: 'Alice', count: 1 }, 'archive')).toBeNull();
  });

  it('draws the avatar from the first recipient there, and from the sender elsewhere', () => {
    expect(rowAvatarName({ ...me, to: { name: 'Alice Ng', count: 2 } }, 'sent')).toBe('Alice Ng');
    expect(rowAvatarName({ ...me, to: { name: 'ada.lovelace@example.org', count: 1 } }, 'drafts')).toBe('ada lovelace');
    expect(rowAvatarName({ ...me, to: { name: 'Alice Ng', count: 2 } }, 'inbox')).toBe('Matt Demers');
    expect(rowAvatarName({ ...me, to: null }, 'sent')).toBe('Matt Demers');
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
    expect(html).not.toContain('priya@example.org');
    expect(html).toContain('<time dateTime="2026-09-20T10:00:00.000Z">');
  });

  it('names the recipients in a Sent or Drafts row, never the operator (PST-T-16.12)', () => {
    const sent = msg('m1', { from: 'matt@d3cloud.io', fromName: 'Matt Demers', to: { name: 'Alice', count: 2 } });
    const html = render(sent, { specialUse: 'sent' });
    expect(html).toMatch(/pr-mrow__name">To: Alice \(\+1\)</);
    expect(html).toContain('data-name="Alice"');
    expect(html).not.toContain('Matt Demers');
    expect(render(sent, { specialUse: 'drafts' })).toContain('To: Alice (+1)');
    // The same row in the Inbox (or with no mail context) is the sender's.
    expect(render(sent, { specialUse: 'inbox' })).toMatch(/pr-mrow__name">Matt Demers</);
    expect(render(sent)).toMatch(/pr-mrow__name">Matt Demers</);
  });

  it('draws a 40 px (size lg) D3 Avatar, tinted from the sender\'s name', () => {
    const html = render(msg('m1', { fromName: 'Priya Shah', from: 'priya@example.org' }));
    expect(html).toContain('data-name="Priya Shah" data-size="lg" data-tint="auto"');
    // No display name: the address's local part, as words, so the initials and tint are stable.
    expect(render(msg('m2', { fromName: null, from: 'ada.lovelace@example.org' }))).toContain('data-name="ada lovelace"');
  });

  it('shows the thread count beside the sender from two listed messages, with a spoken label', () => {
    expect(render(msg('m1'), { threadCount: 3 })).toMatch(/pr-mrow__count"[^>]*>.*3<span class="pr-vh"> messages in this conversation<\/span>/);
    expect(render(msg('m1'), { threadCount: 1 })).not.toContain('pr-mrow__count');
    expect(render(msg('m1'))).not.toContain('pr-mrow__count');
  });

  it('shows Priority as an attention Badge for a $Priority message, unless the list is Priority', () => {
    const html = render(msg('m1', { flags: ['\\Seen', '$Priority'] }));
    expect(html).toMatch(/data-tone="attention"[^>]*><span class="pr-vh">, <\/span>Priority</);
    expect(render(msg('m1', { flags: ['\\Seen', '$Priority'] }), { showPriority: false })).not.toContain('Priority');
    expect(render(msg('m2', { flags: ['\\Seen', '$People'] }))).not.toContain('Priority');
  });

  it('puts the badges before the snippet on the third line', () => {
    const html = render(msg('m1', { fromName: 'Sam', newSender: true, flags: ['\\Seen', '$Priority'], snippet: 'Hi Matt' }));
    const third = /pr-mrow__snippet">(.*)$/.exec(html)?.[1] ?? '';
    expect(third.indexOf('New sender')).toBeGreaterThanOrEqual(0);
    expect(third.indexOf('Priority')).toBeGreaterThan(third.indexOf('New sender'));
    expect(third.indexOf('Hi Matt')).toBeGreaterThan(third.indexOf('Priority'));
  });

  it('adds the address and a neutral "New sender" Badge for a first-time sender', () => {
    const html = render(msg('m1', { fromName: 'Sam Whitaker', from: 'sam@fastmail.example', newSender: true }));
    expect(html).toContain('sam@fastmail.example');
    expect(html).toMatch(/data-tone="neutral"[^>]*><span class="pr-vh">, <\/span>New sender</);
    expect(render(msg('m2', { fromName: 'Sam Whitaker' }))).not.toContain('New sender');
  });

  it('adds the address and "Check sender" when the message carries a phishing warning', () => {
    const html = render(msg('m1', { fromName: 'PayPal', from: 'billing@paypa1.example' }), { warned: true });
    expect(html).toContain('billing@paypa1.example');
    expect(html).toMatch(/data-tone="attention"[^>]*><span class="pr-vh">, <\/span>Check sender</);
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

describe('the avatar name (PST-T-15.2)', () => {
  it('is the display name, else the address local part as words, else "?"', () => {
    expect(avatarName('  Priya Shah ', 'priya@example.org')).toBe('Priya Shah');
    expect(avatarName(null, 'ada.lovelace+lists@example.org')).toBe('ada lovelace lists');
    expect(avatarName('', 'noreply@example.org')).toBe('noreply');
    expect(avatarName(null, null)).toBe('?');
  });
});

describe('day groups (PST-T-15.2)', () => {
  // Wednesday 30 September 2026, 15:00 local time; weeks start on Sunday (0) or Monday (1).
  const now = new Date(2026, 8, 30, 15, 0, 0);
  const at = (y: number, m: number, d: number, h = 9): string => new Date(y, m - 1, d, h).toISOString();

  it('names Today, Yesterday, Earlier this week, then the month (with the year when it is not this one)', () => {
    expect(dayGroupKey(at(2026, 9, 30, 0), now)).toBe('today');
    expect(dayGroupKey(at(2026, 10, 2), now)).toBe('today'); // a clock ahead of ours is still today
    expect(dayGroupKey(at(2026, 9, 29, 23), now)).toBe('yesterday');
    expect(dayGroupKey(at(2026, 9, 27), now, 0)).toBe('week'); // Sunday, the week's first day
    expect(dayGroupKey(at(2026, 9, 26), now, 0)).toBe('m-2026-09');
    expect(dayGroupKey(at(2026, 9, 27), now, 1)).toBe('m-2026-09'); // a Monday-first week began on the 28th
    expect(dayGroupKey(at(2025, 12, 31), now)).toBe('m-2025-12');
    expect(dayGroupLabel('today', now)).toBe('Today');
    expect(dayGroupLabel('yesterday', now)).toBe('Yesterday');
    expect(dayGroupLabel('week', now)).toBe('Earlier this week');
    expect(dayGroupLabel('m-2026-08', now)).toBe(new Date(2026, 7, 1).toLocaleString(undefined, { month: 'long' }));
    expect(dayGroupLabel('m-2025-12', now)).toBe(`${new Date(2025, 11, 1).toLocaleString(undefined, { month: 'long' })} 2025`);
  });

  it('groups a newest-first list into contiguous runs, each with the index of its first row', () => {
    const list = [at(2026, 9, 30, 11), at(2026, 9, 30, 8), at(2026, 9, 29), at(2026, 9, 28), at(2026, 9, 2), at(2026, 8, 20)].map((d) => ({ internalDate: d }));
    expect(dayGroups(list, now, 0)).toEqual([
      { key: 'today', label: 'Today', start: 0 },
      { key: 'yesterday', label: 'Yesterday', start: 2 },
      { key: 'week', label: 'Earlier this week', start: 3 },
      { key: 'm-2026-09', label: dayGroupLabel('m-2026-09', now), start: 4 },
      { key: 'm-2026-08', label: dayGroupLabel('m-2026-08', now), start: 5 },
    ]);
    expect(dayGroups([], now)).toEqual([]);
    // Out of order (never from the reducer, which sorts): a repeated group keeps a unique key.
    const keys = dayGroups([at(2026, 9, 30), at(2026, 9, 29), at(2026, 9, 30)].map((d) => ({ internalDate: d })), now).map((g) => g.key);
    expect(new Set(keys).size).toBe(3);
  });

  it('reads the first day of the week from the locale when the runtime knows it', () => {
    expect([0, 1, 6]).toContain(weekStartDay('en-GB'));
    expect(weekStartDay('not a locale!')).toBe(0);
  });
});

describe('the grouped virtual list geometry (PST-T-15.2)', () => {
  // Rows 0–1 Today, 2 Yesterday, 3–999 September: three headers.
  const groups = [
    { key: 'today', label: 'Today', start: 0 },
    { key: 'yesterday', label: 'Yesterday', start: 2 },
    { key: 'm-2026-09', label: 'September', start: 3 },
  ];
  const layout = layoutRows(groups, 1000, 80, 36);

  it('puts each group header directly above its first row', () => {
    expect(layout.rowTop.slice(0, 5)).toEqual([36, 116, 232, 348, 428]);
    expect(layout.height).toBe(3 * 36 + 1000 * 80);
    expect(blockTop(layout, 2)).toBe(196);
    expect(blockTop(layout, 1)).toBe(116);
  });

  it('finds the row under a point, and none over a header', () => {
    expect(rowAt(layout, 0)).toBeNull();
    expect(rowAt(layout, 36)).toBe(0);
    expect(rowAt(layout, 200)).toBeNull(); // Yesterday's header
    expect(rowAt(layout, 240)).toBe(2);
    expect(rowAt(layout, layout.height + 5)).toBeNull();
  });

  it('renders only the rows in view plus the overscan, however long the list', () => {
    // Rows 0–6 start within 640 px (the last at 588), plus eight below.
    expect(rangeFor(layout, 0, 640, 8)).toEqual({ start: 0, end: 15 });
    const far = rangeFor(layout, layout.rowTop[900] ?? 0, 640, 8);
    expect(far.start).toBe(892);
    expect(far.end - far.start).toBeLessThan(30);
    expect(rangeFor(layoutRows([], 0, 80, 36), 0, 640)).toEqual({ start: 0, end: 0 });
  });

  it('scrolls a row into view, with its group header when it leads one', () => {
    expect(revealRow(layout, 0, 0, 640)).toBeNull();
    expect(revealRow(layout, 2, 400, 640)).toBe(196);
    expect(revealRow(layout, 20, 0, 640)).toBe((layout.rowTop[20] ?? 0) + 80 - 640);
  });
});

describe('TriageList day groups (PST-T-15.2)', () => {
  const now = new Date();
  const hoursAgo = (h: number): string => new Date(now.getTime() - h * 3_600_000).toISOString();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30).toISOString();
  const lastYear = new Date(now.getFullYear() - 1, 0, 15).toISOString();
  const listed = [
    msg('m3', { internalDate: new Date(Math.max(Date.parse(today), Date.parse(hoursAgo(0)))).toISOString(), threadId: 't1' }),
    msg('m2', { internalDate: today, threadId: 't1', flags: ['\\Seen', '$Priority'] }),
    msg('m1', { internalDate: lastYear }),
  ];
  const noop = (): void => undefined;
  const html = renderToStaticMarkup(
    createElement(TriageList, {
      messages: listed,
      cursor: 0,
      openId: null,
      label: 'Messages in Inbox',
      selected: new Set<string>(),
      leaving: new Set<string>(),
      warnedId: null,
      pendingCount: 0,
      canArchive: true,
      canTrash: true,
      canSnooze: true,
      onOpen: noop,
      onToggleSelect: noop,
      onRowAction: noop,
      onShowNew: noop,
      onNearEnd: noop,
    }),
  );

  it('keeps one listbox whose children are named groups of options, the header decorative', () => {
    expect(html).toMatch(/role="listbox" aria-label="Messages in Inbox"/);
    expect(html).toMatch(/<div role="group" aria-label="Today" class="pr-group"><div class="pr-group__head" aria-hidden="true">Today<\/div><div id="pr-msg-m3" role="option"/);
    expect(html).toMatch(/<div role="group" aria-label="[^"]+ \d{4}" class="pr-group"><div class="pr-group__head" aria-hidden="true">[^<]+<\/div><div id="pr-msg-m1" role="option"/);
    // Positions count the whole list, across groups.
    expect(html).toContain('aria-posinset="3"');
    expect(html.match(/aria-setsize="3"/g)).toHaveLength(3);
  });

  it('counts listed members of a conversation, and badges Priority', () => {
    expect(html.match(/pr-mrow__count/g)).toHaveLength(2);
    expect(html).toContain('>Priority<');
  });

  it('pads the scroll box for its header above the first row', () => {
    expect(GROUP_HEAD_HEIGHT).toBe(36);
    expect(html).toContain('padding-top:0');
  });
});
