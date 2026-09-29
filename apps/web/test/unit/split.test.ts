// PST-T-11.4 (design audit PST-DA-001, PST-DA-005): the Inbox's Priority / People split and what an
// empty mailbox says.
import { describe, expect, it } from 'vitest';
import { emptyMailboxCopy, inSegment, isInboxSegment, segmentItems, segmentKeyword } from '../../src/mail/split';

const mailbox = (name: string, specialUse: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'rejects' | null) => ({ name, specialUse });

describe('the Inbox split', () => {
  it('maps each segment to its keyword, Everything to none', () => {
    expect(segmentKeyword('all')).toBeNull();
    expect(segmentKeyword('priority')).toBe('$Priority');
    expect(segmentKeyword('people')).toBe('$People');
  });

  it('knows its segments', () => {
    expect(isInboxSegment('people')).toBe(true);
    expect(isInboxSegment('junk')).toBe(false);
  });

  it('lists Everything first, and counts only unread mail', () => {
    const items = segmentItems({ priority: { total: 4, unseen: 2 }, people: { total: 9, unseen: 0 } }, 7);
    expect(items.map((i) => i.value)).toEqual(['all', 'priority', 'people']);
    expect(items[0]).toMatchObject({ label: 'Everything', count: 7, countLabel: 'Everything, 7 unread' });
    expect(items[1]).toMatchObject({ label: 'Priority', count: 2, countLabel: 'Priority, 2 unread' });
    expect(items[2]).toEqual({ value: 'people', label: 'People' });
  });

  it('names every counted segment by its visible label plus the count, never a bare "unread" (A11Y-01)', () => {
    const items = segmentItems({ priority: { total: 4, unseen: 3 }, people: { total: 9, unseen: 5 } }, 8);
    for (const i of items) {
      expect(i.countLabel).toBe(`${i.label}, ${String(i.count)} unread`);
      expect(i.countLabel?.startsWith(i.label)).toBe(true);
    }
  });

  it('has no counts before the split has loaded', () => {
    const items = segmentItems(null, 0);
    for (const i of items) expect(i.count).toBeUndefined();
  });

  it('lets a live arrival into a segment only with its keyword', () => {
    expect(inSegment(['$People'], 'all')).toBe(true);
    expect(inSegment(['$People'], 'people')).toBe(true);
    expect(inSegment(['$People'], 'priority')).toBe(false);
    expect(inSegment(['\\Seen', '$Priority'], 'priority')).toBe(true);
  });
});

describe('an empty mailbox says what it is for', () => {
  it('never tells Trash, Junk or Rejected that new mail arrives there', () => {
    for (const use of ['trash', 'junk', 'rejects', 'sent', 'drafts', 'archive'] as const) {
      expect(emptyMailboxCopy(mailbox('X', use)).body).not.toMatch(/as it arrives/);
    }
  });

  it('gives every role its own heading', () => {
    const uses = ['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'rejects'] as const;
    const headings = uses.map((u) => emptyMailboxCopy(mailbox('X', u)).heading);
    expect(new Set(headings).size).toBe(uses.length);
  });

  it('explains each sorting bucket, and falls back for a user folder', () => {
    expect(emptyMailboxCopy(mailbox('Receipts', null)).heading).toBe('No receipts');
    expect(emptyMailboxCopy(mailbox('Newsletters', null)).body).toMatch(/sorted here/);
    expect(emptyMailboxCopy(mailbox('Projects', null)).heading).toBe('No messages here');
  });

  it('speaks to the Inbox segment that is showing', () => {
    expect(emptyMailboxCopy(mailbox('INBOX', 'inbox'), 'priority').heading).toBe('Nothing in Priority');
    expect(emptyMailboxCopy(mailbox('INBOX', 'inbox'), 'people').heading).toBe('Nothing in People');
    expect(emptyMailboxCopy(mailbox('INBOX', 'inbox')).heading).toBe('You are all caught up');
  });

  it('does not promise a removal date it does not know', () => {
    expect(emptyMailboxCopy(mailbox('Trash', 'trash')).body).not.toMatch(/\d+ days/);
  });
});
