import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeDomain, organizationalDomain, PSL_VERSION, publicSuffix } from '../../src/index.js';

describe('organizationalDomain (PSL algorithm)', () => {
  it.each([
    ['example.com', 'example.com'],
    ['mail.example.com', 'example.com'],
    ['a.b.example.co.uk', 'example.co.uk'],
    ['EXAMPLE.CO.UK.', 'example.co.uk'],
    // Unlisted TLD: the implicit "*" rule.
    ['a.b.example.unlistedtld', 'example.unlistedtld'],
    // PRIVATE section: every github.io user is their own organization.
    ['foo.github.io', 'foo.github.io'],
    ['www.foo.github.io', 'foo.github.io'],
    // Wildcard *.ck and exception !www.ck.
    ['a.b.ck', 'a.b.ck'],
    ['x.a.b.ck', 'a.b.ck'],
    ['www.ck', 'www.ck'],
    ['mail.www.ck', 'www.ck'],
    // *.kawasaki.jp with !city.kawasaki.jp.
    ['a.b.kawasaki.jp', 'a.b.kawasaki.jp'],
    ['x.city.kawasaki.jp', 'city.kawasaki.jp'],
  ])('%s → %s', (domain, org) => {
    expect(organizationalDomain(domain)).toBe(org);
  });

  it('a public suffix is its own organizational domain', () => {
    expect(organizationalDomain('co.uk')).toBe('co.uk');
    expect(organizationalDomain('com')).toBe('com');
    expect(publicSuffix('co.uk')).toBe('co.uk');
  });

  it('handles IDN: U-labels and A-labels meet in the same form', () => {
    // 公司.cn is an ICANN rule; 食狮.公司.cn is therefore its own organization (PSL test data).
    expect(organizationalDomain('食狮.公司.cn')).toBe('xn--85x722f.xn--55qx5d.cn');
    expect(organizationalDomain('www.食狮.公司.cn')).toBe('xn--85x722f.xn--55qx5d.cn');
    expect(organizationalDomain('www.xn--85x722f.xn--55qx5d.cn')).toBe('xn--85x722f.xn--55qx5d.cn');
    expect(organizationalDomain('shishi.中国')).toBe('shishi.xn--fiqs8s');
  });

  it('icannOnly ignores the PRIVATE section', () => {
    expect(organizationalDomain('foo.github.io', { icannOnly: true })).toBe('github.io');
    expect(publicSuffix('foo.github.io')).toBe('github.io');
  });

  it('rejects unusable names', () => {
    expect(organizationalDomain('')).toBeUndefined();
    expect(organizationalDomain('a..example.com')).toBeUndefined();
    expect(normalizeDomain('.')).toBeUndefined();
  });

  it('the organizational domain is always a suffix of the domain (property)', () => {
    const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,8}[a-z0-9])?$/);
    const tail = fc.constantFrom('com', 'co.uk', 'github.io', 'ck', 'kawasaki.jp', 'zz', 'www.ck');
    fc.assert(
      fc.property(fc.array(label, { minLength: 0, maxLength: 4 }), tail, (labels, t) => {
        const domain = [...labels, t].join('.');
        const org = organizationalDomain(domain);
        expect(org).toBeDefined();
        expect(domain === org || domain.endsWith(`.${org ?? ''}`)).toBe(true);
        expect(organizationalDomain(org ?? '')).toBe(org);
      }),
    );
  });

  it('psl-data.ts is generated from the vendored list and up to date', () => {
    expect(PSL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}/);
    const out = execFileSync(process.execPath, [join(import.meta.dirname, '../../scripts/gen-psl.mjs'), '--check'], {
      encoding: 'utf8',
    });
    expect(out).toContain('up to date');
  });
});
