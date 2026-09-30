// PST-T-15.12 (PST-REQ-194, PST-REQ-081): HTML mail without the white box. A plain message — an
// Outlook reply is the canonical one — renders in the app's own ink and theme; a designed one (it
// paints its own page) keeps its white page. In the dark theme a plain message's near-black text is
// dropped so the reader's light ink shows. The served document wraps the body in Cloudflare's
// email_off markers so addresses are not obfuscated. None of it widens the sanitizer.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DESIGNED_STYLE, mintRenderUrl, NARROW_FIT_STYLE, plainStyle, renderDocument, type UsercontentConfig } from '../../src/usercontent/index.js';
import { sanitizeHtml } from '../../src/usercontent/sanitize.js';
import { declarationsDesigned, isDesignedBackground, isNearBlack, parseColor, parseTheme, relativeLuminance } from '../../src/usercontent/theme.js';
import { verifyToken } from '../../src/usercontent/token.js';

/** What Outlook desktop sends for a short reply: MsoNormal paragraphs, black/windowtext, no background. */
const OUTLOOK_REPLY = [
  '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta name=Generator content="Microsoft Word 15 (filtered medium)">',
  '<style><!--',
  '@font-face {font-family:"Cambria Math";}',
  'p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0in; font-size:11.0pt; font-family:"Calibri",sans-serif;}',
  'a:link, span.MsoHyperlink {mso-style-priority:99; color:#0563C1; text-decoration:underline;}',
  'span.EmailStyle17 {mso-style-type:personal-compose; font-family:"Calibri",sans-serif; color:windowtext;}',
  '@page WordSection1 {size:8.5in 11.0in; margin:1.0in 1.0in 1.0in 1.0in;}',
  'div.WordSection1 {page:WordSection1;}',
  '--></style></head>',
  '<body lang=EN-US link="#0563C1" vlink="#954F72" style=\'word-wrap:break-word\'><div class=WordSection1>',
  '<p class=MsoNormal>test 2<o:p></o:p></p><p class=MsoNormal>V/R<o:p></o:p></p><p class=MsoNormal>Matthew Demers<o:p></o:p></p>',
  '<div style=\'border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in\'>',
  '<p class=MsoNormal><b><span style=\'color:black\'>From:</span></b><span style=\'color:black\'> Matthew Demers &lt;matthew@d3cloud.io&gt;<br>',
  '<b>Sent:</b> Tuesday, September 29, 2026 9:12 PM<br><b>To:</b> someone@example.org<br><b>Subject:</b> test</span></p></div>',
  '<p class=MsoNormal><font color="#000000">old words</font> and <span style="color:#ff6600">orange words</span></p>',
  '</div></body></html>',
].join('\n');

describe('theme parameter', () => {
  it('is dark only when it says dark', () => {
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    for (const raw of [undefined, '', 'DARK', 'dim', ['dark'], 1]) expect(parseTheme(raw)).toBe('light');
  });
});

describe('colours', () => {
  it('parses hex, rgb(), hsl() and named colours', () => {
    expect(parseColor('#fff')?.rgb).toEqual([255, 255, 255]);
    expect(parseColor('#0563C1')?.rgb).toEqual([5, 99, 193]);
    expect(parseColor('#00000000')?.alpha).toBe(0);
    expect(parseColor('rgb(0, 0, 0)')?.rgb).toEqual([0, 0, 0]);
    expect(parseColor('rgba(255 255 255 / 50%)')?.alpha).toBeCloseTo(0.5);
    expect(parseColor('hsl(0, 0%, 100%)')?.rgb.map(Math.round)).toEqual([255, 255, 255]);
    expect(parseColor('Black !important')?.rgb).toEqual([0, 0, 0]);
    expect(parseColor('currentcolor')).toBeNull();
    expect(parseColor('linear-gradient(red, blue)')).toBeNull();
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1);
    expect(relativeLuminance([0, 0, 0])).toBe(0);
  });

  it('calls near-black the black keywords and anything under luminance 0.2', () => {
    for (const v of ['black', 'WindowText', 'windowframe', 'buttontext', '-webkit-text', '#000', '#000000', '#111', '#333333', 'rgb(0,0,0)', 'black !important', 'navy', '#1f1f1f'])
      expect(isNearBlack(v), v).toBe(true);
    for (const v of ['white', '#E1E1E1', '#ff6600', 'red', 'orange', '#888888', 'transparent', 'currentcolor', 'inherit', 'rgba(0,0,0,0)'])
      expect(isNearBlack(v), v).toBe(false);
  });
});

