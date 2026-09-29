// PST-T-14.9 (PST-ADR-011): where the bucket chip shows, the one sentence its popover says (built
// from the STORED reasons only), which corrections it offers, and the Inbox segment each browser
// remembers.
import { describe, expect, it } from 'vitest';
import {
  alwaysPut,
  chipShows,
  correctedMessage,
  listKeeps,
  loadSegment,
  mailboxBucket,
  otherBuckets,
  preferenceScope,
  preferenceTarget,
  routingHelp,
  saveSegment,
  SEGMENT_STORAGE_KEY,
  suggestedMove,
  whySentence,
} from '../../src/mail/sorting/sorting';

describe('where the bucket chip shows', () => {
  it('only where the bucket is not implied', () => {
    expect(chipShows('notifications', { kind: 'search' })).toBe(true);
    expect(chipShows('priority', { kind: 'inbox', segment: 'all' })).toBe(true);
    expect(chipShows('priority', { kind: 'inbox', segment: 'priority' })).toBe(false);
    expect(chipShows('people', { kind: 'inbox', segment: 'people' })).toBe(false);
    expect(chipShows('notifications', { kind: 'mailbox', bucket: 'notifications' })).toBe(false);
    expect(chipShows('receipts', { kind: 'mailbox', bucket: null })).toBe(false);
    expect(chipShows('updates', { kind: 'thread', openBucket: 'priority' })).toBe(true);
    expect(chipShows('priority', { kind: 'thread', openBucket: 'priority' })).toBe(false);
  });

  it('never for an unsorted message', () => {
    expect(chipShows(null, { kind: 'search' })).toBe(false);
    expect(chipShows('inbox', { kind: 'search' })).toBe(false);
  });

  it('knows which mailboxes are buckets', () => {
    expect(mailboxBucket({ name: 'Notifications', specialUse: null })).toBe('notifications');
    expect(mailboxBucket({ name: 'Junk', specialUse: 'junk' })).toBe('junk');
    expect(mailboxBucket({ name: 'INBOX', specialUse: 'inbox' })).toBeNull();
    expect(mailboxBucket({ name: 'Projects', specialUse: null })).toBeNull();
    expect(mailboxBucket(null)).toBeNull();
  });

  it('says whether a corrected message stays in the list being shown', () => {
    expect(listKeeps('priority', { kind: 'inbox', segment: 'all' })).toBe(true);
    expect(listKeeps('notifications', { kind: 'inbox', segment: 'all' })).toBe(false);
    expect(listKeeps('people', { kind: 'inbox', segment: 'priority' })).toBe(false);
    expect(listKeeps('priority', { kind: 'search' })).toBe(true);
    expect(listKeeps('notifications', { kind: 'mailbox', bucket: 'notifications' })).toBe(true);
    expect(listKeeps('priority', { kind: 'mailbox', bucket: 'notifications' })).toBe(false);
  });
});

describe('the one sentence, from the stored reasons', () => {
  const auth = 'auth: spf=pass dkim=pass dmarc=pass arc=none';

  it('says the rule that decided a notification', () => {
    expect(whySentence('notifications', [auth, 'other: not a human sender', 'notifications: sender domain github.com is a notification system (github.com)', 'filed: Notifications'])).toBe(
      'Filed in Notifications because github.com sends automated notifications.',
    );
    expect(whySentence('notifications', [auth, 'notifications: x-github-reason header (notification system)'])).toBe('Filed in Notifications because it carries the x-github-reason header that notification systems send.');
  });

  it('says why Priority and People are in the Inbox', () => {
    expect(whySentence('priority', [auth, 'priority: human, known sender, addressed directly, not bulk'])).toBe('Filed in your Inbox as Priority because someone you know wrote to you directly.');
    expect(whySentence('people', [auth, 'people: human sender not in reply graph, contacts, or an authenticated VIP pin'])).toMatch(/^Filed in your Inbox as People because a person wrote, but you have not written to them/);
  });

  it('a correction or a pin decides over the rule pass', () => {
    const reasons = [auth, 'notifications: automated sender (noreply)', 'pinned: @github.com → notifications'];
    expect(whySentence('notifications', reasons)).toBe('Filed in Notifications because you always put mail from github.com there.');
    const corrected = [...reasons, 'corrected: you put this in Priority, and mail from elena@example.org now goes there too'];
    expect(whySentence('priority', corrected)).toBe('Filed in your Inbox as Priority because you corrected it, and mail from elena@example.org goes there now.');
  });

  it('an unauthenticated pin that did not apply is not the reason', () => {
    const reasons = ['pinned: jane@example.com → priority, but unauthenticated (dmarc fail) — a pin does not ride an unauthenticated message into INBOX', 'people: human sender not in reply graph, contacts, or an authenticated VIP pin'];
    expect(whySentence('people', reasons)).toMatch(/because a person wrote/);
  });

  it('uses Bayes when that is what decided, and a rule or tag when that did', () => {
    expect(whySentence('newsletters', [auth, 'bayes: newsletters 0.93 (tokens: sale, weekly)'])).toBe('Filed in Newsletters because it looks like mail you have kept in Newsletters before (93% sure).');
    expect(whySentence('receipts', [auth, 'sieve bucket "receipts" overrides the classifier\'s updates'])).toBe('Filed in Receipts because one of your rules put it there.');
    expect(whySentence('receipts', ['plus-address tag receipts'])).toBe('Filed in Receipts because it was sent to your +receipts address.');
  });

  it('never invents a why', () => {
    expect(whySentence('updates', [auth])).toBe('Filed in Updates.');
    expect(whySentence(null, [])).toBe('This message has not been sorted.');
  });

  it('explains Junk', () => {
    expect(whySentence('junk', ['junk: sender is blocked'])).toBe('Filed in Junk because you blocked this sender.');
  });
});

