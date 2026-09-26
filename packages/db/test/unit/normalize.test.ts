import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAILBOXES,
  normalizeDomain,
  normalizeLocalPart,
  parseAddress,
  randomUidValidity,
  SpecialUse,
} from '../../src/index.js';

describe('address normalisation', () => {
  it('lowercases, trims and drops a trailing root dot from a domain', () => {
    expect(normalizeDomain('  D3Cloud.IO. ')).toBe('d3cloud.io');
  });

  it('converts an IDN to punycode', () => {
    expect(normalizeDomain('BÜCHER.example')).toBe('xn--bcher-kva.example');
  });

  it('rejects empty and invalid names', () => {
    expect(() => normalizeDomain('   ')).toThrow();
    expect(() => normalizeLocalPart('')).toThrow();
    expect(() => normalizeLocalPart('a@b')).toThrow();
    expect(() => parseAddress('nobody')).toThrow();
    expect(() => parseAddress('@d3cloud.io')).toThrow();
    expect(() => parseAddress('me@')).toThrow();
  });

  it('parses an address into normalised halves', () => {
    expect(parseAddress('Matt@D3Cloud.io')).toEqual({ localPart: 'matt', domain: 'd3cloud.io' });
  });

  it('is idempotent and always satisfies the lowercase CHECK', () => {
    // Hyphens are left out so no label spells an `xn--` A-label, and the TLD is alphabetic so the
    // name never parses as an IPv4 literal.
    const label = fc.stringMatching(/^[A-Za-z0-9]{1,20}$/);
    const tld = fc.stringMatching(/^[A-Za-z]{2,10}$/);
    fc.assert(
      fc.property(fc.array(label, { minLength: 1, maxLength: 3 }), tld, (labels, top) => {
        const once = normalizeDomain([...labels, top].join('.'));
        expect(once).toBe(once.toLowerCase());
        expect(normalizeDomain(once)).toBe(once);
      }),
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9._+-]{1,30}$/), (local) => {
        const once = normalizeLocalPart(local);
        expect(once).toBe(once.toLowerCase());
        expect(normalizeLocalPart(once)).toBe(once);
      }),
    );
  });
});

describe('mailbox defaults', () => {
  it('draws UIDVALIDITY from 1..2^31-1', () => {
    const calls: [number, number][] = [];
    const v = randomUidValidity((min, max) => {
      calls.push([min, max]);
      return min;
    });
    expect(v).toBe(1);
    expect(calls).toEqual([[1, 2 ** 31]]);
  });

  it('seeds the seven special mailboxes and the four bucket folders (PST-T-5.1)', () => {
    expect(DEFAULT_MAILBOXES.map((m) => m.name)).toEqual([
      'INBOX',
      'Sent',
      'Drafts',
      'Trash',
      'Junk',
      'Archive',
      'Rejects',
      'Newsletters',
      'Updates',
      'Receipts',
      'Notifications',
    ]);
    const special = DEFAULT_MAILBOXES.map((m) => m.specialUse).filter((u) => u !== null);
    expect(new Set(special).size).toBe(Object.keys(SpecialUse).length);
    expect(special).toHaveLength(Object.keys(SpecialUse).length);
  });
});
