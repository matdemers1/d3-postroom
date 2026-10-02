// PST-T-9.2, PST-REQ-144: the composer's ; shortcut and {{variable}} filling, pure and unit-tested
// without a DOM.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bodyPreview, templateDescription } from '../../src/compose/template-preview';
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

// PST-T-17.10 (PST-REQ-194): a saved reply's row says what it says, not "No subject".
describe('bodyPreview', () => {
  it('puts the body on one line', () => {
    expect(bodyPreview('Thanks for reaching out.\n\nBest,\n{{name}}')).toBe('Thanks for reaching out. Best, {{name}}');
  });

  it('cuts a long body at a word near 60 characters, with an ellipsis', () => {
    const long = 'I am out of the office until Monday and will reply to your message as soon as I am back.';
    const preview = bodyPreview(long);
    expect(preview.length).toBeLessThanOrEqual(61);
    expect(preview.endsWith('…')).toBe(true);
    expect(long.startsWith(preview.slice(0, -1))).toBe(true);
    expect(preview).toBe('I am out of the office until Monday and will reply to your…');
  });

  it('leaves a short body alone, and an empty one empty', () => {
    expect(bodyPreview('Short.')).toBe('Short.');
    expect(bodyPreview('   ')).toBe('');
  });
});

describe('templateDescription', () => {
  it('is the body preview when there is no subject', () => {
    expect(templateDescription({ subject: null, body: 'Thanks!' })).toBe('Thanks!');
    expect(templateDescription({ subject: '  ', body: 'Thanks!' })).toBe('Thanks!');
  });

  it('leads with the subject when there is one', () => {
    expect(templateDescription({ subject: 'Away', body: 'I am away.' })).toBe('Away · I am away.');
    expect(templateDescription({ subject: 'Away', body: '' })).toBe('Away');
  });
});

describe('the Templates screen', () => {
  const source = readFileSync(join(import.meta.dirname, '../../src/compose/TemplatesScreen.tsx'), 'utf8');

  it('is titled as its nav entry, centred, with one Saved replies card holding New template', () => {
    expect(source).toContain('title="Templates"');
    expect(source).toContain('<Page width="narrow" align="center">');
    expect(source).toMatch(/<Section\s+title="Saved replies"\s+actions=/);
  });

  it('opens the form inside that card on the 164/360 grid, with Delete at its foot, not in the row', () => {
    expect(source).toContain('className="pr-setform pr-inline-form"');
    expect(source).toContain('className="pr-setform__actions"');
    // One action per row: Edit, secondary. The only Delete trigger is the edit form's leading action.
    expect(source).toContain('aria-label={`Edit ${t.name}`}');
    expect(source.match(/variant="danger-ghost"/g)).toHaveLength(1);
    expect(source.indexOf('variant="danger-ghost"')).toBeLessThan(source.indexOf('<DataList'));
  });

  it('shows the shortcut as a key chip and the body preview, with a row-size empty state', () => {
    expect(source).toContain('<kbd className="pr-tpl-key">;{t.shortcut}</kbd>');
    expect(source).toContain('description={templateDescription(t)}');
    expect(source).not.toContain("'No subject'");
    expect(source).toMatch(/<EmptyState kind="empty" heading="No templates yet" headingLevel=\{3\} size="row">/);
  });
});