describe('designed detection', () => {
  it('counts a background declaration that is not white or a no-op', () => {
    for (const [p, v] of [['background-color', '#f4f4f4'], ['background', '#1a1a1a'], ['background', 'red'], ['background-image', 'linear-gradient(red, blue)'], ['Background-Color', 'rgb(250,250,250)']] as const)
      expect(isDesignedBackground(p, v), `${p}: ${v}`).toBe(true);
    for (const [p, v] of [['background', 'white'], ['background-color', '#fff'], ['background-color', '#FFFFFF'], ['background', 'transparent'], ['background', 'inherit'], ['background-color', 'initial'], ['background-image', 'none'], ['background', 'none'], ['color', '#000'], ['background-color', 'rgba(0,0,0,0)']] as const)
      expect(isDesignedBackground(p, v), `${p}: ${v}`).toBe(false);
  });

  it('finds them in style attributes and stylesheets, and ignores look-alike properties', () => {
    expect(declarationsDesigned('color:red; background-color: #eee')).toBe(true);
    expect(declarationsDesigned('p { margin:0 }\n.x{background:#123456}')).toBe(true);
    expect(declarationsDesigned('body{background:#fff} p{color:black}')).toBe(false);
    expect(declarationsDesigned('mso-background:#000; -webkit-background-color:#000')).toBe(false);
    expect(declarationsDesigned('/* background:#000 */ color:black')).toBe(false);
  });

  it('calls an Outlook reply plain', () => {
    expect(sanitizeHtml(OUTLOOK_REPLY).designed).toBe(false);
  });

  it('calls a message designed for any bgcolor or background attribute, or a painted background', () => {
    const designed = (html: string): boolean => sanitizeHtml(html).designed;
    expect(designed('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>')).toBe(true);
    expect(designed('<td background="https://example.org/bg.png">x</td>')).toBe(true);
    expect(designed('<body bgcolor="#eeeeee">x</body>')).toBe(true);
    expect(designed('<div style="background-color:#f4f4f4">x</div>')).toBe(true);
    expect(designed('<style>.card{background:#222}</style><p>x</p>')).toBe(true);
    expect(designed('<p style="background:white">x</p><style>body{background-color:#ffffff}</style>')).toBe(false);
    expect(designed('<p>just words</p>')).toBe(false);
    // Only elements and stylesheets the sanitizer keeps count.
    expect(designed('<svg><rect style="background:#000"/></svg><p>x</p>')).toBe(false);
  });
});

describe('dark plain rendering', () => {
  const dark = sanitizeHtml(OUTLOOK_REPLY, { darkPlain: true }).html;
  const light = sanitizeHtml(OUTLOOK_REPLY).html;

  it('drops near-black text colours from style attributes, stylesheets and <font color>', () => {
    expect(light).toContain('color: black');
    expect(light).toContain('color: windowtext');
    expect(light).toContain('color="#000000"');
    expect(dark).not.toMatch(/color: black|color: windowtext|color="#000000"/);
    // The Outlook link blue is near-black on a dark surface too, so the theme's link colour shows.
    expect(dark).not.toContain('#0563C1');
  });

  it('keeps coloured text, the separator border and everything else', () => {
    expect(dark).toContain('color: #ff6600');
    expect(dark).toContain('border-top: solid #E1E1E1 1.0pt');
    expect(dark).toContain('matthew@d3cloud.io');
    expect(dark).toContain('font-family: "Calibri",sans-serif');
  });

  it('drops a white background, which would otherwise box light text in white', () => {
    const out = sanitizeHtml('<p style="background:white; color:#000; margin:0">x</p>', { darkPlain: true }).html;
    expect(out).toBe('<p style="margin: 0">x</p>');
  });

  it('only ever removes: without darkPlain the output is unchanged, and with it it stays safe and a fixed point', () => {
    const fragment = fc.constantFrom(
      '<p style="color:black">a</p>', '<font color="#111">b</font>', '<span style="color:red">c</span>', '<style>p{color:windowtext;margin:0}</style>',
      '<a href="https://example.org/">d</a>', '<script>alert(1)</script>', '<div style="background:url(x)">e</div>', '<img src=x onerror=alert(1)>', 'text & more',
    );
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 8 }), (parts) => {
        const html = parts.join('');
        const out = sanitizeHtml(html, { darkPlain: true }).html;
        expect(out).not.toMatch(/<script|on\w+=|javascript:|url\(/i);
        expect(sanitizeHtml(out, { darkPlain: true }).html).toBe(out);
        expect(out.length).toBeLessThanOrEqual(sanitizeHtml(html).html.length);
      }),
    );
  });
});

