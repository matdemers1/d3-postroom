// PST-T-14.7 (PST-REQ-191, PST-ADR-011; design audit TF-06..09, CPY-04, MOD-07): the composer's pure
// rules — the glue between address strings and RecipientField chips, contact suggestions, the From
// row, which rows start open, the folded quote, the formatting bar, resuming a draft in place, and
// the key that keeps one composer across a resumed draft's saves. The browser behaviour (chips,
// autocomplete, Cc/Bcc reveal, inline reply, Discard → Undo, axe) is e2e/tests/compose.spec.ts.
import { describe, expect, it } from 'vitest';
import type { ContactSummary } from '../../src/api';
import { draftFor, draftToResume, fieldsOf, initialState } from '../../src/mail/compose';
import { applyFormat, initialReveal, joinQuote, optionsSummary, reveal, splitQuote } from '../../src/mail/compose/fields';
import { contactSuggestions, entryOf, fromChoices, fromRecipients, hasFromChoice, recipientOf, toRecipients } from '../../src/mail/compose/recipients';
import { composerKey, forgetDrafts, linkSavedDraft } from '../../src/mail/compose/session';
import { composesInPane, draftPath, mailPath, narrowView, parseMailRoute } from '../../src/mail/route';

const MB = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';

describe('recipient glue: header strings ⇄ chips', () => {
  it('reads bare, named and quoted entries, keeping the address as typed', () => {
    expect(recipientOf('Alice@Example.org')).toEqual({ address: 'Alice@Example.org' });
    expect(recipientOf('Alice Example <alice@example.org>')).toEqual({ name: 'Alice Example', address: 'alice@example.org' });
    expect(recipientOf('"Doe, Jane" <jane@example.org>')).toEqual({ name: 'Doe, Jane', address: 'jane@example.org' });
    expect(recipientOf('<bob@example.org>')).toEqual({ address: 'bob@example.org' });
    expect(recipientOf('   ')).toBeNull();
  });

  it('splits a list on the commas between entries, not inside a quoted name', () => {
    expect(toRecipients('"Doe, Jane" <jane@example.org>, bob@example.org')).toEqual([
      { name: 'Doe, Jane', address: 'jane@example.org' },
      { address: 'bob@example.org' },
    ]);
    expect(toRecipients('')).toEqual([]);
  });

  it('writes chips back so compose.ts splits them into the same entries on send', () => {
    const text = '"Doe, Jane" <jane@example.org>, Alice Example <alice@example.org>, bob@example.org';
    const round = fromRecipients(toRecipients(text));
    expect(round).toBe(text);
    const state = { ...initialState(draftFor('new', null, null)), to: round };
    expect(fieldsOf(state).to).toEqual(['"Doe, Jane" <jane@example.org>', 'Alice Example <alice@example.org>', 'bob@example.org']);
  });

  it('quotes a display name only when it needs it, escaping quotes inside', () => {
    expect(entryOf({ name: 'Alice', address: 'a@x.org' })).toBe('Alice <a@x.org>');
    expect(entryOf({ name: 'Smith, J.', address: 'j@x.org' })).toBe('"Smith, J." <j@x.org>');
    expect(entryOf({ name: 'The "Boss"', address: 'b@x.org' })).toBe('"The \\"Boss\\"" <b@x.org>');
    expect(entryOf({ address: 'c@x.org' })).toBe('c@x.org');
  });
});

describe('contact suggestions', () => {
  const contact = (displayName: string, emails: string[], org = ''): ContactSummary => ({ addressBookId: 'ab', name: displayName, etag: '1', uid: displayName, displayName, emails, org, hasPhoto: false });

  it('offers every address of a contact whose name matches, labelled as a contact', () => {
    const list = [contact('Linda Demers', ['linda@example.org', 'linda.d@work.example']), contact('Dana Okafor', ['dana@example.org'])];
    expect(contactSuggestions(list, 'lin')).toEqual([
      { name: 'Linda Demers', address: 'linda@example.org', detail: 'Contact' },
      { name: 'Linda Demers', address: 'linda.d@work.example', detail: 'Contact' },
    ]);
  });

  it('narrows to matching addresses when the name does not match, de-duplicates, and caps the list', () => {
    const list = [contact('Linda Demers', ['linda@example.org', 'ld@work.example']), contact('Other', ['ld@work.example'])];
    expect(contactSuggestions(list, 'work')).toEqual([{ name: 'Linda Demers', address: 'ld@work.example', detail: 'Contact' }]);
    const many = Array.from({ length: 20 }, (_, i) => contact(`Person ${String(i)}`, [`p${String(i)}@x.org`]));
    expect(contactSuggestions(many, 'person')).toHaveLength(8);
    expect(contactSuggestions(many, '  ')).toEqual([]);
  });
});

