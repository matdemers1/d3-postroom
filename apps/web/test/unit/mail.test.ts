// PST-T-3.10: the pure logic behind the three-pane view — keys, routes, the list reducer, the
// composer's prefill and the formatters. The browser behaviour is e2e/tests/mail.spec.ts.
import { describe, expect, it } from 'vitest';
import type { MessageBody, MessageDetail, MessageSummary } from '../../src/api';
import { draftFor, forwardSubject, replySubject } from '../../src/mail/compose';
import { addressOf, backoffMs, displayName, mailboxLabel, splitAddresses } from '../../src/mail/format';
import { describeTarget, resolveKey, SHORTCUTS, type KeyInput } from '../../src/mail/keys';
import { initialList, listReducer, scrollToReveal, visibleRange, type ListState } from '../../src/mail/list';
import { mailPath, narrowView, parseMailRoute } from '../../src/mail/route';

const MB = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, editable: false, activatable: false, ...extra });

describe('resolveKey (PST-REQ-084)', () => {
  it('maps the Gmail keys', () => {
    const cases: [string, string][] = [['j', 'next'], ['k', 'prev'], ['o', 'open'], ['Enter', 'open'], ['u', 'back'], ['e', 'archive'], ['#', 'delete'], ['r', 'reply'], ['a', 'replyAll'], ['f', 'forward'], ['c', 'compose'], ['s', 'star'], ['U', 'markUnread'], ['/', 'search'], ['?', 'help']];
    for (const [k, action] of cases) expect(resolveKey(key(k), null).action, k).toBe(action);
  });
  it('g then i goes to the inbox; g then anything else does nothing', () => {
    const first = resolveKey(key('g'), null);
    expect(first).toEqual({ action: null, pending: 'g' });
    expect(resolveKey(key('i'), first.pending)).toEqual({ action: 'goInbox', pending: null });
    expect(resolveKey(key('j'), 'g')).toEqual({ action: null, pending: null });
  });
  it('is silent while typing or with a modifier, and leaves Enter to buttons', () => {
    expect(resolveKey(key('j', { editable: true }), null).action).toBeNull();
    expect(resolveKey(key('r', { metaKey: true }), null).action).toBeNull();
    expect(resolveKey(key('c', { ctrlKey: true }), null).action).toBeNull();
    expect(resolveKey(key('Enter', { activatable: true }), null).action).toBeNull();
    expect(resolveKey(key('e', { activatable: true }), null).action).toBe('archive');
  });
  it('the overlay lists every action exactly once', () => {
    expect(new Set(SHORTCUTS.map((s) => s.action)).size).toBe(SHORTCUTS.length);
  });
  it('describeTarget tells text fields from buttons', () => {
    const el = (tagName: string, attrs: Record<string, string> = {}, type = '') =>
      ({ tagName, type, isContentEditable: false, getAttribute: (n: string) => attrs[n] ?? null }) as unknown as EventTarget;
    expect(describeTarget(el('INPUT', {}, 'search'))).toEqual({ editable: true, activatable: false });
    expect(describeTarget(el('INPUT', {}, 'checkbox'))).toEqual({ editable: false, activatable: false });
    expect(describeTarget(el('TEXTAREA'))).toEqual({ editable: true, activatable: false });
    expect(describeTarget(el('BUTTON'))).toEqual({ editable: false, activatable: true });
    expect(describeTarget(el('DIV', { role: 'listbox' }))).toEqual({ editable: false, activatable: false });
    expect(describeTarget(null)).toEqual({ editable: false, activatable: false });
  });
});

describe('mail routes (PST-REQ-077)', () => {
  it('parses each level of push navigation', () => {
    expect(parseMailRoute('/')).toEqual({ mailboxIndex: false, mailboxId: null, messageId: null, compose: null });
    expect(parseMailRoute('/mail')).toMatchObject({ mailboxIndex: true, mailboxId: null });
    expect(parseMailRoute(`/mail/${MB}`)).toMatchObject({ mailboxId: MB, messageId: null });
    expect(parseMailRoute(`/mail/${MB}/${ID}`, '?compose=reply')).toMatchObject({ mailboxId: MB, messageId: ID, compose: 'reply' });
    expect(narrowView(parseMailRoute('/mail') ?? initialRoute())).toBe('mailboxes');
    expect(narrowView(parseMailRoute(`/mail/${MB}`) ?? initialRoute())).toBe('list');
    expect(narrowView(parseMailRoute(`/mail/${MB}/${ID}`) ?? initialRoute())).toBe('message');
  });
  it('refuses junk, and a reply with nothing to reply to', () => {
    expect(parseMailRoute('/mail/not-a-uuid')).toBeNull();
    expect(parseMailRoute(`/mail/${MB}/${ID}/extra`)).toBeNull();
    expect(parseMailRoute('/app-passwords')).toBeNull();
    expect(parseMailRoute(`/mail/${MB}`, '?compose=reply')?.compose).toBeNull();
    expect(parseMailRoute('/', '?compose=new')?.compose).toBe('new');
    expect(parseMailRoute('/', '?compose=evil')?.compose).toBeNull();
  });
  it('builds paths that parse back', () => {
    expect(mailPath(null)).toBe('/');
    expect(mailPath(MB, ID, 'forward')).toBe(`/mail/${MB}/${ID}?compose=forward`);
    const [path, search] = mailPath(MB, ID, 'replyall').split('?');
    expect(parseMailRoute(path ?? '', `?${search ?? ''}`)).toEqual({ mailboxIndex: false, mailboxId: MB, messageId: ID, compose: 'replyall' });
  });
});

