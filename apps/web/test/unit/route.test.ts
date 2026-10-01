// PST-T-16.4 (PST-REQ-198, design findings PST-DA-027 and PST-DA-052): the URL holds the mail view's
// state — slugs for the special-use mailboxes and the sorter's buckets, one Inbox URL, and the search,
// the Inbox segment and the Inspect panel in the query. The browser behaviour (reload, Back) is
// e2e/tests/mail.spec.ts and e2e/tests/places.spec.ts.
import { describe, expect, it } from 'vitest';
import type { Mailbox, SpecialUse } from '../../src/api';
import {
  canonicalMailPath,
  draftPath,
  isMailboxSlug,
  MAILBOX_SLUGS,
  mailboxKey,
  mailboxSlug,
  mailPath,
  parseMailListState,
  parseMailRoute,
  resolveMailbox,
  routeMailbox,
  withListState,
  type ComposeRouteMode,
} from '../../src/mail/route';
import { MAIL_HOME } from '../../src/routes';

const MSG = '22222222-2222-4222-8222-222222222222';
const DRAFT = '33333333-3333-4333-8333-333333333333';

let n = 0;
function box(name: string, specialUse: SpecialUse | null = null): Mailbox {
  n += 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return { id, name, specialUse, uidvalidity: 1, uidnext: 1, highestModseq: '1', subscribed: true, total: 0, unseen: 0 };
}

const inbox = box('INBOX', 'inbox');
const sent = box('Sent', 'sent');
const drafts = box('Drafts', 'drafts');
const archive = box('Archive', 'archive');
const trash = box('Trash', 'trash');
const junk = box('Junk', 'junk');
const rejects = box('Rejects', 'rejects');
const updates = box('Updates');
const receipts = box('Receipts');
const notifications = box('Notifications');
const newsletters = box('Newsletters');
const mine = box('Projects');
const MAILBOXES = [inbox, sent, drafts, archive, trash, junk, rejects, updates, receipts, notifications, newsletters, mine];

const SLUG_OF: [Mailbox, string][] = [
  [inbox, 'inbox'],
  [sent, 'sent'],
  [drafts, 'drafts'],
  [archive, 'archive'],
  [trash, 'trash'],
  [junk, 'junk'],
  [rejects, 'rejects'],
  [updates, 'updates'],
  [receipts, 'receipts'],
  [notifications, 'notifications'],
  [newsletters, 'newsletters'],
];

describe('mailbox slugs (PST-DA-027)', () => {
  it('names every special-use mailbox and every bucket, and nothing else', () => {
    expect([...MAILBOX_SLUGS].sort()).toEqual(SLUG_OF.map(([, s]) => s).sort());
    for (const [m, slug] of SLUG_OF) {
      expect(mailboxSlug(m), m.name).toBe(slug);
      expect(isMailboxSlug(slug)).toBe(true);
    }
    expect(mailboxSlug(mine)).toBeNull();
    // INBOX by name, for a server that does not flag it.
    expect(mailboxSlug({ name: 'Inbox', specialUse: null })).toBe('inbox');
    // A bucket is the sorter's folder by its exact name, never a special-use folder.
    expect(mailboxSlug({ name: 'updates', specialUse: null })).toBeNull();
    for (const bad of ['', 'INBOX', 'Sent', 'snoozed', 'projects', MSG]) expect(isMailboxSlug(bad), bad).toBe(false);
  });

  it('a slug resolves back to the mailbox it was made from; a folder of your own keeps its UUID', () => {
    for (const [m, slug] of SLUG_OF) {
      expect(mailboxKey(m, MAILBOXES)).toBe(slug);
      expect(resolveMailbox(slug, MAILBOXES)?.id, slug).toBe(m.id);
      expect(resolveMailbox(m.id, MAILBOXES)?.id).toBe(m.id);
    }
    expect(mailboxKey(mine, MAILBOXES)).toBe(mine.id);
    expect(resolveMailbox(mine.id, MAILBOXES)).toBe(mine);
    expect(resolveMailbox('projects', MAILBOXES)).toBeNull();
    expect(resolveMailbox('inbox', null)).toBeNull();
    expect(resolveMailbox(null, MAILBOXES)).toBeNull();
  });

  it('one slug names one mailbox: a second folder that would share it keeps its UUID', () => {
    const flagged = box('Sent Items', 'sent');
    const unflagged = box('Updates');
    const all = [...MAILBOXES, flagged, unflagged];
    expect(mailboxKey(sent, all)).toBe('sent');
    expect(mailboxKey(flagged, all)).toBe(flagged.id);
    expect(mailboxKey(updates, all)).toBe('updates');
    expect(mailboxKey(unflagged, all)).toBe(unflagged.id);
  });

  it('routeMailbox: the path’s mailbox, the inbox for /, none for the /mail index', () => {
    expect(routeMailbox({ mailboxId: 'sent', mailboxIndex: false }, MAILBOXES)).toBe(sent);
    expect(routeMailbox({ mailboxId: archive.id, mailboxIndex: false }, MAILBOXES)).toBe(archive);
    expect(routeMailbox({ mailboxId: null, mailboxIndex: false }, MAILBOXES)).toBe(inbox);
    expect(routeMailbox({ mailboxId: null, mailboxIndex: true }, MAILBOXES)).toBeNull();
  });
});

