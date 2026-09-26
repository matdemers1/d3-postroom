// PST-T-3.15, PST-REQ-079: ReadingPane's thread view. Ordering itself comes straight from
// GET /api/threads/:id (oldest first); what is pure and tested here is which rows start expanded,
// the manual toggle, and a collapsed row's summary line.
import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../src/api';
import { collapsedSummary, isConversation, mightJoinThread, threadRows, toggleRow } from '../../src/mail/thread';

function summary(id: string, over: Partial<MessageSummary> = {}): MessageSummary {
  return {
    id,
    mailboxId: 'mbx-1',
    uid: 1,
    modseq: '1',
    threadId: 'thread-1',
    subject: 'Lunch on Friday',
    from: 'alice@example.org',
    date: '2026-09-01T12:00:00Z',
    internalDate: '2026-09-01T12:00:00Z',
    size: 100,
    flags: [],
    bucket: null,
    ...over,
  };
}

describe('isConversation', () => {
  it('is false for zero or one message', () => {
    expect(isConversation([])).toBe(false);
    expect(isConversation([summary('a')])).toBe(false);
  });

  it('is true for more than one message', () => {
    expect(isConversation([summary('a'), summary('b')])).toBe(true);
  });
});

describe('threadRows', () => {
  it('expands only the newest message when nothing else asks for it', () => {
    const messages = [summary('a'), summary('b'), summary('c')];
    const rows = threadRows(messages, null, new Set());
    expect(rows.map((r) => r.expanded)).toEqual([false, false, true]);
  });

  it('also expands the message that was opened, even when it is not the newest', () => {
    const messages = [summary('a'), summary('b'), summary('c')];
    const rows = threadRows(messages, 'a', new Set());
    expect(rows.map((r) => [r.message.id, r.expanded])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
  });

  it('also expands anything toggled open by hand', () => {
    const messages = [summary('a'), summary('b'), summary('c')];
    const rows = threadRows(messages, null, new Set(['a']));
    expect(rows.map((r) => [r.message.id, r.expanded])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
  });

  it('preserves the input order', () => {
    const messages = [summary('a'), summary('b'), summary('c')];
    const rows = threadRows(messages, null, new Set());
    expect(rows.map((r) => r.message.id)).toEqual(['a', 'b', 'c']);
  });

  it('is empty for no messages', () => {
    expect(threadRows([], null, new Set())).toEqual([]);
  });
});

describe('toggleRow', () => {
  it('adds an id that was not toggled', () => {
    const next = toggleRow(new Set(), 'a');
    expect([...next]).toEqual(['a']);
  });

  it('removes an id that was toggled', () => {
    const next = toggleRow(new Set(['a', 'b']), 'a');
    expect([...next]).toEqual(['b']);
  });

  it('does not mutate its input', () => {
    const input = new Set(['a']);
    toggleRow(input, 'a');
    expect([...input]).toEqual(['a']);
  });
});

describe('collapsedSummary', () => {
  it('is just the sender when the subject matches the thread', () => {
    expect(collapsedSummary({ from: 'alice@example.org', subject: 'Lunch' }, 'Lunch')).toBe('alice@example.org');
  });

  it('appends the subject when it differs from the thread', () => {
    expect(collapsedSummary({ from: 'alice@example.org', subject: 'Re: Lunch, moved' }, 'Lunch')).toBe('alice@example.org — Re: Lunch, moved');
  });

  it('falls back to a placeholder for an unknown sender', () => {
    expect(collapsedSummary({ from: null, subject: 'Lunch' }, 'Lunch')).toBe('(unknown sender)');
  });
});

describe('mightJoinThread', () => {
  it('is false when the open message has no thread at all', () => {
    expect(mightJoinThread(null)).toBe(false);
  });

  it('is true whenever there is a thread to check against', () => {
    expect(mightJoinThread('thread-1')).toBe(true);
  });
});