function initialRoute() {
  return { mailboxIndex: false, mailboxId: null, messageId: null, compose: null };
}

const msg = (uid: number, extra: Partial<MessageSummary> = {}): MessageSummary => ({
  id: `m${String(uid)}`,
  mailboxId: MB,
  uid,
  modseq: String(uid),
  threadId: null,
  subject: `S${String(uid)}`,
  from: 'a@example.org',
  date: '2026-09-24T10:00:00Z',
  internalDate: '2026-09-24T10:00:00Z',
  size: 10,
  flags: [],
  bucket: null,
  ...extra,
});

function loaded(messages: MessageSummary[]): ListState {
  const reset = listReducer(initialList, { type: 'reset', mailboxId: MB });
  return listReducer(reset, { type: 'loaded', mailboxId: MB, messages, nextCursor: null, append: false });
}

describe('listReducer', () => {
  it('loads newest first with the cursor on the top row', () => {
    const s = loaded([msg(1), msg(3), msg(2)]);
    expect(s.messages.map((m) => m.uid)).toEqual([3, 2, 1]);
    expect(s.cursor).toBe(0);
    expect(s.status).toBe('ready');
  });
  it('j/k move the cursor and stop at the ends', () => {
    let s = loaded([msg(3), msg(2), msg(1)]);
    s = listReducer(s, { type: 'move', delta: 1 });
    s = listReducer(s, { type: 'move', delta: 1 });
    s = listReducer(s, { type: 'move', delta: 1 });
    expect(s.cursor).toBe(2);
    s = listReducer(s, { type: 'move', delta: -1 });
    expect(s.cursor).toBe(1);
  });
  it('a new message over SSE goes on top, keeps the cursor on its row, and is never duplicated', () => {
    let s = loaded([msg(2), msg(1)]);
    s = listReducer(s, { type: 'move', delta: 1 });
    s = listReducer(s, { type: 'upsert', message: msg(3) });
    s = listReducer(s, { type: 'upsert', message: msg(3) });
    expect(s.messages.map((m) => m.uid)).toEqual([3, 2, 1]);
    expect(s.messages[s.cursor]?.uid).toBe(1);
    expect(listReducer(s, { type: 'upsert', message: msg(9, { mailboxId: 'other' }) })).toBe(s);
  });
  it('archiving the row under the cursor leaves the cursor on the next one, never off the end', () => {
    let s = loaded([msg(3), msg(2), msg(1)]);
    s = listReducer(s, { type: 'cursor', index: 1 });
    s = listReducer(s, { type: 'remove', id: 'm2' });
    expect(s.messages[s.cursor]?.uid).toBe(1);
    s = listReducer(s, { type: 'remove', id: 'm1' });
    expect(s.cursor).toBe(0);
    s = listReducer(s, { type: 'remove', id: 'm3' });
    expect(s.cursor).toBe(-1);
  });
  it('optimistic flags apply, and the server copy replaces but never inserts', () => {
    let s = loaded([msg(1)]);
    s = listReducer(s, { type: 'flags', id: 'm1', add: ['\\Seen', '\\Seen'], remove: [] });
    expect(s.messages[0]?.flags).toEqual(['\\Seen']);
    s = listReducer(s, { type: 'patch', message: msg(1, { modseq: '7', flags: ['\\Seen', '\\Flagged'] }) });
    expect(s.messages[0]?.modseq).toBe('7');
    expect(listReducer(s, { type: 'patch', message: msg(5) })).toBe(s);
  });
  it('ignores a page for a mailbox it has left', () => {
    const s = listReducer(initialList, { type: 'reset', mailboxId: MB });
    expect(listReducer(s, { type: 'loaded', mailboxId: 'other', messages: [msg(1)], nextCursor: null, append: false })).toBe(s);
  });
  it('virtualises: renders only the rows in view plus overscan, and scrolls the cursor into view', () => {
    expect(visibleRange(0, 640, 64, 10_000, 8)).toEqual({ start: 0, end: 18 });
    expect(visibleRange(64 * 1000, 640, 64, 10_000, 8)).toEqual({ start: 992, end: 1018 });
    expect(visibleRange(0, 640, 64, 0)).toEqual({ start: 0, end: 0 });
    expect(scrollToReveal(0, 0, 640, 64)).toBeNull();
    expect(scrollToReveal(10, 0, 640, 64)).toBe(64 * 11 - 640);
    expect(scrollToReveal(2, 500, 640, 64)).toBe(128);
  });
});

