import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_SNIPPET_LENGTH, snippetOf } from '../../src/snippet.js';

describe('snippetOf (PST-T-14.2)', () => {
  it('collapses whitespace into one line', () => {
    expect(snippetOf('Hi Mat,\r\n\r\n  Photos   from\tSunday are up.\n')).toBe('Hi Mat, Photos from Sunday are up.');
  });

  it('drops quoted lines and everything after a reply attribution', () => {
    const body = 'Sounds good, see you then.\n\nOn Sun, 28 Sep 2026 at 10:00, Linda <l@example.com> wrote:\n> Lunch on Friday?\n> Linda';
    expect(snippetOf(body)).toBe('Sounds good, see you then.');
  });

  it('stops at an Outlook original-message marker, a forward marker and a signature', () => {
    expect(snippetOf('Top reply\n-----Original Message-----\nFrom: x')).toBe('Top reply');
    expect(snippetOf('FYI\n\nBegin forwarded message:\n\nFrom: y')).toBe('FYI');
    expect(snippetOf('Short note\n-- \nMat Demers\nd3cloud.io')).toBe('Short note');
  });

  it('skips interleaved quotes but keeps the replies between them', () => {
    expect(snippetOf('> question one\nanswer one\n> question two\nanswer two')).toBe('answer one answer two');
  });

  it('removes invisible preheader padding', () => {
    expect(snippetOf('Sale starts now\u034f \u200c\u034f \u200c\u00ad\ufeff ends Sunday')).toBe('Sale starts now ends Sunday');
  });

  it('previews an OpenPGP-armoured body as nothing', () => {
    expect(snippetOf('-----BEGIN PGP MESSAGE-----\n\nhQEMA...\n-----END PGP MESSAGE-----')).toBe('');
  });

  it('is empty for an empty body', () => {
    expect(snippetOf('')).toBe('');
    expect(snippetOf(' \n\t ')).toBe('');
  });

  it('cuts a long body to 140 characters ending in an ellipsis', () => {
    const out = snippetOf('word '.repeat(100));
    expect(out.length).toBeLessThanOrEqual(MAX_SNIPPET_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair when it cuts', () => {
    const out = snippetOf('😀'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(MAX_SNIPPET_LENGTH);
    expect(out).toBe(`${'😀'.repeat(69)}…`);
  });

  it('property: always one line, at most 140 code units, no leading/trailing space', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000, unit: 'binary' }), (s) => {
        const out = snippetOf(s);
        expect(out.length).toBeLessThanOrEqual(MAX_SNIPPET_LENGTH);
        expect(out).not.toMatch(/[\r\n]/);
        expect(out).toBe(out.trim());
      }),
    );
  });
});
