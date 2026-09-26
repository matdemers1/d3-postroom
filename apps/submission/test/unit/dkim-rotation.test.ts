// PST-T-7.4 (PST-REQ-125): the pure rules of DKIM rotation — when a successor is due, when the old
// key may be retired, and what counts as "the new TXT is visible in DNS".
import { dnsRecordFor, generateDkimKeys } from '@postroom/auth-checks';
import { describe, expect, it } from 'vitest';
import { datedSelector } from '../../src/dkim.js';
import { addUtcMonths, checkPublished, OVERLAP_DAYS, retireAfterFor, rotationDueAt, txtMatches } from '../../src/dkim-rotation.js';

const keys = generateDkimKeys();
const ED = dnsRecordFor('ed25519-sha256', keys.ed25519.publicKey);
const RSA = dnsRecordFor('rsa-sha256', keys.rsa.publicKey);
const OTHER_ED = dnsRecordFor('ed25519-sha256', generateDkimKeys().ed25519.publicKey);

describe('dkim rotation rules (PST-T-7.4)', () => {
  it('a successor is due one quarter after the key started signing, clamped to month ends', () => {
    expect(rotationDueAt(new Date('2026-01-05T10:00:00Z')).toISOString()).toBe('2026-04-05T10:00:00.000Z');
    expect(rotationDueAt(new Date('2026-11-30T00:00:00Z')).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    expect(addUtcMonths(new Date('2028-01-31T12:00:00Z'), 1).toISOString()).toBe('2028-02-29T12:00:00.000Z');
  });

  it('the old key is retired no earlier than 7 days after the switch', () => {
    const at = new Date('2026-04-06T03:00:00Z');
    expect(OVERLAP_DAYS).toBe(7);
    expect(retireAfterFor(at).getTime() - at.getTime()).toBe(7 * 86_400_000);
  });

  it('dated selectors never reuse one already on the domain', () => {
    const now = new Date('2026-10-02T00:00:00Z');
    expect(datedSelector(now, 'ed25519-sha256', new Set())).toBe('pr202610e');
    expect(datedSelector(now, 'rsa-sha256', new Set(['pr202610e']))).toBe('pr202610r');
    expect(datedSelector(now, 'ed25519-sha256', new Set(['pr202610e', 'pr202610e2']))).toBe('pr202610e3');
  });

  it('a TXT matches only with the same k= and p=, ignoring whitespace and string splits', () => {
    expect(txtMatches([ED], ED)).toBe(true);
    expect(txtMatches([RSA.replace('p=', 'p= ').replace(/(.{40})/g, '$1 ')], RSA)).toBe(true);
    expect(txtMatches(['v=spf1 -all', ED], ED)).toBe(true);
    expect(txtMatches([OTHER_ED], ED)).toBe(false);
    expect(txtMatches(['v=DKIM1; k=ed25519; p='], ED)).toBe(false);
    expect(txtMatches([ED.replace('k=ed25519', 'k=rsa')], ED)).toBe(false);
    expect(txtMatches([], ED)).toBe(false);
  });

  it('a lookup failure, NXDOMAIN, SERVFAIL or the wrong key is never "visible"', async () => {
    const name = 'pr202610e._domainkey.d3cloud.io';
    expect(await checkPublished({ txt: () => Promise.resolve([ED]) }, name, ED)).toEqual({ visible: true });
    expect((await checkPublished({ txt: () => Promise.resolve([]) }, name, ED)).visible).toBe(false);
    expect((await checkPublished({ txt: () => Promise.resolve([OTHER_ED]) }, name, ED)).visible).toBe(false);
    expect((await checkPublished({ txt: () => Promise.reject(new Error('timeout')) }, name, ED)).visible).toBe(false);
    const answer = (rcode: number, text?: string) => ({
      rcode,
      ad: true,
      authority: [],
      answers: text === undefined ? [] : [{ name, type: 16, class: 1, ttl: 300, kind: 'TXT' as const, strings: [text.slice(0, 20), text.slice(20)], text }],
    });
    expect(await checkPublished({ txt: () => Promise.resolve(answer(0, ED)) }, name, ED)).toEqual({ visible: true });
    expect((await checkPublished({ txt: () => Promise.resolve(answer(3)) }, name, ED)).visible).toBe(false);
    expect((await checkPublished({ txt: () => Promise.resolve(answer(2, ED)) }, name, ED)).visible).toBe(false);
  });
});
