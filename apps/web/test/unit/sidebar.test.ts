// PST-T-14.3: the Mail sidebar's shape — mailboxes only, the sorter's buckets grouped, Junk and
// Rejects one click away with a quiet count of what is new since you last looked, the rest behind More.
import { describe, expect, it } from 'vitest';
import type { Mailbox } from '../../src/api';
import { mailSidebar, newSinceVisit, parseVisits } from '../../src/mail/sidebar';

const box = (name: string, specialUse: Mailbox['specialUse'] = null, extra: Partial<Mailbox> = {}): Mailbox => ({
  id: `${name}-id`,
  name,
  specialUse,
  uidvalidity: 1,
  uidnext: 10,
  highestModseq: '1',
  subscribed: true,
  total: 0,
  unseen: 0,
  ...extra,
});

const ALL = [
  box('Trash', 'trash'),
  box('Newsletters'),
  box('INBOX', 'inbox'),
  box('Junk', 'junk'),
  box('Projects'),
  box('Sent', 'sent'),
  box('Receipts'),
  box('Rejects', 'rejects'),
  box('Drafts', 'drafts'),
  box('Updates'),
  box('Archive', 'archive'),
  box('Notifications'),
];

describe('mailSidebar', () => {
  it('orders Inbox, Sent, Drafts, Archive; Sorted for you; Junk and Rejects; then More', () => {
    const s = mailSidebar(ALL);
    expect(s.primary.map((m) => m.name)).toEqual(['INBOX', 'Sent', 'Drafts', 'Archive']);
    expect(s.sorted.map((m) => m.name)).toEqual(['Updates', 'Receipts', 'Notifications', 'Newsletters']);
    expect(s.safetyNet.map((m) => m.name)).toEqual(['Junk', 'Rejects']);
    expect(s.more.map((m) => m.name)).toEqual(['Trash', 'Projects']);
  });

  it('places every mailbox exactly once', () => {
    const s = mailSidebar(ALL);
    const all = [...s.primary, ...s.sorted, ...s.safetyNet, ...s.more].map((m) => m.id);
    expect(all.sort()).toEqual(ALL.map((m) => m.id).sort());
  });

  it('a user folder that merely shares a special-use name is not a bucket', () => {
    const s = mailSidebar([box('INBOX', 'inbox'), box('Receipts', 'archive')]);
    expect(s.sorted).toEqual([]);
    expect(s.primary.map((m) => m.name)).toEqual(['INBOX', 'Receipts']);
  });
});

describe('newSinceVisit', () => {
  it('is 0 with nothing unread, whatever arrived', () => {
    expect(newSinceVisit({ id: 'j', uidnext: 50, unseen: 0 }, { j: 10 })).toBe(0);
  });
  it('counts arrivals since the last visit, capped by what is still unread', () => {
    expect(newSinceVisit({ id: 'j', uidnext: 13, unseen: 5 }, { j: 10 })).toBe(3);
    expect(newSinceVisit({ id: 'j', uidnext: 40, unseen: 2 }, { j: 10 })).toBe(2);
    expect(newSinceVisit({ id: 'j', uidnext: 10, unseen: 2 }, { j: 10 })).toBe(0);
  });
  it('never visited here: the unread count', () => {
    expect(newSinceVisit({ id: 'j', uidnext: 10, unseen: 4 }, {})).toBe(4);
  });
  it('parses stored visits defensively', () => {
    expect(parseVisits(null)).toEqual({});
    expect(parseVisits('not json')).toEqual({});
    expect(parseVisits('[1]')).toEqual({});
    expect(parseVisits('{"a":3,"b":"x"}')).toEqual({ a: 3 });
  });
});