describe('the From row', () => {
  it('exists only when a live alias gives a choice', () => {
    expect(fromChoices('me@d3cloud.io', [])).toEqual(['me@d3cloud.io']);
    expect(hasFromChoice(fromChoices('me@d3cloud.io', []))).toBe(false);
    const aliases = [
      { address: 'shop.x1@d3cloud.io', killedAt: null },
      { address: 'old.y2@d3cloud.io', killedAt: '2026-09-01T00:00:00Z' },
    ];
    expect(fromChoices('me@d3cloud.io', aliases)).toEqual(['me@d3cloud.io', 'shop.x1@d3cloud.io']);
    expect(hasFromChoice(fromChoices('me@d3cloud.io', aliases))).toBe(true);
  });
});

describe('Cc / Bcc / From reveal (PST-REQ-191)', () => {
  it('starts with only To and Subject for a new message', () => {
    expect(initialReveal(initialState(draftFor('new', null, null)))).toEqual({ cc: false, bcc: false, from: false });
  });

  it('opens a row that already has something in it: a reply-all Cc, a draft Bcc, a draft sent from an alias', () => {
    expect(initialReveal({ cc: 'bob@example.org', bcc: '' })).toEqual({ cc: true, bcc: false, from: false });
    expect(initialReveal({ cc: '', bcc: 'x@example.org' })).toEqual({ cc: false, bcc: true, from: false });
    expect(initialReveal({ cc: '', bcc: '' }, 'shop.x1@d3cloud.io', 'me@d3cloud.io').from).toBe(true);
    expect(initialReveal({ cc: '', bcc: '' }, 'ME@d3cloud.io', 'me@d3cloud.io').from).toBe(false);
  });

  it('reveals one row at a time and never closes one', () => {
    const start = { cc: false, bcc: false, from: false };
    const cc = reveal(start, 'cc');
    expect(cc).toEqual({ cc: true, bcc: false, from: false });
    expect(reveal(cc, 'cc')).toBe(cc);
    expect(reveal(cc, 'bcc')).toEqual({ cc: true, bcc: true, from: false });
  });
});

describe('the quote, folded behind "···" (MOD-07)', () => {
  it('splits a reply into what is being written and the quote, and joins them back losslessly', () => {
    const body = 'Sounds good.\n\nOn Sep 26, 2026, Priya wrote:\n> BOOKED.\n>\n> P';
    const split = splitQuote(body);
    expect(split.head).toBe('Sounds good.');
    expect(split.quote).toBe('\n\nOn Sep 26, 2026, Priya wrote:\n> BOOKED.\n>\n> P');
    expect(joinQuote(split.head, split.quote)).toBe(body);
  });

  it('folds the whole of a fresh reply prefill and a forward block', () => {
    const reply = draftFor('reply', { detail: { id: MSG, subject: 'Hi', from: 'a@x.org', date: '2026-09-26T12:00:00Z', messageIdHeader: '<m@x>', references: [] } as never, body: { text: 'Hello there', headers: [] } as never }, 'me@x.org');
    expect(splitQuote(reply.body).head).toBe('');
    expect(splitQuote(reply.body).quote).toContain('> Hello there');
    const fwd = draftFor('forward', { detail: { id: MSG, subject: 'Hi', from: 'a@x.org', date: '2026-09-26T12:00:00Z', messageIdHeader: '<m@x>', references: [] } as never, body: { text: 'Hello there', headers: [] } as never }, 'me@x.org');
    expect(splitQuote(fwd.body).quote).toMatch(/^\n\n-{10} Forwarded message -{10}/);
  });

  it('leaves a body with no quote alone', () => {
    expect(splitQuote('Just text\nOn my way.')).toEqual({ head: 'Just text\nOn my way.', quote: '' });
  });
});

describe('the formatting bar (Aa)', () => {
  it('wraps the selection, or a placeholder, in inline Markdown and selects the inside', () => {
    expect(applyFormat('make this bold', 5, 9, 'bold')).toEqual({ text: 'make **this** bold', start: 7, end: 11 });
    expect(applyFormat('x', 1, 1, 'italic')).toEqual({ text: 'x_italic text_', start: 2, end: 13 });
    expect(applyFormat('see docs', 4, 8, 'link').text).toBe('see [docs](https://)');
  });

  it('prefixes every selected line for a list or a quote', () => {
    expect(applyFormat('one\ntwo\nthree', 0, 7, 'list').text).toBe('- one\n- two\nthree');
    expect(applyFormat('a\nquoted line', 4, 6, 'quote').text).toBe('a\n> quoted line');
  });

  it('says which rare options are on, and nothing when none are', () => {
    expect(optionsSummary({ markdown: false, receipt: false, sign: false, encrypt: false, remind: false })).toBe('');
    expect(optionsSummary({ markdown: true, receipt: true, sign: true, encrypt: false, remind: true })).toBe('Markdown · Read receipt · Signed · Reminder');
  });
});

