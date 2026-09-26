// PST-T-3.11: what the composer sends and saves, which draft it picks up again, and how a refused
// send reads. The browser behaviour is e2e/tests/compose.spec.ts.
import { describe, expect, it } from 'vitest';
import { ApiError, type SavedDraft } from '../../src/api';
import { fieldsOf, hasRecipients, initialState, resumableDraft, sendErrorText, stateFromSaved, type ComposeDraft } from '../../src/mail/compose';

const SRC = '33333333-3333-4333-8333-333333333333';

const reply: ComposeDraft = {
  mode: 'reply',
  to: '"Doe, Jane" <jane@example.org>, bob@example.org',
  cc: '',
  subject: 'Re: Plans',
  inReplyTo: '<plans@example.org>',
  references: ['<root@example.org>', '<plans@example.org>'],
  body: '\n\nOn Thu, Jane wrote:\n> Plans?',
  sourceId: SRC,
};

const saved = (extra: Partial<SavedDraft> = {}): SavedDraft => ({
  id: '44444444-4444-4444-8444-444444444444',
  mailboxId: '55555555-5555-4555-8555-555555555555',
  from: 'me@d3cloud.io',
  to: ['Jane <jane@example.org>'],
  cc: [],
  bcc: ['hidden@example.org'],
  subject: 'Re: Plans',
  text: 'Draft text',
  inReplyTo: '<plans@example.org>',
  references: ['<plans@example.org>'],
  forwardOf: null,
  mode: 'reply',
  sourceId: SRC,
  savedAt: '2026-09-26T10:00:00.000Z',
  ...extra,
});

describe('the composer’s request (PST-REQ-079)', () => {
  it('splits address fields on the commas between addresses, not inside a quoted name', () => {
    const f = fieldsOf(initialState(reply));
    expect(f.to).toEqual(['"Doe, Jane" <jane@example.org>', 'bob@example.org']);
    expect(f.cc).toEqual([]);
    expect(f.bcc).toEqual([]);
    expect(f).toMatchObject({ subject: 'Re: Plans', inReplyTo: '<plans@example.org>', references: ['<root@example.org>', '<plans@example.org>'], forwardOf: null });
  });

  it('a forward attaches its source; a subject never carries a line break', () => {
    const fwd = initialState({ ...reply, mode: 'forward', to: '', inReplyTo: null, references: [] });
    expect(fwd.forwardOf).toBe(SRC);
    expect(fieldsOf({ ...fwd, subject: 'a\r\nb' }).subject).toBe('a b');
  });

  it('needs a recipient in To, Cc or Bcc', () => {
    const blank = initialState({ ...reply, to: '' });
    expect(hasRecipients(blank)).toBe(false);
    expect(hasRecipients({ ...blank, bcc: 'x@example.org' })).toBe(true);
  });
});

describe('drafts', () => {
  it('a saved draft comes back into the fields', () => {
    expect(stateFromSaved(saved())).toEqual({
      to: 'Jane <jane@example.org>',
      cc: '',
      bcc: 'hidden@example.org',
      subject: 'Re: Plans',
      text: 'Draft text',
      inReplyTo: '<plans@example.org>',
      references: ['<plans@example.org>'],
      forwardOf: null,
    });
  });

  it('only the same kind of answer to the same message is picked up again', () => {
    expect(resumableDraft([saved()], reply)?.text).toBe('Draft text');
    expect(resumableDraft([saved({ mode: 'replyall' })], reply)).toBeNull();
    expect(resumableDraft([saved({ sourceId: null })], reply)).toBeNull();
    expect(resumableDraft([saved()], { ...reply, sourceId: null })).toBeNull();
  });
});

describe('a refused send, in words', () => {
  it('names what to do', () => {
    expect(sendErrorText(new ApiError(503, 'dkim_unconfigured', {}))).toMatch(/DKIM/);
    expect(sendErrorText(new ApiError(429, 'recipient_cap', {}))).toMatch(/sending limit/);
    expect(sendErrorText(new ApiError(400, 'invalid_recipient', { error: 'invalid_recipient', message: 'to: "x" is not an address' }))).toBe('to: "x" is not an address');
    expect(sendErrorText(new TypeError('fetch failed'))).toMatch(/nothing was sent/);
  });
});