describe('the served document', () => {
  it('wraps the body in Cloudflare email_off markers, after sanitization', () => {
    const body = sanitizeHtml('<!--email_off--><p>Write to matthew@d3cloud.io</p><!--/email_off-->').html;
    expect(body).toBe('<p>Write to matthew@d3cloud.io</p>');
    const doc = renderDocument(body, { designed: false, theme: 'dark' });
    expect(doc).toContain('<body><!--email_off--><p>Write to matthew@d3cloud.io</p><!--/email_off--></body>');
    expect(renderDocument(body, { designed: true, theme: 'light' })).toContain('<body><!--email_off-->');
  });

  it('renders a plain message transparent, in the theme ink, 16px/1.6, no padding, color-scheme matched', () => {
    const doc = renderDocument('<p>x</p>', { designed: false, theme: 'dark' });
    expect(doc).toContain(`<style>${plainStyle('dark')}</style>`);
    expect(plainStyle('dark')).toContain(':root{color-scheme:dark}html{background:transparent;color:#f0f2f7}');
    expect(plainStyle('dark')).toContain('a{color:#b8b4ff}');
    expect(plainStyle('light')).toContain(':root{color-scheme:light}html{background:transparent;color:#101117}');
    expect(plainStyle('light')).toContain('a{color:#5432be}');
    expect(plainStyle('light')).toContain('body{margin:0;padding:0;font:16px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;');
    expect(plainStyle('dark')).toContain(NARROW_FIT_STYLE);
    expect(doc).not.toMatch(/#fff\b/);
  });

  it('renders a designed message on the white page it always had, whatever the theme', () => {
    for (const theme of ['light', 'dark'] as const) {
      const doc = renderDocument('<p>x</p>', { designed: true, theme });
      expect(doc).toContain(`<style>${DESIGNED_STYLE}</style>`);
    }
    expect(DESIGNED_STYLE.startsWith(':root{color-scheme:light}html{background:#fff;color:#111}body{margin:0;padding:12px;font:14px/1.5 ')).toBe(true);
    expect(DESIGNED_STYLE).toContain(NARROW_FIT_STYLE);
  });

  it('carries the theme on the render URL, outside the capability', () => {
    const config = { origin: 'https://usercontent.example', host: 'usercontent.example', webOrigin: 'https://mail.example', key: Buffer.alloc(32, 7), proxy: {} } as unknown as UsercontentConfig;
    const cap = { messageId: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222', sessionId: '33333333-3333-4333-8333-333333333333', images: false };
    const now = new Date('2026-09-30T12:00:00Z');
    const dark = new URL(mintRenderUrl(config, cap, now, 'dark').url);
    expect(dark.searchParams.get('theme')).toBe('dark');
    expect(new URL(mintRenderUrl(config, cap, now).url).searchParams.get('theme')).toBe('light');
    const token = dark.pathname.split('/')[2] ?? '';
    expect(verifyToken(config.key, token, now.getTime())).toMatchObject(cap);
  });
});
