// PST-T-9.2, PST-REQ-144: the composer's ; shortcut and {{variable}} filling, pure and unit-tested
// without a DOM.
import { describe, expect, it } from 'vitest';
import { applyTemplate, fillTemplateText, matchingTemplates, sendExtra, templateTrigger, type ComposeState, type ComposeTemplateLike } from '../../src/mail/compose';

describe('fillTemplateText', () => {
  it('fills known variables and blanks an unknown one', () => {
    expect(fillTemplateText('Hi {{first_name}}, best, {{name}} ({{date}}) {{nope}}', { first_name: 'Ada', name: 'Ada Lovelace', date: 'Jan 1' })).toBe('Hi Ada, best, Ada Lovelace (Jan 1) ');
  });

  it('defaults {{date}} to today when not given', () => {
    expect(fillTemplateText('{{date}}', {})).not.toBe('');
  });
});

describe('templateTrigger', () => {
  it('detects ; at the start of the text', () => {
    expect(templateTrigger(';sig', 4)).toEqual({ shortcut: 'sig', start: 0, end: 4 });
  });

  it('detects ; after whitespace', () => {
    expect(templateTrigger('Hello ;si', 9)).toEqual({ shortcut: 'si', start: 6, end: 9 });
  });

  it('is null mid-word (an email address, say)', () => {
    expect(templateTrigger('a;b', 3)).toBeNull();
  });

  it('is null with no ; at all', () => {
    expect(templateTrigger('hello', 5)).toBeNull();
  });

  it('is present right after typing just ;', () => {
    expect(templateTrigger('Hi ;', 4)).toEqual({ shortcut: '', start: 3, end: 4 });
  });
});

describe('matchingTemplates', () => {
  const templates: ComposeTemplateLike[] = [
    { shortcut: 'sig', name: 'Signature', subject: null, body: 'Best,\n{{name}}' },
    { shortcut: 'sig2', name: 'Signature v2', subject: null, body: 'Cheers,\n{{name}}' },
    { shortcut: 'oos', name: 'Out of office', subject: 'Away', body: 'I am away.' },
  ];

  it('matches by shortcut prefix, case-insensitively', () => {
    expect(matchingTemplates(templates, 'sig').map((t) => t.shortcut)).toEqual(['sig', 'sig2']);
    expect(matchingTemplates(templates, 'SIG').map((t) => t.shortcut)).toEqual(['sig', 'sig2']);
  });

  it('an empty query matches everything', () => {
    expect(matchingTemplates(templates, '')).toHaveLength(3);
  });

  it('no match is an empty list', () => {
    expect(matchingTemplates(templates, 'zzz')).toEqual([]);
  });
});

describe('applyTemplate', () => {
  it('replaces the trigger range with the filled body and places the cursor after it', () => {
    const template: ComposeTemplateLike = { shortcut: 'sig', name: 'Signature', subject: null, body: 'Best,\n{{name}}' };
    const result = applyTemplate('Hi there\n\n;sig', { start: 10, end: 15 }, template, { name: 'Ada' });
    expect(result.text).toBe('Hi there\n\nBest,\nAda');
    expect(result.cursor).toBe(result.text.length);
  });
});

describe('sendExtra', () => {
  it('carries format and requestReceipt from the composer state', () => {
    const state: ComposeState = {
      to: '',
      cc: '',
      bcc: '',
      subject: '',
      text: '',
      inReplyTo: null,
      references: [],
      forwardOf: null,
      format: 'markdown',
      requestReceipt: true,
    };
    expect(sendExtra(state)).toEqual({ format: 'markdown', requestReceipt: true });
  });
});
