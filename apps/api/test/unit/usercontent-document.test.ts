// PST-T-14.8 (PST-REQ-155, PST-REQ-081; design audit RSP-03): the document a render is served as.
// A sender's fixed 600 px layout is fitted to a narrow FRAME by CSS alone — the rule sits in the
// served document's own <style>, scoped to the frame's viewport, and the render's CSP still allows
// inline style and no script at all. The served response itself is test/integration/usercontent.test.ts.
import { describe, expect, it } from 'vitest';
import { NARROW_FIT_STYLE, renderCsp, renderDocument, type UsercontentConfig } from '../../src/usercontent/index.js';

const config = {
  origin: 'https://usercontent.example',
  host: 'usercontent.example',
  webOrigin: 'https://mail.example',
  key: Buffer.alloc(32),
  proxy: {},
} as unknown as UsercontentConfig;

describe('the served render document', () => {
  const doc = renderDocument('<table width="600"><tr><td width="600">Hello</td></tr></table>', { designed: true, theme: 'light' });

  it('carries the narrow-frame fit rule in its own <style>, before the body', () => {
    const style = /<head>.*<style>(.*)<\/style>.*<\/head>/s.exec(doc)?.[1] ?? '';
    expect(style).toContain(NARROW_FIT_STYLE);
    expect(doc.indexOf(NARROW_FIT_STYLE)).toBeLessThan(doc.indexOf('<body>'));
  });

  it('scopes it to a frame under 600 px, caps every element and linearises layout tables', () => {
    expect(NARROW_FIT_STYLE.startsWith('@media (max-width:599px){')).toBe(true);
    expect(NARROW_FIT_STYLE).toContain('body *{max-width:100%!important');
    expect(NARROW_FIT_STYLE).toContain('table,tbody,tr,td,th{display:block;width:auto!important}');
  });

  it('is CSS only: no script, handler or url() — and the CSP allows inline style, no script', () => {
    expect(doc).not.toMatch(/<script|on\w+=|javascript:|url\(/i);
    const csp = renderCsp(config);
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
  });
});