describe('parseMailRoute and mailPath round-trip every slug (PST-REQ-198)', () => {
  const modes: (ComposeRouteMode | null)[] = [null, 'reply', 'replyall', 'forward', 'new', 'draft'];

  it('a mailbox, a message, and each composer', () => {
    for (const slug of MAILBOX_SLUGS) {
      expect(mailPath(slug)).toBe(`/mail/${slug}`);
      expect(parseMailRoute(mailPath(slug))).toEqual({ mailboxIndex: false, mailboxId: slug, messageId: null, compose: null, composeTo: null });
      for (const mode of modes) {
        const [path = '', query = ''] = mailPath(slug, MSG, mode).split('?');
        const route = parseMailRoute(path, query === '' ? '' : `?${query}`);
        expect(route, `${slug} ${String(mode)}`).toMatchObject({ mailboxIndex: false, mailboxId: slug, messageId: MSG, compose: mode });
        if (route === null) continue;
        expect(mailPath(route.mailboxId, route.messageId, route.compose)).toBe(mailPath(slug, MSG, mode));
      }
    }
  });

  it('a new message’s draft, saved under a slugged mailbox, survives a reload', () => {
    const behind = parseMailRoute(`/mail/inbox/${MSG}`, '?compose=new');
    if (behind === null) throw new Error('did not parse');
    const [path = '', query = ''] = draftPath(behind, DRAFT).split('?');
    expect(path).toBe(`/mail/inbox/${MSG}`);
    expect(parseMailRoute(path, `?${query}`)).toMatchObject({ mailboxId: 'inbox', messageId: MSG, compose: 'draft', composeDraftId: DRAFT });
  });

  it('UUID URLs still parse; anything else that is not a slug does not', () => {
    expect(parseMailRoute(`/mail/${mine.id}/${MSG}`)).toMatchObject({ mailboxId: mine.id, messageId: MSG });
    expect(parseMailRoute('/mail/projects')).toBeNull();
    expect(parseMailRoute('/mail/INBOX')).toBeNull();
    expect(parseMailRoute('/mail/inbox/not-a-message')).toBeNull();
    expect(parseMailRoute('/mail/inbox/sent')).toBeNull();
    expect(parseMailRoute(`/mail/inbox/${MSG}/extra`)).toBeNull();
  });

  it('/ is the inbox and redirects to the one Inbox URL', () => {
    expect(MAIL_HOME).toBe('/mail/inbox');
    expect(parseMailRoute(MAIL_HOME)).toMatchObject({ mailboxId: 'inbox', messageId: null });
    expect(resolveMailbox(parseMailRoute(MAIL_HOME)?.mailboxId ?? null, MAILBOXES)).toBe(inbox);
  });
});

