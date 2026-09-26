// PST-T-6.2, PST-REQ-116: known tracking-pixel hosts/paths classify as trackers with a reason;
// unrelated content images do not; tracking parameters are stripped from links and a known
// click-redirect wrapper is unwrapped to its real destination; fast-check properties hold
// `cleanLink` to never throwing, being idempotent, and never touching scheme/host/path of a link
// that is not a recognised wrapper.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyImage, cleanLink, PACKAGE } from '../../src/index.js';

describe('@postroom/trackers', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE).toBe('@postroom/trackers');
  });
});

describe('classifyImage: known ESP open-tracking pixels', () => {
  const trackers: [string, string, Record<string, string> | undefined][] = [
    ['Mailchimp open pixel', 'https://us1.list-manage.com/track/open.php?u=abc&id=123', undefined],
    ['SendGrid 1x1 pixel', 'https://ct.sendgrid.net/wf/open?upn=abc', { width: '1', height: '1' }],
    ['HubSpot tracker', 'https://track.hubspotemail.net/e2t/o/1', undefined],
    ['generic /open path on an unknown host', 'https://mail.example.net/open?x=1', undefined],
    ['generic o.gif on an unknown host', 'https://mail.example.net/o.gif?x=1', undefined],
    ['1x1 pixel by width/height attribute alone', 'https://cdn.example.com/spacer.gif', { width: '1', height: '1' }],
    ['1x1 pixel by style', 'https://cdn.example.com/spacer.gif', { style: 'width:1px;height:1px' }],
    ['hidden by display:none', 'https://cdn.example.com/pixel.png', { style: 'display:none' }],
    ['hidden by visibility:hidden', 'https://cdn.example.com/pixel.png', { style: 'visibility: hidden' }],
  ];
  for (const [name, src, attrs] of trackers) {
    it(`classifies as tracker: ${name}`, () => {
      const result = classifyImage(src, attrs);
      expect(result.kind).toBe('tracker');
      expect(result.reason).not.toBe('');
    });
  }

  it('classifies ordinary content images as content', () => {
    for (const src of ['https://cdn.example.com/photo.jpg', 'https://images.example.com/logo.png?size=200', '/relative/logo.png', 'cid:logo@x']) {
      const r = classifyImage(src, { width: '600', height: '400' });
      expect(r.kind).toBe('content');
      expect(r.reason).not.toBe('');
    }
  });

  it('never throws on garbage input', () => {
    fc.assert(
      fc.property(fc.string(), fc.dictionary(fc.string(), fc.string()), (src, attrs) => {
        classifyImage(src, attrs);
        return true;
      }),
      { numRuns: 1000 },
    );
  });
});

describe('cleanLink: tracking parameters and known redirect wrappers', () => {
  it('strips utm_* and other known tracking parameters, keeping the rest', () => {
    const r = cleanLink('https://example.com/page?utm_source=newsletter&utm_medium=email&fbclid=abc&id=42');
    expect(r.href).toBe('https://example.com/page?id=42');
    expect([...r.removedParams].sort()).toEqual(['fbclid', 'utm_medium', 'utm_source'].sort());
    expect(r.unwrapped).toBeUndefined();
  });

  it('leaves an ordinary link with no tracking parameters untouched', () => {
    const r = cleanLink('https://example.com/page?id=42');
    expect(r.href).toBe('https://example.com/page?id=42');
    expect(r.removedParams).toEqual([]);
  });

  it('unwraps a known click-redirect wrapper to its real target', () => {
    const r = cleanLink('https://ct.sendgrid.net/ls/click?u=https%3A%2F%2Fexample.com%2Freal%3Fid%3D1');
    expect(r.unwrapped).toBeDefined();
    expect(r.href).toBe('https://example.com/real?id=1');
  });

  it('does not unwrap a ?url= parameter on a host it does not recognise', () => {
    const r = cleanLink('https://unknown.example.net/redirect?url=https%3A%2F%2Fexample.com%2Freal');
    expect(r.unwrapped).toBeUndefined();
    expect(r.href).toBe('https://unknown.example.net/redirect?url=https%3A%2F%2Fexample.com%2Freal');
  });

  it('strips tracking parameters from the unwrapped destination too', () => {
    const inner = 'https://example.com/real?utm_source=x&id=1';
    const r = cleanLink(`https://ct.sendgrid.net/ls/click?u=${encodeURIComponent(inner)}`);
    expect(r.href).toBe('https://example.com/real?id=1');
    expect(r.removedParams).toContain('utm_source');
  });

  it('passes through non-http(s) schemes unchanged', () => {
    for (const href of ['mailto:x@example.com', 'cid:logo@x', '#top']) {
      expect(cleanLink(href)).toEqual({ href, removedParams: [] });
    }
  });

  it('never throws, whatever the input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (href) => {
        cleanLink(href);
        return true;
      }),
      { numRuns: 2000 },
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (href) => {
        const once = cleanLink(href).href;
        const twice = cleanLink(once).href;
        return twice === once;
      }),
      { numRuns: 2000 },
    );
  });

  const httpUrl = fc
    .tuple(
      fc.constantFrom('http', 'https'),
      fc.constantFrom('example.com', 'example.org', 'mail.example.net'),
      fc.constantFrom('/', '/page', '/a/b'),
      fc.dictionary(fc.constantFrom('id', 'ref', 'q', 'utm_source', 'x'), fc.string({ maxLength: 10 }), { maxKeys: 5 }),
    )
    .map(([scheme, host, path, query]) => {
      const u = new URL(`${scheme}://${host}${path}`);
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
      return u.href;
    });

  it('never changes scheme, host or path of a link that is not a recognised wrapper', () => {
    fc.assert(
      fc.property(httpUrl, (href) => {
        const before = new URL(href);
        const after = new URL(cleanLink(href).href);
        return after.protocol === before.protocol && after.host === before.host && after.pathname === before.pathname;
      }),
      { numRuns: 1000 },
    );
  });
});
