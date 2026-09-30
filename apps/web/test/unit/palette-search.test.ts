// PST-T-15.5 (PST-REQ-194): the palette's Messages group, pure and DOM-free — what the chips ask
// GET /api/search (checked against the real query grammar, so a chip can never ask for something
// the API would read differently), the rows' text, the group's placement, the debounce that drops
// stale answers, and openPalette() for the list's search field. The browser behaviour — ⌘K, typing,
// Enter opening a message, axe in both themes — is e2e/tests/command-palette.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mailbox, MessageSummary } from '../../src/api';
import { onPaletteOpenRequest, openPalette, useOpenPalette } from '../../src/mail/palette/open';
import {
  createSearchScheduler,
  currentMailbox,
  MESSAGE_LIMIT,
  messageDescription,
  messageLabel,
  messagesLead,
  NO_FILTERS,
  requestKey,
  SEARCH_DEBOUNCE_MS,
  searchRequest,
  senderName,
  type SearchOutcome,
  type SearchRequest,
} from '../../src/mail/palette/search';
import { parseQuery } from '../../../../packages/search/src/parser';

const mailbox = (id: string, name: string, specialUse: Mailbox['specialUse'] = null): Mailbox => ({
  id,
  name,
  specialUse,
  uidvalidity: 1,
  uidnext: 1,
  highestModseq: '1',
  subscribed: true,
  total: 0,
  unseen: 0,
});

const summary = (id: string, over: Partial<MessageSummary> = {}): MessageSummary => ({
  id,
  mailboxId: 'inbox-id',
  uid: 1,
  modseq: '1',
  threadId: null,
  subject: `Subject ${id}`,
  from: 'priya@example.com',
  fromName: 'Priya Shah',
  date: '2026-09-22T10:24:00.000Z',
  internalDate: '2026-09-22T10:24:00.000Z',
  size: 10,
  flags: [],
  bucket: null,
  ...over,
});

const INBOX = mailbox('inbox-id', 'INBOX', 'inbox');
const RECEIPTS = mailbox('receipts-id', 'Receipts');

describe('searchRequest: the chips map onto what the search API honours', () => {
  it('asks nothing for blank text and no chips', () => {
    expect(searchRequest('   ', NO_FILTERS, 'inbox-id')).toBeNull();
  });

  it('passes typed text through as the query, grammar and all', () => {
    expect(searchRequest(' acadia ', NO_FILTERS, 'inbox-id')).toEqual({ q: 'acadia' });
    expect(searchRequest('subject:acadia -camp', NO_FILTERS, null)).toEqual({ q: 'subject:acadia -camp' });
  });

  it('In: <mailbox> becomes the endpoint’s mailboxId, and only when there is a mailbox', () => {
    expect(searchRequest('acadia', { ...NO_FILTERS, inMailbox: true }, 'receipts-id')).toEqual({ q: 'acadia', mailboxId: 'receipts-id' });
    expect(searchRequest('acadia', { ...NO_FILTERS, inMailbox: true }, null)).toEqual({ q: 'acadia' });
    // A mailbox is not a query on its own: the API needs q.
    expect(searchRequest('', { ...NO_FILTERS, inMailbox: true }, 'receipts-id')).toBeNull();
  });

  it('From reads the typed text as the sender: one from: operator, quoted', () => {
    const r = searchRequest('priya shah', { ...NO_FILTERS, from: true }, null);
    expect(r).toEqual({ q: 'from:"priya shah"' });
    const { ast, warnings } = parseQuery(r?.q ?? '');
    expect(warnings).toEqual([]);
    expect(ast.root).toEqual({ type: 'op', op: 'from', value: 'priya shah' });
  });

  it('From drops a double quote (the grammar’s quoted value has no escape)', () => {
    const r = searchRequest('"priya', { ...NO_FILTERS, from: true }, null);
    expect(parseQuery(r?.q ?? '').ast.root).toEqual({ type: 'op', op: 'from', value: 'priya' });
    expect(searchRequest('"', { ...NO_FILTERS, from: true }, null)).toBeNull();
  });

  it('Has attachment and Date add has:attachment and after:7d, which the grammar reads as operators', () => {
    const r = searchRequest('lease', { ...NO_FILTERS, hasAttachment: true, recent: true }, null);
    expect(r).toEqual({ q: 'lease has:attachment after:7d' });
    const { ast, warnings } = parseQuery(r?.q ?? '');
    expect(warnings).toEqual([]);
    expect(ast.root).toEqual({
      type: 'and',
      nodes: [
        { type: 'word', value: 'lease' },
        { type: 'op', op: 'has', value: 'attachment' },
        { type: 'op', op: 'after', value: '7d' },
      ],
    });
  });

  it('a chip alone is a query: every recent message with an attachment', () => {
    expect(searchRequest('', { ...NO_FILTERS, hasAttachment: true }, null)).toEqual({ q: 'has:attachment' });
    expect(searchRequest('', { ...NO_FILTERS, from: true, recent: true }, null)).toEqual({ q: 'after:7d' });
  });

  it('keys a request by its text and its mailbox', () => {
    expect(requestKey(null)).toBeNull();
    expect(requestKey({ q: 'a' })).toBe(requestKey({ q: 'a' }));
    expect(requestKey({ q: 'a' })).not.toBe(requestKey({ q: 'a', mailboxId: 'x' }));
  });
});

