// The mail HTML sanitizer (PST-T-3.12, PST-REQ-081, PST-REQ-082): known payloads, and fast-check
// properties — the output never contains `<script`, an `on…=` handler, `javascript:` or `url(`; it
// is a fixed point; and it never throws, whatever the input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitizeInlineStyle, sanitizeStylesheet } from '../../src/usercontent/css.js';
import { BLOCKED_IMAGE, sanitizeHtml } from '../../src/usercontent/sanitize.js';
import { tokenize } from '../../src/usercontent/tokenizer.js';

const clean = (html: string): string => sanitizeHtml(html).html;
const FORBIDDEN = [/<script/i, /on\w+=/i, /javascript:/i, /url\(/i];

function assertSafe(out: string): void {
  for (const re of FORBIDDEN) expect(out, `matched ${String(re)}`).not.toMatch(re);
}

describe('tokenizer', () => {
  it('reads tags, attributes (quoted, unquoted, bare) and decodes references', () => {
    const tokens = [...tokenize('<A HREF="x&amp;y" data=z checked>a &lt; b</a>')];
    expect(tokens).toEqual([
      { type: 'start', name: 'a', attrs: [['href', 'x&y'], ['data', 'z'], ['checked', '']], selfClosing: false },
      { type: 'text', text: 'a < b' },
      { type: 'end', name: 'a' },
    ]);
  });

  it('treats script content as raw text up to its end tag', () => {
    const tokens = [...tokenize('<script>if (a < b) x("</p>")</script>after')];
    expect(tokens[1]).toEqual({ type: 'raw', name: 'script', text: 'if (a < b) x("</p>")' });
    expect(tokens.at(-1)).toEqual({ type: 'text', text: 'after' });
  });

  it('drops a tag the input ends inside of, and skips comments and doctypes', () => {
    expect([...tokenize('<!doctype html><!-- hi --><p>x<img src="unterminated')]).toEqual([
      { type: 'start', name: 'p', attrs: [], selfClosing: false },
      { type: 'text', text: 'x' },
    ]);
  });

  it('keeps the first of a repeated attribute', () => {
    const [tag] = [...tokenize('<p title=a title=b>')];
    expect(tag).toMatchObject({ attrs: [['title', 'a']] });
  });
});

describe('sanitizeHtml: payloads', () => {
  const payloads: [string, string][] = [
    ['script', '<p>hi</p><script>alert(1)</script>'],
    ['script with odd case and attributes', '<ScRiPt src="//evil/x.js" defer></sCrIpT>'],
    ['onerror', '<img src=x onerror=alert(1)>'],
    ['svg onload', '<svg onload=alert(1)><circle/></svg>'],
    ['svg script', '<svg><script>alert(1)</script></svg>'],
    ['javascript href', '<a href="javascript:alert(1)">x</a>'],
    ['javascript href with entities and whitespace', '<a href=" jav&#x09;ascript&colon;alert(1)">x</a>'],
    ['javascript href with tab', '<a href="java\tscript:alert(1)">x</a>'],
    ['data href', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ['vbscript', '<a href="vbscript:msgbox(1)">x</a>'],
    ['iframe', '<iframe src="https://evil.example/"></iframe>'],
    ['srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['object', '<object data="x.swf"><param name=a value=b></object>'],
    ['embed', '<embed src="x.swf">'],
    ['form', '<form action="https://evil/"><input name=q><button formaction="https://evil">go</button></form>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil/">'],
    ['base', '<base href="https://evil/">'],
    ['link stylesheet', '<link rel=stylesheet href="https://evil/x.css">'],
    ['style expression', '<div style="width: expression(alert(1))">x</div>'],
    ['style url', '<div style="background: url(https://evil/p.png)">x</div>'],
    ['style escaped url', '<div style="background: u\\72l(https://evil/p.png)">x</div>'],
    ['style block import', '<style>@import url(https://evil/x.css); p{color:red}</style>'],
    ['style block url', '<style>body{background-image:url("https://evil/p.png")}</style>'],
    ['style -moz-binding', '<p style="-moz-binding: url(x.xml#a)">x</p>'],
    ['style behavior', '<p style="behavior: url(x.htc)">x</p>'],
    ['closing style early', '<style>p{color:red}</style><style></style ><img src=x onerror=alert(1)>'],
    ['noscript differential', '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
    ['comment differential', '<!--<img src="--><img src=x onerror=alert(1)//">'],
    ['math', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>'],
    ['template', '<template><img src=x onerror=alert(1)></template>'],
    ['attribute breakout', '<p title="a&quot; onmouseover=&quot;alert(1)">x</p>'],
    ['unquoted breakout', '<p title=a onmouseover=alert(1)>x</p>'],
    ['slash-separated handler', '<img/src=x/onerror=alert(1)>'],
    ['srcset', '<img srcset="https://evil/a.png 1x">'],
    ['background attribute', '<table background="https://evil/bg.png"><tr><td background="https://evil/c.png">x</td></tr></table>'],
    ['textarea', '<textarea><script>alert(1)</script></textarea>'],
    ['plaintext', '<plaintext><script>alert(1)</script>'],
    ['xmp', '<xmp><img src=x onerror=alert(1)></xmp>'],
    ['on handler in text', 'onclick=alert(1) and javascript:void(0) and url(x)'],
    ['split by dropped tag', 'java<x>script:alert(1) u<y>rl(x)'],
    ['nul in tag name', '<scr\0ipt>alert(1)</scr\0ipt>'],
  ];
  for (const [name, html] of payloads) {
    it(`neutralises: ${name}`, () => {
      const out = clean(html);
      assertSafe(out);
      expect(out).not.toMatch(/<(?:iframe|object|embed|form|input|button|meta|base|link|svg|math|template|textarea|xmp|plaintext)\b/i);
      expect(out).not.toMatch(/evil/);
      expect(clean(out)).toBe(out);
    });
  }

  it('keeps ordinary mail: tables, fonts, links, lists and safe styles', () => {
    const html =
      '<html><head><title>T</title><style>.x{color:#123456}</style></head><body bgcolor="#ffffff">' +
      '<table width="100%" cellpadding="4"><tr><td align="center" style="color: red; position: fixed">Hi <b>there</b></td></tr></table>' +
      '<font face="Arial" color="blue">f</font><center>c</center><ul><li>one</li></ul>' +
      '<a href="https://example.com/?a=1&amp;b=2" target="_self" rel="opener">link</a>' +
      '<a href="mailto:x@example.com">mail</a><a href="#top">top</a></body></html>';
    const out = clean(html);
    expect(out).toContain('<style>.x{color: #123456}</style>');
    expect(out).toContain('<div bgcolor="#ffffff">');
    expect(out).toContain('<td align="center" style="color: red">');
    expect(out).toContain('<font face="Arial" color="blue">f</font>');
    expect(out).toContain('<a href="https://example.com/?a&#61;1&amp;b&#61;2" target="_blank" rel="noopener noreferrer">link</a>');
    expect(out).toContain('<a href="mailto:x@example.com" target="_blank" rel="noopener noreferrer">mail</a>');
    expect(out).toContain('<a href="#top"');
    expect(out).not.toContain('<title');
    expect(out).not.toContain('position');
  });

  it('balances what the sender left open or closed twice', () => {
    expect(clean('<div><p><b>x</div></p></b>')).toBe('<div><p><b>x</b></p></div>');
    expect(clean('<table><tr><td>x')).toBe('<table><tr><td>x</td></tr></table>');
  });
});

describe('sanitizeHtml: images', () => {
  it('blocks a remote image by default, keeping its address in data-src', () => {
    const r = sanitizeHtml('<img src="http://tracker.example/p.png?u=1" width=1 alt="">');
    expect(r.remoteImages).toBe(1);
    expect(r.blockedImages).toBe(1);
    expect(r.html).toBe(`<img src="${BLOCKED_IMAGE}" data-src="http://tracker.example/p.png?u&#61;1" width="1" alt="">`);
    expect(clean(r.html)).toBe(r.html);
  });

  it('routes a remote image through the caller when images are loaded', () => {
    const r = sanitizeHtml('<img src="//cdn.example/a.png">', { remoteImage: (u) => `https://uc.example/img?u=${encodeURIComponent(u)}` });
    expect(r.blockedImages).toBe(0);
    expect(r.html).toBe('<img src="https://uc.example/img?u&#61;https%3A%2F%2Fcdn.example%2Fa.png">');
  });

  it('resolves cid: images through the caller and keeps data: images', () => {
    const r = sanitizeHtml('<img src="cid:logo@x"><img src="data:image/png;base64,iVBORw0KGgo="><img src="data:image/svg+xml;base64,PHN2Zz4=">', {
      cidImage: (cid) => `https://uc.example/m/T/cid/${encodeURIComponent(cid)}`,
    });
    expect(r.html).toBe('<img src="https://uc.example/m/T/cid/logo%40x"><img src="data:image/png;base64,iVBORw0KGgo&#61;"><img>');
    expect(r.remoteImages).toBe(0);
  });

  it('drops a non-image scheme in src', () => {
    expect(clean('<img src="javascript:alert(1)"><img src="file:///etc/passwd">')).toBe('<img><img>');
  });
});

describe('css', () => {
  it('keeps safe declarations and drops the rest', () => {
    expect(sanitizeInlineStyle('color:red;background:url(x);font-family:"Helvetica Neue", Arial;position:absolute;width:calc(100% - 2px)')).toBe(
      'color: red; font-family: "Helvetica Neue", Arial; width: calc(100% - 2px)',
    );
    expect(sanitizeInlineStyle('color: image-set("x.png" 1x)')).toBe('');
    expect(sanitizeInlineStyle('color:red;/* x */\\75rl(x)')).toBe('');
  });

  it('keeps @media, drops every other at-rule and attribute-value selectors', () => {
    const sheet = '<!-- @charset "utf-8"; @font-face{src:url(x)} @media screen and (max-width: 600px){.a{width:100%}} a[href^=http]{color:red} p{margin:0} -->';
    expect(sanitizeStylesheet(sheet)).toBe('@media screen and (max-width: 600px){.a{width: 100%}}\np{margin: 0}');
  });
});

describe('sanitizeHtml: properties', () => {
  // Markup-heavy strings: fragments of real payloads glued together at random.
  const pieces = fc.constantFrom(
    '<', '>', '/', '"', "'", '=', ' ', '&', ';', '#', ':', '(', ')', '\\', '\n', '\t', '\0', '-', '!', '?',
    '<script>', '</script>', '<style>', '</style>', '<svg', '<math>', '<img', '<a', '<p', '</p>', '<div', '</div>',
    '<table>', '<td', '<!--', '-->', '<![CDATA[', ']]>', '<noscript>', '</noscript>', '<textarea>', '<title>',
    '<iframe', '<object', '<template>', '<body', '</body>', '<br/>', 'src', 'href', 'style', 'onerror', 'onload',
    'on', 'error', 'javascript', 'java', 'script', 'url', 'expression', 'data:', 'http://h/x.png', 'cid:a',
    '&#106;', '&#x3a;', '&colon;', '&lt;', '&amp;', '&quot;', '&#0;', 'color:red', '@import', '\\75', 'x',
  );
  const markup = fc.array(fc.oneof(pieces, fc.string({ maxLength: 4 })), { maxLength: 60 }).map((a) => a.join(''));
  const input = fc.oneof(markup, fc.string({ maxLength: 200 }), fc.string({ unit: 'binary', maxLength: 100 }));

  it('never emits <script, on…=, javascript: or url(', () => {
    fc.assert(
      fc.property(input, (html) => {
        const out = clean(html);
        return FORBIDDEN.every((re) => !re.test(out));
      }),
      { numRuns: 3000 },
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(input, (html) => {
        const once = clean(html);
        return clean(once) === once;
      }),
      { numRuns: 3000 },
    );
  });

  it('never throws, with options set too', () => {
    fc.assert(
      fc.property(input, fc.boolean(), (html, load) => {
        sanitizeHtml(html, { remoteImage: load ? (u) => `https://uc/img?u=${encodeURIComponent(u)}` : undefined, cidImage: () => null });
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it('stays linear on a large, hostile message', () => {
    const big = '<div><p style="color:red">x &amp; y</p><img src=http://h/a.png onerror=1><!-- c --></div>'.repeat(20_000) + '<script>'.repeat(1000);
    const started = Date.now();
    const out = clean(big);
    expect(Date.now() - started).toBeLessThan(5_000);
    assertSafe(out);
  });
});