describe('the corrections offered', () => {
  it('"Always put" names the domain for automated mail, the sender otherwise', () => {
    expect(alwaysPut('notifications@github.com', 'GitHub', 'notifications')).toEqual({ scope: 'domain', bucket: 'notifications', label: 'Always put github.com in Notifications' });
    expect(alwaysPut('sam@gmail.com', 'Sam Whitaker', 'newsletters')).toEqual({ scope: 'sender', bucket: 'newsletters', label: 'Always put Sam Whitaker in Newsletters' });
    expect(alwaysPut('jonah@corp.example', null, 'priority')).toEqual({ scope: 'sender', bucket: 'priority', label: 'Always put jonah@corp.example in Priority' });
    expect(alwaysPut(null, null, 'priority')).toBeNull();
    expect(preferenceScope('x@FASTMAIL.com', 'updates')).toBe('sender');
  });

  it('leads with the other half of the Inbox, else Priority, and lists the rest', () => {
    expect(suggestedMove('notifications')).toBe('priority');
    expect(suggestedMove('priority')).toBe('people');
    expect(suggestedMove('people')).toBe('priority');
    expect(otherBuckets('notifications')).toEqual(['people', 'newsletters', 'updates', 'receipts']);
  });

  it('says what happened in the Toast', () => {
    expect(correctedMessage('priority', true)).toBe('Moved to Priority · preference saved');
    expect(correctedMessage('notifications', false)).toBe('Preference saved: Notifications');
  });

  it('names a correction\'s preference in Rules', () => {
    expect(preferenceTarget({ target: '@github.com', scope: 'domain' })).toBe('github.com (the whole domain)');
    expect(preferenceTarget({ target: 'sam@example.net', scope: 'sender' })).toBe('sam@example.net');
  });

  it('explains a Person card\'s routing', () => {
    expect(routingHelp('priority', 'people', 'Sam')).toBe('You chose Priority. New mail from Sam goes there.');
    expect(routingHelp(null, 'people', 'Sam')).toMatch(/Pick Priority/);
    expect(routingHelp(null, 'updates', 'Shop')).toBe('Sorted automatically — this message went to Updates.');
  });
});

describe('the Inbox segment each browser remembers', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('is Everything until one is chosen', () => {
    expect(loadSegment(memory())).toBe('all');
    expect(loadSegment(null)).toBe('all');
  });

  it('remembers the last one, and ignores junk in storage', () => {
    const store = memory();
    saveSegment('priority', store);
    expect(store.m.get(SEGMENT_STORAGE_KEY)).toBe('priority');
    expect(loadSegment(store)).toBe('priority');
    store.setItem(SEGMENT_STORAGE_KEY, 'bogus');
    expect(loadSegment(store)).toBe('all');
  });

  it('never throws when storage does', () => {
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadSegment(broken)).toBe('all');
    expect(() => {
      saveSegment('people', broken);
    }).not.toThrow();
  });
});