describe('the Messages rows', () => {
  it('name the sender by display name, else address', () => {
    expect(senderName({ fromName: 'Priya Shah', from: 'priya@example.com' })).toBe('Priya Shah');
    expect(senderName({ fromName: '  ', from: 'priya@example.com' })).toBe('priya@example.com');
    expect(senderName({ from: null })).toBe('Unknown sender');
  });

  it('describe a row as "sender · date", the date as the list shows it', () => {
    const now = new Date('2026-09-29T12:00:00.000Z');
    expect(messageDescription(summary('a'), now)).toMatch(/^Priya Shah · Sep 22$/);
  });

  it('label a row by its subject, with a stand-in for none', () => {
    expect(messageLabel({ subject: 'Re: Acadia' })).toBe('Re: Acadia');
    expect(messageLabel({ subject: null })).toBe('(no subject)');
    expect(messageLabel({ subject: ' ' })).toBe('(no subject)');
  });
});

describe('currentMailbox: what the In chip names', () => {
  it('is the mailbox in the URL, or the inbox at /', () => {
    expect(currentMailbox([INBOX, RECEIPTS], 'receipts-id')).toBe(RECEIPTS);
    expect(currentMailbox([INBOX, RECEIPTS], null)).toBe(INBOX);
  });

  it('is nothing before the mailboxes load, or for an unknown id', () => {
    expect(currentMailbox(null, null)).toBeNull();
    expect(currentMailbox([INBOX], 'gone')).toBeNull();
  });
});

describe('messagesLead: where the Messages group goes', () => {
  it('leads when no command is named by the query', () => {
    expect(messagesLead(null, 'acadia')).toBe(true);
    expect(messagesLead('Snooze until tomorrow', 'acadia')).toBe(true);
  });

  it('follows a command whose name contains the query, so an arriving answer never moves the top row', () => {
    expect(messagesLead('Move to Receipts', 'rec')).toBe(false);
    expect(messagesLead('Inspect the open message', 'Inspect the open')).toBe(false);
  });
});

describe('createSearchScheduler: debounced, stale answers dropped', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
  };

  it('asks once, after the pause, for the last thing typed', async () => {
    const run = vi.fn((r: SearchRequest) => Promise.resolve({ messages: [summary(r.q)] }));
    const settled: [string, SearchOutcome][] = [];
    const s = createSearchScheduler(run, (k, o) => settled.push([k, o]));
    s.schedule({ q: 'a' });
    s.schedule({ q: 'ac' });
    s.schedule({ q: 'aca' });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ q: 'aca' });
    expect(settled).toEqual([[requestKey({ q: 'aca' }), { ok: true, messages: [summary('aca')] }]]);
  });

  it('drops an answer that arrives after the query moved on', async () => {
    let release: (v: { messages: MessageSummary[] }) => void = () => undefined;
    const slow = new Promise<{ messages: MessageSummary[] }>((resolve) => {
      release = resolve;
    });
    const run = vi.fn((r: SearchRequest) => (r.q === 'old' ? slow : Promise.resolve({ messages: [summary('new')] })));
    const settled: string[] = [];
    const s = createSearchScheduler(run, (k) => settled.push(k));
    s.schedule({ q: 'old' });
    await settle();
    s.schedule({ q: 'new' });
    await settle();
    release({ messages: [summary('old')] });
    await vi.runAllTimersAsync();
    expect(settled).toEqual([requestKey({ q: 'new' })]);
  });

  it('drops everything once cancelled (the palette closed, or the query went blank)', async () => {
    let release: (v: { messages: MessageSummary[] }) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<{ messages: MessageSummary[] }>((resolve) => {
          release = resolve;
        }),
    );
    const onSettled = vi.fn();
    const s = createSearchScheduler(run, onSettled);
    s.schedule({ q: 'a' });
    s.schedule(null);
    await settle();
    expect(run).not.toHaveBeenCalled();
    s.schedule({ q: 'b' });
    await settle(); // asked, not yet answered
    s.cancel();
    release({ messages: [] });
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('shows at most MESSAGE_LIMIT rows, and reports a failure as one', async () => {
    const many = Array.from({ length: 50 }, (_, i) => summary(`m${String(i)}`));
    const settled: SearchOutcome[] = [];
    const ok = createSearchScheduler(() => Promise.resolve({ messages: many }), (_k, o) => settled.push(o));
    ok.schedule({ q: 'm' });
    await settle();
    const failing = createSearchScheduler(() => Promise.reject(new Error('501')), (_k, o) => settled.push(o));
    failing.schedule({ q: 'm' });
    await settle();
    const [first, second] = settled;
    expect(first?.ok === true ? first.messages.length : -1).toBe(MESSAGE_LIMIT);
    expect(second).toEqual({ ok: false });
  });
});

describe('openPalette: the list’s search field opens ⌘K search', () => {
  it('reaches the mounted palette, with any text handed over', () => {
    const heard: (string | undefined)[] = [];
    const off = onPaletteOpenRequest((q) => heard.push(q));
    openPalette();
    useOpenPalette()('acadia');
    off();
    openPalette('after unsubscribe');
    expect(heard).toEqual([undefined, 'acadia']);
  });
});