describe('canonicalMailPath: old UUID URLs become slugs', () => {
  it('replaces a slugged mailbox’s UUID, keeping the message and the whole query', () => {
    for (const [m, slug] of SLUG_OF) {
      expect(canonicalMailPath(`/mail/${m.id}`, '', MAILBOXES)).toBe(`/mail/${slug}`);
      expect(canonicalMailPath(`/mail/${m.id}/${MSG}`, '?compose=reply&q=invoice', MAILBOXES)).toBe(`/mail/${slug}/${MSG}?compose=reply&q=invoice`);
    }
  });

  it('leaves a canonical URL, a folder of your own, an unknown UUID and the index alone', () => {
    for (const slug of MAILBOX_SLUGS) expect(canonicalMailPath(`/mail/${slug}/${MSG}`, '?panel=inspect', MAILBOXES)).toBeNull();
    expect(canonicalMailPath(`/mail/${mine.id}`, '', MAILBOXES)).toBeNull();
    expect(canonicalMailPath(`/mail/${MSG}`, '', MAILBOXES)).toBeNull();
    expect(canonicalMailPath('/mail', '', MAILBOXES)).toBeNull();
    expect(canonicalMailPath('/', '', MAILBOXES)).toBeNull();
    // Nothing is decided before the mailbox list arrives.
    expect(canonicalMailPath(`/mail/${sent.id}`, '', null)).toBeNull();
  });

  it('a slug this account has no mailbox for goes to the Inbox — but the Inbox never loops', () => {
    const noRejects = MAILBOXES.filter((m) => m !== rejects);
    expect(canonicalMailPath('/mail/rejects', '', noRejects)).toBe('/mail/inbox');
    expect(canonicalMailPath('/mail/inbox', '', [])).toBeNull();
  });
});

describe('the list’s state in the query (PST-DA-052)', () => {
  it('parses the search, the Inbox segment and the panel, refusing anything else', () => {
    expect(parseMailListState('')).toEqual({ q: null, view: null, panel: null });
    expect(parseMailListState('?q=quarterly+numbers&view=priority&panel=inspect')).toEqual({ q: 'quarterly numbers', view: 'priority', panel: 'inspect' });
    expect(parseMailListState('?q=%20%20&view=nope&panel=raw')).toEqual({ q: null, view: null, panel: null });
    expect(parseMailListState('?view=people').view).toBe('people');
    expect(parseMailListState('?view=all').view).toBe('all');
  });

  it('round-trips through withListState, beside the composer’s own parameters', () => {
    const states = [
      { q: 'from:ada "big numbers" & more?', view: null, panel: null },
      { q: null, view: 'priority', panel: null },
      { q: null, view: null, panel: 'inspect' },
      { q: 'é ü ✓', view: 'people', panel: 'inspect' },
    ] as const;
    for (const state of states) {
      const url = withListState(mailPath('inbox', MSG, 'draft'), state);
      const [path = '', query = ''] = url.split('?');
      expect(parseMailListState(`?${query}`)).toEqual(state);
      expect(parseMailRoute(path, `?${query}`)).toMatchObject({ mailboxId: 'inbox', messageId: MSG, compose: 'draft', composeDraftId: MSG });
    }
  });

  it('writes what it is given, removes what is null, and leaves the rest', () => {
    expect(withListState('/mail/inbox', {})).toBe('/mail/inbox');
    expect(withListState('/mail/inbox', { q: null, view: null, panel: null })).toBe('/mail/inbox');
    expect(withListState('/mail/inbox?q=a&view=people', { q: null })).toBe('/mail/inbox?view=people');
    expect(withListState(`/mail/inbox/${MSG}?view=people`, { panel: 'inspect' })).toBe(`/mail/inbox/${MSG}?view=people&panel=inspect`);
    expect(withListState(`/mail/inbox/${MSG}?compose=draft&id=${DRAFT}`, { q: 'x' })).toBe(`/mail/inbox/${MSG}?compose=draft&id=${DRAFT}&q=x`);
    expect(withListState('/mail/inbox?compose=new&to=jane%40example.org', { view: 'priority' })).toBe('/mail/inbox?compose=new&to=jane%40example.org&view=priority');
  });
});