describe('resuming a draft in place', () => {
  it('routes ?compose=draft to the draft the path names, in the reading pane’s place', () => {
    const route = parseMailRoute(`/mail/${MB}/${MSG}`, '?compose=draft');
    expect(route?.compose).toBe('draft');
    expect(route?.messageId).toBe(MSG);
    expect(parseMailRoute(`/mail/${MB}`, '?compose=draft')?.compose).toBeNull();
    expect(mailPath(MB, MSG, 'draft')).toBe(`/mail/${MB}/${MSG}?compose=draft`);
    expect(narrowView({ mailboxIndex: false, mailboxId: MB, messageId: MSG, compose: 'draft', composeTo: null })).toBe('compose');
  });

  it('puts new and resumed drafts in the pane, replies and forwards inline under the thread', () => {
    expect(composesInPane('new')).toBe(true);
    expect(composesInPane('draft')).toBe(true);
    expect(composesInPane('reply')).toBe(false);
    expect(composesInPane('replyall')).toBe(false);
    expect(composesInPane('forward')).toBe(false);
    expect(composesInPane(null)).toBe(false);
  });

  it('starts blank, naming the draft to load', () => {
    const d = draftToResume(MSG);
    expect(d.resumeId).toBe(MSG);
    expect(d.to).toBe('');
    expect(d.sourceId).toBeNull();
  });

  it('keeps one composer across a draft’s saves, each of which answers with a new id', () => {
    const opened = '33333333-3333-4333-8333-333333333333';
    const key = composerKey(draftToResume(opened));
    expect(key).toBe(`draft:${opened}`);
    linkSavedDraft(key, 'saved-1');
    linkSavedDraft(key, 'saved-2');
    expect(composerKey(draftToResume('saved-1'))).toBe(key);
    expect(composerKey(draftToResume('saved-2'))).toBe(key);
    expect(composerKey(draftToResume('some-other-draft'))).not.toBe(key);
    // A new message keeps its composer when its first save moves the URL to ?compose=draft&id=.
    const fresh = composerKey(draftFor('new', null, null));
    expect(fresh).toBe('new:');
    linkSavedDraft(fresh, 'saved-new');
    expect(composerKey(draftToResume('saved-new'))).toBe('new:');
    // Once that composer closes, the draft opened again later gets a composer of its own.
    forgetDrafts('new:');
    expect(composerKey(draftToResume('saved-new'))).toBe('draft:saved-new');
    expect(composerKey(draftToResume('saved-1'))).toBe(key);
  });

  it('names a new message’s draft in the query, keeping what is open behind it, so a reload resumes it', () => {
    const DRAFT = '44444444-4444-4444-8444-444444444444';
    const behind = parseMailRoute(`/mail/${MB}/${MSG}`, '?compose=new');
    if (behind === null) throw new Error('route');
    const url = draftPath(behind, DRAFT);
    expect(url).toBe(`/mail/${MB}/${MSG}?compose=draft&id=${DRAFT}`);
    const [path, query] = url.split('?');
    const reloaded = parseMailRoute(path ?? '', `?${query ?? ''}`);
    expect(reloaded).toMatchObject({ mailboxId: MB, messageId: MSG, compose: 'draft', composeDraftId: DRAFT });
    expect(draftPath({ mailboxId: null, messageId: null, composeDraftId: null }, DRAFT)).toBe(`/?compose=draft&id=${DRAFT}`);
    expect(parseMailRoute('/', `?compose=draft&id=${DRAFT}`)).toMatchObject({ compose: 'draft', composeDraftId: DRAFT });
    expect(parseMailRoute('/', '?compose=draft')?.compose).toBeNull();
    expect(parseMailRoute('/', '?compose=draft&id=nope')?.compose).toBeNull();
    // Opened from Drafts the draft is the path's message, and its next id replaces it there.
    const fromDrafts = parseMailRoute(`/mail/${MB}/${MSG}`, '?compose=draft');
    if (fromDrafts === null) throw new Error('route');
    expect(fromDrafts.composeDraftId).toBe(MSG);
    expect(draftPath(fromDrafts, DRAFT)).toBe(`/mail/${MB}/${DRAFT}?compose=draft`);
  });
});
