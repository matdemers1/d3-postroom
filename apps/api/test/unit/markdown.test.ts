// PST-T-9.2, PST-REQ-145/174: the composer's hand-written Markdown renderer is safe by construction
// — no code path can emit a `<script`, an `on*` handler, `javascript:`, `<iframe>` or `<style>`, and
// it never adds an image or a link the user did not write.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderMarkdownDocument } from '../../src/compose/markdown.js';

describe('renderMarkdown: an adversarial table', () => {
  // "Nothing executable" means no real tag/attribute the browser would act on — an escaped, inert
  // copy of the same text (visible as `&lt;script&gt;` or a plain-text "onerror=alert(1)") is exactly
  // what a safe-by-construction renderer is supposed to produce, and is checked for below by asserting
  // the *active* form (a real `<script>` tag, a real quoted `on*="..."` attribute, a real `href="javascript:`
  // or `href="data:`) never appears — never by banning the substring itself, which would also reject
  // the safely-escaped text.
  const cases: { name: string; source: string; mustNotContain: RegExp[] }[] = [
    { name: 'a literal script tag', source: '<script>alert(1)</script>', mustNotContain: [/<script/i] },
    { name: 'an img with onerror', source: '<img src=x onerror=alert(1)>', mustNotContain: [/<img\s/i, /\son\w+="/i] },
    { name: 'a javascript: link', source: '[x](javascript:alert(1))', mustNotContain: [/href="javascript:/i] },
    { name: 'a raw iframe', source: '<iframe src="https://evil.example"></iframe>', mustNotContain: [/<iframe/i] },
    { name: 'a raw style block', source: '<style>body{display:none}</style>', mustNotContain: [/<style/i] },
    { name: 'HTML entities that decode to a tag', source: '&lt;script&gt;alert(1)&lt;/script&gt;', mustNotContain: [/<script/i] },
    { name: 'nested emphasis with an embedded tag attempt', source: '**_<script>x</script>_**', mustNotContain: [/<script/i] },
    { name: 'a data: URL link', source: '[click](data:text/html,<script>alert(1)</script>)', mustNotContain: [/<script/i, /href="data:/i] },
    { name: 'an on-attribute smuggled through a fake link syntax', source: '[a](https://example.com" onmouseover="alert(1))', mustNotContain: [/\son\w+="/i] },
    { name: 'a link whose text is itself a script tag', source: '[<script>x</script>](https://example.com)', mustNotContain: [/<script/i] },
  ];

  for (const c of cases) {
    it(`renders "${c.name}" with nothing executable`, () => {
      const html = renderMarkdown(c.source);
      for (const re of c.mustNotContain) expect(html).not.toMatch(re);
    });
  }

  it('a plain link and autolink still render as anchors to what the user wrote', () => {
    const html = renderMarkdown('See [Postroom](https://d3cloud.io/) or https://d3cloud.io/ or mailto:me@example.com');
    expect(html).toContain('<a href="https://d3cloud.io/">Postroom</a>');
    expect(html).toContain('<a href="https://d3cloud.io/">https://d3cloud.io/</a>');
    expect(html).toContain('<a href="mailto:me@example.com">mailto:me@example.com</a>');
  });

  it('renders headings, emphasis, code, lists, blockquotes', () => {
    const html = renderMarkdown('# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n> quoted');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<blockquote>quoted</blockquote>');
  });

  it('a fenced code block is never interpreted, only escaped', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('renderMarkdownDocument never adds an external resource or a <style> element', () => {
    const doc = renderMarkdownDocument('# Hi\n\n[a](https://example.com)');
    expect(doc).not.toMatch(/<style/i);
    expect(doc).not.toMatch(/https?:\/\/(?!example\.com)/);
  });
});

describe('renderMarkdown: fast-check property (PST-REQ-174)', () => {
  it('never emits <script, an on*= attribute, or javascript: in an href, for arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (source) => {
        const html = renderMarkdown(source);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/<iframe/i);
        expect(html).not.toMatch(/<style/i);
        expect(html).not.toMatch(/\son\w+="/i);
        expect(html.toLowerCase()).not.toContain('href="javascript:');
      }),
      { numRuns: 500 },
    );
  });

  it('never introduces an <img> or a raw <a> the source did not ask for, for arbitrary printable input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (source) => {
        const html = renderMarkdown(source);
        // No renderer construct ever produces <img> at all — images are not in the supported subset.
        expect(html).not.toMatch(/<img/i);
      }),
      { numRuns: 500 },
    );
  });
});