const detail = (extra: Partial<MessageDetail> = {}): MessageDetail => ({
  ...msg(4, { subject: 'Quarterly numbers' }),
  messageIdHeader: '<abc@example.org>',
  inReplyTo: null,
  references: ['<root@example.org>'],
  verdict: null,
  ...extra,
});
const body = (headers: Record<string, string>, text = 'Line one\nLine two'): MessageBody => ({
  id: 'm4',
  headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
  text,
  textTruncated: false,
  html: null,
  htmlTruncated: false,
  attachments: [],
  warnings: [],
});

describe('draftFor (the composer prefill PST-T-3.11 builds on)', () => {
  const headers = { From: 'Alice <alice@example.org>', To: 'me@d3cloud.io, Carol <carol@example.org>', Cc: '"Doe, Bob" <bob@example.org>, ME@d3cloud.io' };
  it('reply: To the sender, Re: subject, threading headers, quoted text', () => {
    const d = draftFor('reply', { detail: detail(), body: body(headers) }, 'me@d3cloud.io', 'en-US');
    expect(d.to).toBe('Alice <alice@example.org>');
    expect(d.cc).toBe('');
    expect(d.subject).toBe('Re: Quarterly numbers');
    expect(d.inReplyTo).toBe('<abc@example.org>');
    expect(d.references).toEqual(['<root@example.org>', '<abc@example.org>']);
    expect(d.body).toContain('Alice wrote:\n> Line one\n> Line two');
  });
  it('reply goes to Reply-To when there is one', () => {
    const d = draftFor('reply', { detail: detail(), body: body({ ...headers, 'Reply-To': 'list@example.org' }) }, 'me@d3cloud.io');
    expect(d.to).toBe('list@example.org');
  });
  it('reply all: everyone but me, no duplicates', () => {
    const d = draftFor('replyall', { detail: detail(), body: body(headers) }, 'me@d3cloud.io');
    expect(d.to).toBe('Alice <alice@example.org>, Carol <carol@example.org>');
    expect(d.cc).toBe('"Doe, Bob" <bob@example.org>');
  });
  it('forward: Fwd:, nobody yet, the original below; new: blank', () => {
    const f = draftFor('forward', { detail: detail(), body: body(headers) }, 'me@d3cloud.io');
    expect(f).toMatchObject({ to: '', subject: 'Fwd: Quarterly numbers', inReplyTo: null });
    expect(f.body).toContain('---------- Forwarded message ----------');
    expect(draftFor('new', null, 'me@d3cloud.io')).toMatchObject({ mode: 'new', to: '', subject: '', body: '' });
  });
  it('never stacks prefixes', () => {
    expect(replySubject('RE: hi')).toBe('RE: hi');
    expect(replySubject(null)).toBe('Re:');
    expect(forwardSubject('Fw: hi')).toBe('Fw: hi');
  });
});

describe('formatters', () => {
  it('splits address lists on the commas between addresses only', () => {
    expect(splitAddresses('"Doe, Jane" <jane@x.org>, bob@y.org (Bob, Jr)')).toEqual(['"Doe, Jane" <jane@x.org>', 'bob@y.org (Bob, Jr)']);
    expect(addressOf('"Doe, Jane" <Jane@X.org>')).toBe('jane@x.org');
    expect(addressOf('bob@y.org (Bob)')).toBe('bob@y.org');
    expect(displayName('"Doe, Jane" <jane@x.org>')).toBe('Doe, Jane');
    expect(displayName('bob@y.org')).toBe('bob@y.org');
  });
  it('names mailboxes by role', () => {
    expect(mailboxLabel({ name: 'INBOX', specialUse: 'inbox' })).toBe('Inbox');
    expect(mailboxLabel({ name: 'Deleted Items', specialUse: 'trash' })).toBe('Trash');
    expect(mailboxLabel({ name: 'Receipts', specialUse: null })).toBe('Receipts');
  });
  it('backs off 1s, 2s, 4s … to 30s', () => {
    expect([0, 1, 2, 5, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 30_000, 30_000]);
  });
});
